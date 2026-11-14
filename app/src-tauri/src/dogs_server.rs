// Runs the local dogs engine (server/bin/dogs.mjs serve) for the desktop app, so nobody has to start a server:
// it starts when the app opens and is restarted if it ever stops. It runs on the Node that ships in the dogs
// CLI archive (<home>/node/), else the Node on PATH.
//
// One engine serves every copy of DOGS AI on this computer: one that is already running (started by Castle, the
// CLI or another window) is used as it is. It is found through server.json in the shared data folder, which the
// engine writes while it listens; the engines all use that folder, so models, history and chats are the same.
use std::{
    env,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

/// Not 8787: that is Castle's box. Taken by something else, the next free port up to 8799 is used.
const DEFAULT_PORT: u16 = 8788;
const PORTS_TRIED: u16 = 12;
const HEALTH_TIMEOUT: Duration = Duration::from_millis(1500);
const START_TIMEOUT: Duration = Duration::from_secs(20);
const START_POLL: Duration = Duration::from_millis(300);
const WATCH: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct Engine {
    child: Arc<Mutex<Option<Child>>>,
    stopped: Arc<AtomicBool>,
    /// Where the engine listens: the running one's port, else one picked when the app opened.
    port: u16,
    /// The running engine's key, when it takes one (Castle's, served to the network): empty otherwise.
    key: String,
}

impl Default for Engine {
    fn default() -> Self {
        let (port, key) = pick_port();
        Self { child: Arc::default(), stopped: Arc::default(), port, key }
    }
}

impl Engine {
    /// The address the window talks to.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The key the window sends that engine; empty when it takes none.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Start the engine if needed, then keep it running for as long as the app is open.
    pub fn spawn(&self) {
        let engine = self.clone();
        thread::spawn(move || {
            while !engine.stopped.load(Ordering::SeqCst) {
                if !up(engine.port, &key_for(engine.port)) {
                    engine.start();
                }
                thread::sleep(WATCH);
            }
        });
    }

    /// Stop watching, and stop the engine if this app started it.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn start(&self) {
        let Some(home) = dogs_home() else {
            eprintln!("[dogs] project folder not found; set DOGS_HOME or start `dogs serve` yourself");
            return;
        };
        let mut cmd = Command::new(node(&home));
        cmd.arg(home.join("server").join("bin").join("dogs.mjs"))
            .arg("serve")
            .current_dir(&home)
            .env("DOGS_PORT", self.port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        // Windows can refuse a spawn (low memory, security software): log it and let the watcher try again.
        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                eprintln!("[dogs] could not start the engine, retrying: {e}");
                return;
            }
        };
        #[cfg(windows)]
        kill_with_app::tie(&child);
        *self.child.lock().unwrap() = Some(child);

        let t0 = Instant::now();
        while t0.elapsed() < START_TIMEOUT && !self.stopped.load(Ordering::SeqCst) && !up(self.port, "") {
            // It exited (port taken, bad Node): stop waiting, the watcher retries.
            let exited = match self.child.lock().unwrap().as_mut() {
                Some(child) => !matches!(child.try_wait(), Ok(None)),
                None => true,
            };
            if exited {
                self.child.lock().unwrap().take();
                return;
            }
            thread::sleep(START_POLL);
        }
    }
}

/// The data folder every copy of DOGS AI shares (server/src/data-dir.mjs says the same): DOGS_AI_DATA, else
/// %LOCALAPPDATA%\DOGS AI, ~/Library/Application Support/DOGS AI or $XDG_DATA_HOME/dogs-ai.
fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = env::var_os("DOGS_AI_DATA").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if cfg!(windows) {
        return env::var_os("LOCALAPPDATA").map(PathBuf::from).or_else(|| home.map(|h| h.join("AppData").join("Local"))).map(|d| d.join("DOGS AI"));
    }
    if cfg!(target_os = "macos") {
        return home.map(|h| h.join("Library").join("Application Support").join("DOGS AI"));
    }
    env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| home.map(|h| h.join(".local").join("share"))).map(|d| d.join("dogs-ai"))
}

/// The engine recorded in server.json in the data folder: its port, and its key (empty when it takes none).
fn recorded() -> Option<(u16, String)> {
    let text = std::fs::read_to_string(data_dir()?.join("server.json")).ok()?;
    let info: serde_json::Value = serde_json::from_str(&text).ok()?;
    let port = u16::try_from(info.get("port")?.as_u64()?).ok()?;
    let key = info.get("key").and_then(|k| k.as_str()).unwrap_or_default().to_string();
    Some((port, key))
}

/// The key of the engine on `port`, when that is the recorded one.
fn key_for(port: u16) -> String {
    recorded().filter(|(p, _)| *p == port).map(|(_, key)| key).unwrap_or_default()
}

/// The running engine's port and key; else DOGS_PORT; else the first free port from DEFAULT_PORT.
fn pick_port() -> (u16, String) {
    if let Some(found) = recorded().filter(|(port, key)| up(*port, key)) {
        return found;
    }
    if let Some(port) = env::var("DOGS_PORT").ok().and_then(|p| p.parse().ok()) {
        return (port, String::new());
    }
    let port = (DEFAULT_PORT..DEFAULT_PORT + PORTS_TRIED)
        .find(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .unwrap_or(DEFAULT_PORT);
    (port, String::new())
}

/// GET /api/health answers 2xx (sent with the engine's key, when it takes one). Plain HTTP over a socket: one
/// request does not need an HTTP client.
fn up(port: u16, key: &str) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, HEALTH_TIMEOUT) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(HEALTH_TIMEOUT));
    let _ = s.set_write_timeout(Some(HEALTH_TIMEOUT));
    let auth = if key.is_empty() { String::new() } else { format!("Authorization: Bearer {key}\r\n") };
    let req = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Connection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    // "HTTP/1.1 200" is 12 bytes.
    let mut head = Vec::with_capacity(16);
    let mut buf = [0u8; 16];
    while head.len() < 12 {
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    head.len() >= 12 && head.starts_with(b"HTTP/1.") && head[9] == b'2'
}

fn has_dogs(dir: &Path) -> bool {
    dir.join("server").join("bin").join("dogs.mjs").is_file()
}

fn dogs_home() -> Option<PathBuf> {
    let user_home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    [
        env::var_os("DOGS_HOME").map(PathBuf::from),
        // Recorded by build.rs; release (CI) builds record nothing.
        option_env!("DOGS_BUILD_HOME").map(PathBuf::from),
        // Release builds expect the dogs CLI archive (or a clone) extracted to ~/dogs-ai.
        user_home.map(|h| h.join("dogs-ai")),
    ]
    .into_iter()
    .flatten()
    .find(|d| has_dogs(d))
}

/// The CLI archive's bundled Node, else Node from PATH. Apps opened from the macOS Finder get a bare PATH, so
/// the usual Homebrew / installer locations are tried too.
fn node(home: &Path) -> PathBuf {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = home.join("node").join(exe);
    if bundled.is_file() {
        return bundled;
    }
    let on_path = env::var_os("PATH")
        .map(|p| env::split_paths(&p).map(|d| d.join(exe)).collect::<Vec<_>>())
        .unwrap_or_default();
    let usual = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].map(PathBuf::from);
    on_path
        .into_iter()
        .chain(if cfg!(windows) { vec![] } else { usual.to_vec() })
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(exe))
}

/// Windows does not end a process's children with it, and `stop` only runs on a clean exit. A killed or crashed app
/// (or `tauri dev` restarting it) would leave the engine running old code, and the next app would reuse it. A job
/// object closes when the app's process ends, however it ends, and takes the engine with it. Silent breakaway keeps
/// what the engine starts in turn (ComfyUI) out of the job, so ComfyUI outlives the app as before.
#[cfg(windows)]
mod kill_with_app {
    use std::{os::windows::io::AsRawHandle, process::Child, sync::OnceLock};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };

    // The handle as usize (raw handles are not Send). Never closed: closing it is what kills the engine.
    static JOB: OnceLock<usize> = OnceLock::new();

    pub fn tie(child: &Child) {
        let job = *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            let size = std::mem::size_of_val(&info) as u32;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, size);
            job as usize
        });
        if job != 0 {
            unsafe { AssignProcessToJobObject(job as _, child.as_raw_handle() as _) };
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    /// An engine that takes a key is found through server.json, and asked with that key.
    #[test]
    fn a_keyed_engine_is_found_and_asked_with_its_key() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let (mut line, mut keyed) = (String::new(), false);
                while reader.read_line(&mut line).is_ok_and(|n| n > 2) {
                    keyed |= line.trim().eq_ignore_ascii_case("authorization: bearer k123");
                    line.clear();
                }
                let status = if keyed { "200 OK" } else { "401 Unauthorized" };
                let _ = write!(&stream, "HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n");
            }
        });
        let dir = env::temp_dir().join(format!("dogs-app-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("server.json"), format!("{{\"url\":\"http://127.0.0.1:{port}\",\"port\":{port},\"keyed\":true,\"key\":\"k123\"}}")).unwrap();
        env::set_var("DOGS_AI_DATA", &dir);
        assert_eq!(recorded(), Some((port, "k123".to_string())));
        assert_eq!(key_for(port), "k123");
        assert_eq!(key_for(port.wrapping_add(1)), "", "another port's engine is not given the key");
        assert!(!up(port, ""), "without the key it refuses");
        assert!(up(port, "k123"));
        assert_eq!(pick_port(), (port, "k123".to_string()));
        env::remove_var("DOGS_AI_DATA");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
