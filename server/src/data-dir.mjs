// Where DOGS AI keeps everything it installs, downloads and makes: one folder per user, shared by every copy of
// DOGS AI on this computer (the desktop app, the dogs CLI, Castle's AI section, a checkout) and kept across
// versions, so models, history and chats are the same whichever of them is open.
//
//   Windows  %LOCALAPPDATA%\DOGS AI
//   macOS    ~/Library/Application Support/DOGS AI
//   Linux    $XDG_DATA_HOME/dogs-ai (~/.local/share/dogs-ai)
//
// DOGS_AI_DATA puts it anywhere else. Inside:
//   runtime/        ComfyUI and its Python, linked models, the database (history, chats, characters, prompts)
//   models/         models dropped in by hand
//   outputs/        everything generated, and uploads
//   settings.json   connections every copy uses (the Ollama address)
//   server.json     the engine that is running, so every app uses that one instead of starting another
//
// Copies from before kept runtime/, models/ and outputs/ inside their own folder. Those are moved here the first
// time a newer copy starts (a rename: instant on the same drive). A folder that cannot move yet, because the
// older copy is still running from it or it is on another drive, is used where it is and tried again next start.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const MOVABLE = ["runtime", "models", "outputs"];

export function defaultDataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "DOGS AI");
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "DOGS AI");
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, ".local", "share"), "dogs-ai");
}

/** A folder with something in it (a lone .gitkeep does not count). */
export function hasContent(dir) {
  try {
    return readdirSync(dir).some((name) => name !== ".gitkeep");
  } catch {
    return false;
  }
}

const fwd = (p) => p.replace(/\\/g, "/");

/** ComfyUI's extra_model_paths.yaml names folders by full path: point them at the runtime's new place. */
function repointYaml(runtime, from, to) {
  const yaml = path.join(runtime, "extra_model_paths.yaml");
  try {
    const text = readFileSync(yaml, "utf8");
    const moved = text.split(fwd(from)).join(fwd(to)).split(from).join(to);
    if (moved !== text) writeFileSync(yaml, moved);
  } catch {}
}

/** Every process as { pid, ppid, text } (its command line and program, lowercased). Null when it cannot tell. */
function processes() {
  try {
    if (process.platform === "win32") {
      const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath, $_.CommandLine }";
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20000 });
      return out.split(/\r?\n/).filter(Boolean).map((line) => {
        const [pid, ppid, ...rest] = line.split("|");
        return { pid: Number(pid), ppid: Number(ppid), text: rest.join("|").toLowerCase() };
      });
    }
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 20000 });
    return out.split("\n").filter(Boolean).map((line) => {
      const [, pid, ppid, text] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/) || [];
      return { pid: Number(pid), ppid: Number(ppid), text: String(text).toLowerCase() };
    });
  } catch {
    return null;
  }
}

/**
 * True when a program other than this one (and what started it) runs from an older copy's folders: its dogs
 * server, or the ComfyUI it started. Their files are open, so the folders must not move yet. Unsure counts as yes.
 */
export function inUse(copy, list = processes()) {
  if (!list) return true;
  const norm = (p) => (process.platform === "win32" ? p.replace(/\//g, "\\") : p).toLowerCase();
  const needles = ["server", ...MOVABLE].map((name) => norm(path.join(path.resolve(copy), name)));
  const mine = new Set();
  for (let pid = process.pid, guard = 0; pid && guard < 64; guard++) {
    mine.add(pid);
    pid = list.find((p) => p.pid === pid)?.ppid;
  }
  return list.some((p) => !mine.has(p.pid) && needles.some((n) => p.text.includes(n)));
}

/**
 * Moves an older copy's runtime/, models/ and outputs/ into the shared folder, each one that has something in it
 * while the shared one does not. Returns where each of the three is to be used from now, and what happened.
 */
export function settle(shared, legacy) {
  const places = Object.fromEntries(MOVABLE.map((name) => [name, path.join(shared, name)]));
  const notes = [];
  let list;
  for (const from of legacy) {
    const waiting = MOVABLE.filter((name) => path.resolve(from, name) !== path.resolve(shared, name) && hasContent(path.join(from, name)) && !hasContent(path.join(shared, name)));
    if (!waiting.length) continue;
    list ??= processes();
    if (inUse(from, list)) {
      for (const name of waiting) places[name] = path.join(from, name);
      notes.push(`using ${from} where it is for now: an older DOGS AI is running from it`);
      continue;
    }
    for (const name of MOVABLE) {
      const src = path.join(from, name);
      const dst = places[name];
      if (path.resolve(src) === path.resolve(dst) || !hasContent(src)) continue;
      if (hasContent(dst)) {
        if (dst === path.join(shared, name)) notes.push(`kept ${src}: ${dst} already has one`);
        continue;
      }
      try {
        mkdirSync(shared, { recursive: true });
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true }); // empty, or a lone .gitkeep
        renameSync(src, dst);
        if (name === "runtime") repointYaml(dst, src, dst);
        notes.push(`moved ${src} -> ${dst}`);
      } catch (e) {
        // In use (an older copy still runs from it) or on another drive: use it where it is for now.
        places[name] = src;
        notes.push(`using ${src} where it is for now (${e.code || e.message})`);
      }
    }
  }
  return { places, notes };
}
