// Paths and settings shared by the CLI and the API server. Everything comes from stack.json plus env overrides.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { defaultDataDir, settle } from "./data-dir.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const STACK = JSON.parse(readFileSync(path.join(REPO, "stack.json"), "utf8"));

const env = process.env;
export const IS_WIN = process.platform === "win32";

// One data folder per user, shared by every copy of DOGS AI on this computer (see data-dir.mjs). An older copy's
// folders (this checkout's own, and any in DOGS_AI_LEGACY, which Castle sets) move there the first time.
export const DATA = path.resolve(env.DOGS_AI_DATA || defaultDataDir());
const LEGACY = [REPO, ...(env.DOGS_AI_LEGACY || "").split(path.delimiter).filter(Boolean)];
const settled = settle(DATA, LEGACY);
export const DATA_NOTES = settled.notes;
for (const note of DATA_NOTES) process.stderr.write(`[dogs] data: ${note}\n`);

export const RUNTIME = settled.places.runtime;
export const COMFY_DIR = path.join(RUNTIME, "ComfyUI");
export const MODELS_DIR = path.resolve(env.DOGS_MODELS || settled.places.models);
// Hard links to every scanned model file, grouped by ComfyUI folder. ComfyUI reads it via extra_model_paths.yaml.
export const LINKED_DIR = path.join(RUNTIME, "models", "linked");
export const EXTRA_PATHS_YAML = path.join(RUNTIME, "extra_model_paths.yaml");
export const OUTPUTS = path.resolve(env.DOGS_AI_OUTPUTS || settled.places.outputs);
// Every generated file lands in outputs/generated/<kind>/; outputs/ also holds uploads (inputs/, characters/).
export const GENERATED = "generated";
// ComfyUI workflows (API format) for models without a built-in one.
export const WORKFLOWS_DIR = settled.places.workflows;
export const COMFY_URL = (env.COMFY_URL || `http://127.0.0.1:${STACK.comfyui.port}`).replace(/\/$/, "");
export const VRAM_HANDOFF = env.VRAM_HANDOFF !== "0";

// ---- Connections every copy shares (DATA/settings.json) ----
// The Ollama address. DOGS_AI_OLLAMA sets it for every copy from now on (Castle passes the one its box uses), so
// the desktop app and the CLI talk to the same Ollama, with the same models, when they start on their own. It can
// also be changed through POST /api/connections. OLLAMA_URL overrides it for one process only, as before.
const SETTINGS_FILE = path.join(DATA, "settings.json");
export function readSettings() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) || {}; } catch { return {}; }
}
export function writeSettings(changes) {
  const next = { ...readSettings(), ...changes };
  mkdirSync(DATA, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}
const clean = (url) => String(url).trim().replace(/\/$/, "");
if (env.DOGS_AI_OLLAMA && clean(env.DOGS_AI_OLLAMA) !== readSettings().ollamaUrl) {
  try { writeSettings({ ollamaUrl: clean(env.DOGS_AI_OLLAMA) }); } catch {}
}
export let OLLAMA_URL = clean(env.OLLAMA_URL || readSettings().ollamaUrl || STACK.ollama.host);
/** Changes the Ollama address for this engine and every copy after it. */
export function setOllamaUrl(url) {
  OLLAMA_URL = clean(url || STACK.ollama.host);
  writeSettings({ ollamaUrl: OLLAMA_URL });
  return OLLAMA_URL;
}

export const API_HOST = env.DOGS_HOST || "127.0.0.1";
// Not 8787: that is Castle's own box. stack.json's api.port is the default.
export const API_PORT = Number(env.DOGS_PORT || STACK.api?.port || 8788);

// ---- The engine that is running (DATA/server.json) ----
// Written when an engine starts listening and removed when it stops, so the desktop app, the CLI and Castle all
// use the one that is running instead of starting another. A stale file (an engine that was killed) is told
// apart by asking the address in it.
const SERVER_FILE = path.join(DATA, "server.json");
export function readServer() {
  try { return JSON.parse(readFileSync(SERVER_FILE, "utf8")); } catch { return null; }
}
// An engine that takes a key records it too, so the other copies on this computer can use that engine: the folder
// belongs to this user alone (and the file is made private to them where the system has file modes).
export function recordServer(info) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(SERVER_FILE, JSON.stringify({ ...info, pid: process.pid, started: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(SERVER_FILE, 0o600); } catch {}
}
export function forgetServer() {
  if (readServer()?.pid === process.pid) rmSync(SERVER_FILE, { force: true });
}
// Required as "Authorization: Bearer <key>" when set. Always set one before binding to anything but localhost.
export const API_KEY = env.DOGS_API_KEY || "";
/** The key a client on this computer sends: DOGS_API_KEY, else the one the running engine recorded. */
export function serverKey() {
  return API_KEY || readServer()?.key || "";
}

// Every Hugging Face hub cache on this machine: env overrides, then each user profile (models can be
// downloaded as any user, including an admin account).
export function hubRoots() {
  const roots = new Set();
  if (env.HF_HUB_CACHE) roots.add(env.HF_HUB_CACHE);
  if (env.HF_HOME) roots.add(path.join(env.HF_HOME, "hub"));
  roots.add(path.join(os.homedir(), ".cache", "huggingface", "hub"));
  const homes = IS_WIN
    ? [path.join(path.parse(os.homedir()).root, "Users")]
    : ["/home", "/Users"];
  for (const base of homes) {
    for (const n of readdirSafe(base)) roots.add(path.join(base, n, ".cache", "huggingface", "hub"));
  }
  if (!IS_WIN) roots.add("/root/.cache/huggingface/hub");
  return [...roots].map((r) => path.resolve(r));
}

const NOT_PROFILES = new Set(["Default", "Default User", "All Users"]);
function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !NOT_PROFILES.has(e.name))
      .map((e) => e.name);
  } catch { return []; }
}
