// Hugging Face Hub browsing through its public REST API (the same one the `hf` CLI uses): search models by
// kind, list a repo's weight files with sizes, and work out which files to fetch for a family.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HF, FAMILIES } from "./families.mjs";
import { WEIGHT_EXT } from "./scan.mjs";
import { listModels } from "./models.mjs";

// Hub pipeline tags per kind of output.
const PIPELINES = {
  image: ["text-to-image", "image-to-image"],
  video: ["text-to-video", "image-to-video"],
  audio: ["text-to-audio", "text-to-speech"],
};

function token() {
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN;
  const home = process.env.HF_HOME || path.join(os.homedir(), ".cache", "huggingface");
  try { return readFileSync(path.join(home, "token"), "utf8").trim(); } catch { return ""; }
}

async function hub(pathname) {
  const t = token();
  const res = await fetch(HF + pathname, { headers: t ? { authorization: `Bearer ${t}` } : {}, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Hugging Face says ${res.status}: the repo is gated or private. Accept its license on ${HF} and run \`hf auth login\`.`), { status: 403 });
  if (res.status === 404) throw Object.assign(new Error("not found on Hugging Face"), { status: 404 });
  if (!res.ok) throw new Error(`Hugging Face ${pathname} -> HTTP ${res.status}`);
  return res.json();
}

/** Search hub models. kind narrows to image / video / audio pipelines; sort = downloads | likes | trending | modified. */
export async function searchModels({ query = "", kind, limit = 20, sort = "downloads" } = {}) {
  const sortKey = { downloads: "downloads", likes: "likes", trending: "trendingScore", modified: "lastModified" }[sort] || "downloads";
  const tags = kind ? PIPELINES[kind] || [] : [null];
  const seen = new Map();
  for (const tag of tags) {
    const q = new URLSearchParams({ sort: sortKey, direction: "-1", limit: String(limit), full: "false" });
    if (query) q.set("search", query);
    if (tag) q.set("pipeline_tag", tag);
    for (const m of await hub(`/api/models?${q}`)) {
      if (seen.has(m.id)) continue;
      seen.set(m.id, {
        repo: m.id, url: `${HF}/${m.id}`, pipeline: m.pipeline_tag || null, downloads: m.downloads ?? 0, likes: m.likes ?? 0,
        gated: !!m.gated, updated: m.lastModified || null,
        kind: Object.entries(PIPELINES).find(([, p]) => p.includes(m.pipeline_tag))?.[0] || null,
        family: FAMILIES.find((f) => f.download.items.some((it) => it.repo === m.id))?.id || null,
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.downloads - a.downloads).slice(0, limit);
}

/** Weight files in a repo, with sizes and direct links. */
export async function repoFiles(repo) {
  const tree = await hub(`/api/models/${repo}/tree/main?recursive=true`);
  const info = await hub(`/api/models/${repo}`).catch(() => ({}));
  const files = tree
    .filter((e) => e.type === "file" && WEIGHT_EXT.has(path.extname(e.path).toLowerCase()))
    .map((e) => ({ file: e.path, size: e.lfs?.size ?? e.size, url: `${HF}/${repo}/blob/main/${e.path}` }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { repo, url: `${HF}/${repo}`, gated: !!info.gated, pipeline: info.pipeline_tag || null, files, size: files.reduce((s, f) => s + (f.size || 0), 0) };
}

/** For a family id: the roles to download, i.e. only what the installed copy is missing (all of them if none is). */
export async function missingRoles(familyId) {
  const { models } = await listModels({ refresh: true });
  const installed = models.filter((m) => m.family === familyId);
  if (!installed.length) return null;
  const best = installed.find((m) => m.status === "ready") || installed[0];
  return [...best.missing, ...best.broken];
}
