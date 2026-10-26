/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
// Desktop dev mode (npm run desktop:dev): the Vite dev server serves the web app, so Svelte edits hot-reload in
// the window; edits to the Electron main process (src/) rebuild it and restart Electron.
const cp = require('child_process');
const path = require('path');
const chokidar = require('chokidar');
const electron = require('electron');

const DEV_PORT = 5173;
const DEV_URL = `http://127.0.0.1:${DEV_PORT}/`;
const VITE_START_TIMEOUT_MS = 30_000;

let child = null;
let vite = null;
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const reloadWatcher = {
  debouncer: null,
  ready: false,
  watcher: null,
  restarting: false,
};

function runBuild() {
  return new Promise((resolve, _reject) => {
    // Node refuses to spawn .cmd files without a shell on Windows.
    let tempChild = cp.spawn(npmCmd, ['run', 'build'], { shell: process.platform === 'win32' });
    tempChild.once('exit', () => {
      resolve();
    });
    tempChild.stdout.pipe(process.stdout);
  });
}

async function startVite() {
  const app = path.resolve(__dirname, '..');
  vite = cp.spawn(process.execPath, [path.join(app, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(DEV_PORT), '--strictPort'], {
    cwd: app,
    stdio: 'inherit',
  });
  vite.on('exit', () => (vite = null));
  const t0 = Date.now();
  while (Date.now() - t0 < VITE_START_TIMEOUT_MS) {
    if (!vite) throw new Error('vite exited; is port ' + DEV_PORT + ' already in use?');
    try {
      if ((await fetch(DEV_URL)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('vite did not start within ' + VITE_START_TIMEOUT_MS / 1000 + ' s');
}

function shutdown(code = 0) {
  vite?.kill();
  child?.kill();
  process.exit(code);
}

async function spawnElectron() {
  if (child !== null) {
    child.stdin.pause();
    child.kill();
    child = null;
    await runBuild();
  }
  child = cp.spawn(electron, ['--inspect=5858', './'], { env: { ...process.env, DOGS_DEV_URL: DEV_URL } });
  child.on('exit', () => {
    if (!reloadWatcher.restarting) {
      shutdown(0);
    }
  });
  child.stdout.pipe(process.stdout);
}

function setupReloadWatcher() {
  reloadWatcher.watcher = chokidar
    .watch('./src/**/*', {
      ignored: /[/\\]\./,
      persistent: true,
    })
    .on('ready', () => {
      reloadWatcher.ready = true;
    })
    .on('all', (_event, _path) => {
      if (reloadWatcher.ready) {
        clearTimeout(reloadWatcher.debouncer);
        reloadWatcher.debouncer = setTimeout(async () => {
          console.log('Restarting');
          reloadWatcher.restarting = true;
          await spawnElectron();
          reloadWatcher.restarting = false;
          reloadWatcher.ready = false;
          clearTimeout(reloadWatcher.debouncer);
          reloadWatcher.debouncer = null;
          reloadWatcher.watcher = null;
          setupReloadWatcher();
        }, 500);
      }
    });
}

process.on('SIGINT', () => shutdown(0));

(async () => {
  try {
    await Promise.all([runBuild(), startVite()]);
  } catch (e) {
    console.error('[desktop:dev]', e.message);
    shutdown(1);
  }
  await spawnElectron();
  setupReloadWatcher();
})();
