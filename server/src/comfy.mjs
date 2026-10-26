// Thin ComfyUI client: start/stop the local server, queue an API-format graph, stream progress over the
// websocket, and collect output files (images, video, audio) into outputs/.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { COMFY_URL, COMFY_DIR, OLLAMA_URL, OUTPUTS, REPO, RUNTIME, STACK, EXTRA_PATHS_YAML, VRAM_HANDOFF, IS_WIN } from "./config.mjs";

const CLIENT_ID = randomUUID();
const log = (...a) => console.error("[comfy]", ...a);

export async function comfy(pathname, init) {
  const res = await fetch(COMFY_URL + pathname, init);
  if (!res.ok) throw new Error(`ComfyUI ${pathname} -> HTTP ${res.status}: ${(await res.text()).slice(0, 2000)}`);
  return res;
}
const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export async function comfyUp() {
  try { await comfy("/system_stats", { signal: AbortSignal.timeout(3000) }); return true; } catch { return false; }
}

export async function comfyStats() {
  const s = await (await comfy("/system_stats")).json();
  const gb = (b) => Math.round((b / 2 ** 30) * 10) / 10;
  const q = await (await comfy("/queue")).json();
  return {
    version: s.system.comfyui_version, ram_free_gb: gb(s.system.ram_free),
    gpus: s.devices.map((d) => ({ name: d.name, vram_total_gb: gb(d.vram_total), vram_free_gb: gb(d.vram_free) })),
    queue: { running: q.queue_running.length, pending: q.queue_pending.length },
  };
}

let starting = null;
export async function startComfy() {
  if (await comfyUp()) return;
  if (!starting) {
    starting = new Promise((resolve, reject) => {
      let p;
      if (IS_WIN) {
        p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(REPO, "scripts", "start-comfyui.ps1")],
          { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      } else {
        // Raspberry Pi / Linux: run the venv's python directly, detached, logging to runtime/comfyui.log.
        const py = path.join(COMFY_DIR, ".venv", "bin", "python");
        p = spawn("sh", ["-c", `"${py}" main.py ${STACK.comfyui.args.join(" ")} --output-directory "${OUTPUTS}" ` +
          `--extra-model-paths-config "${EXTRA_PATHS_YAML}" > "${RUNTIME}/comfyui.log" 2>&1 & echo $! > "${RUNTIME}/comfyui.pid"`],
          { cwd: COMFY_DIR, stdio: ["ignore", "ignore", "pipe"] });
      }
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`starting ComfyUI failed (exit ${code}): ${err.trim()}`))));
    }).finally(() => (starting = null));
  }
  await starting;
  for (let i = 0; i < 180 && !(await comfyUp()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await comfyUp())) throw new Error(`ComfyUI still not reachable at ${COMFY_URL}`);
}

export async function stopComfy() {
  let pid;
  try { pid = Number((await fs.readFile(path.join(RUNTIME, "comfyui.pid"), "utf8")).trim()); } catch { return false; }
  try { process.kill(pid); } catch { return false; }
  for (let i = 0; i < 20 && (await comfyUp()); i++) await new Promise((r) => setTimeout(r, 500));
  return true;
}

export async function freeComfy() {
  await comfy("/free", json({ unload_models: true, free_memory: true }));
}

// The LLM (Ollama) and diffusion models rarely fit in VRAM together: unload the LLM before sampling.
export async function unloadLlm() {
  if (!VRAM_HANDOFF) return;
  try {
    const { models = [] } = await (await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(3000) })).json();
    for (const m of models) await fetch(`${OLLAMA_URL}/api/generate`, { ...json({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(15000) });
  } catch {}
}

export async function nodeTypes() {
  return new Set(Object.keys(await (await comfy("/object_info")).json()));
}

export async function uploadImage(buf, name) {
  const form = new FormData();
  form.append("image", new Blob([buf]), `dogs_${Date.now()}_${name}`);
  form.append("overwrite", "true");
  const { name: n, subfolder } = await (await comfy("/upload/image", { method: "POST", body: form })).json();
  return subfolder ? `${subfolder}/${n}` : n;
}

// ---- websocket progress, shared by all jobs
const listeners = new Map(); // prompt_id -> fn(msg)
let ws = null;
function ensureSocket() {
  if (ws && ws.readyState <= 1) return;
  try {
    ws = new WebSocket(`${COMFY_URL.replace(/^http/, "ws")}/ws?clientId=${CLIENT_ID}`);
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // binary preview frames
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      const id = msg.data?.prompt_id;
      if (id && listeners.has(id)) listeners.get(id)(msg);
    };
    ws.onerror = () => {};
  } catch (e) { log("websocket unavailable:", e.message); }
}

export async function interrupt(promptId) {
  await comfy("/interrupt", json(promptId ? { prompt_id: promptId } : {})).catch(() => {});
  if (promptId) await comfy("/queue", json({ delete: [promptId] })).catch(() => {});
}

/**
 * Queue a graph and wait for it. onProgress({ value, max, node }) is called as sampling advances.
 * Returns the list of output file records ({ filename, subfolder, type }) from every output node.
 */
export async function runGraph(graph, { onProgress = () => {}, onQueued = () => {}, timeoutMs = 60 * 60 * 1000 } = {}) {
  ensureSocket();
  const res = await fetch(COMFY_URL + "/prompt", json({ prompt: graph, client_id: CLIENT_ID }));
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const errs = Object.values(body.node_errors || {}).flatMap((n) => n.errors.map((e) => `${n.class_type}: ${e.message} ${e.details || ""}`.trim()));
    throw new Error(`ComfyUI rejected the workflow: ${body.error?.message || res.status}${errs.length ? " | " + errs.join(" | ") : ""}`);
  }
  const { prompt_id } = body;
  onQueued(prompt_id);
  let done = false;
  listeners.set(prompt_id, (msg) => {
    if (msg.type === "progress") onProgress({ value: msg.data.value, max: msg.data.max, node: msg.data.node });
    else if (msg.type === "executing" && msg.data.node) onProgress({ node: msg.data.node });
    else if (msg.type === "execution_success" || msg.type === "execution_error") done = true;
  });
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, done ? 50 : 1000));
      const h = (await (await comfy(`/history/${prompt_id}`)).json())[prompt_id];
      if (!h) continue;
      if (h.status?.status_str === "error") {
        const m = (h.status.messages || []).find(([t]) => t === "execution_error")?.[1];
        throw new Error("ComfyUI execution error: " + (m ? `${m.node_type}: ${m.exception_message}`.trim() : JSON.stringify(h.status)));
      }
      if (h.status?.completed) {
        return Object.values(h.outputs).flatMap((o) => Object.values(o).flat().filter((x) => x && typeof x === "object" && x.filename));
      }
    }
    throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ComfyUI`);
  } finally {
    listeners.delete(prompt_id);
  }
}

/** Make sure each output file exists under outputs/ (ComfyUI started by us writes there already). */
export async function collectOutputs(items) {
  const files = [];
  for (const it of items) {
    if (it.type && it.type !== "output") continue;
    const rel = path.join(it.subfolder || "", it.filename);
    const dest = path.join(OUTPUTS, rel);
    try { await fs.access(dest); } catch {
      const q = new URLSearchParams({ filename: it.filename, subfolder: it.subfolder || "", type: it.type || "output" });
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from(await (await comfy(`/view?${q}`)).arrayBuffer()));
    }
    files.push(rel.replace(/\\/g, "/"));
  }
  return files;
}
