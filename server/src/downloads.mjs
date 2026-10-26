// Model downloads through the Hugging Face CLI into the normal hub cache (~/.cache/huggingface/hub), where the
// scanner picks them up. Also installs the few ComfyUI custom nodes some model formats need.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { FAMILIES } from "./families.mjs";
import { COMFY_DIR, IS_WIN } from "./config.mjs";

export const events = new EventEmitter();
const downloads = new Map();

// On Windows `hf` is usually an hf.cmd shim, which only runs through a shell.
function hfCommand() {
  const probe = spawnSync("hf", ["version"], { stdio: "ignore", shell: IS_WIN });
  if (probe.status === 0) return ["hf"];
  return ["uvx", "--from", "huggingface_hub", "hf"];
}

/** Resolve a download target: a family id, or a raw repo with optional file list. */
export function planDownload(target, files = [], roles = null) {
  const fam = FAMILIES.find((f) => f.id === target);
  if (fam) {
    const byRepo = new Map();
    for (const it of fam.download.items) {
      if (roles && !roles.includes(it.role)) continue;
      byRepo.set(it.repo, [...(byRepo.get(it.repo) || []), it.file]);
    }
    return { label: fam.label, gated: fam.download.gated, steps: [...byRepo].map(([repo, fl]) => ({ repo, files: fl })) };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(target)) return { label: target, steps: [{ repo: target, files }] };
  const e = new Error(`"${target}" is neither a model family (${FAMILIES.map((f) => f.id).join(", ")}) nor an org/repo id`);
  e.status = 400;
  throw e;
}

export function listDownloads() { return [...downloads.values()].reverse(); }
export function getDownload(id) { return downloads.get(id) || null; }

/** Start a download in the background. onLine gets every output line (used by the CLI to stream). */
export function startDownload(target, files = [], { onLine, roles = null } = {}) {
  const plan = planDownload(target, files, roles);
  if (!plan.steps.length) throw Object.assign(new Error(`${plan.label}: nothing to download, every file is already installed`), { status: 400 });
  const dl = { id: randomUUID().slice(0, 8), target, label: plan.label, status: "running", log: [], started: Date.now(), finished: null, error: null };
  downloads.set(dl.id, dl);
  const push = (line) => {
    line = line.replace(/\r/g, "").trimEnd();
    if (!line) return;
    dl.log.push(line);
    if (dl.log.length > 200) dl.log.splice(0, dl.log.length - 200);
    onLine?.(line);
    events.emit("download", dl);
  };
  const hf = hfCommand();
  dl.done = (async () => {
    for (const step of plan.steps) {
      push(`> hf download ${step.repo} ${step.files.join(" ")}`);
      const code = await new Promise((resolve) => {
        const p = spawn(hf[0], [...hf.slice(1), "download", step.repo, ...step.files], { windowsHide: true, shell: IS_WIN && hf[0] === "hf", env: { ...process.env, HF_HUB_DISABLE_SYMLINKS_WARNING: "1" } });
        const feed = (d) => String(d).split(/\n|\r(?!\n)/).forEach(push);
        p.stdout.on("data", feed);
        p.stderr.on("data", feed);
        p.on("error", (e) => { push(`failed to run ${hf[0]}: ${e.message}`); resolve(-1); });
        p.on("exit", resolve);
      });
      if (code !== 0) {
        const gatedHint = dl.log.some((l) => /401|403|gated|restricted|access/i.test(l))
          ? ` This repo is gated or needs a login: accept the license at https://huggingface.co/${step.repo} and run \`hf auth login\` (or set HF_TOKEN).`
          : "";
        Object.assign(dl, { status: "error", error: `hf download ${step.repo} failed (exit ${code}).${gatedHint}`, finished: Date.now() });
        events.emit("download", dl);
        return dl;
      }
    }
    Object.assign(dl, { status: "done", finished: Date.now() });
    events.emit("download", dl);
    return dl;
  })();
  return dl;
}

export const CUSTOM_NODES = {
  gguf: { repo: "https://github.com/city96/ComfyUI-GGUF.git", dir: "ComfyUI-GGUF", pip: ["gguf"], why: "load .gguf quantized diffusion models" },
};

/** git clone a custom node into ComfyUI and install its Python deps into ComfyUI's venv. */
export function addNode(name, onLine = console.log) {
  const n = CUSTOM_NODES[name];
  if (!n) throw new Error(`unknown node pack "${name}" (known: ${Object.keys(CUSTOM_NODES).join(", ")})`);
  const dest = path.join(COMFY_DIR, "custom_nodes", n.dir);
  const py = path.join(COMFY_DIR, ".venv", IS_WIN ? "Scripts/python.exe" : "bin/python");
  const run = (cmd, args) => {
    onLine(`> ${cmd} ${args.join(" ")}`);
    const r = spawnSync(cmd, args, { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`${cmd} failed (exit ${r.status})`);
  };
  if (existsSync(dest)) run("git", ["-C", dest, "pull", "--ff-only"]);
  else run("git", ["clone", "--depth", "1", n.repo, dest]);
  if (n.pip.length) run("uv", ["pip", "install", "--python", py, ...n.pip]);
  onLine(`installed ${n.dir}. Restart ComfyUI (dogs comfy restart) to load it.`);
}
