// HTTP API used by the desktop app, the CLI, and outside callers (e.g. an assistant that needs an image).
// No dependencies: node:http, JSON in and out, Server-Sent Events for live updates.
import http from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { API_HOST, API_PORT, API_KEY, OUTPUTS, REPO, COMFY_URL } from "./config.mjs";
import { listModels, deleteFiles } from "./models.mjs";
import { submit, listJobs, getJob, cancel, removeJob, waitFor, events as jobEvents, mimeOf } from "./jobs.mjs";
import { startDownload, listDownloads, getDownload, events as dlEvents } from "./downloads.mjs";
import { comfyUp, comfyStats, startComfy, stopComfy, freeComfy } from "./comfy.mjs";
import { searchModels, repoFiles, missingRoles } from "./hub.mjs";
import { listLlms, unloadLlm, deleteLlm } from "./llm.mjs";

const APP_DIST = path.join(REPO, "app", "dist");
const STATIC_MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };

const ENDPOINTS = [
  ["GET", "/api/health", "ComfyUI status, GPU and queue"],
  ["GET", "/api/models?kind=image|video|audio&refresh=1", "Installed models (ready / incomplete / broken), scanned locations, unrecognized files"],
  ["POST", "/api/generate", "{ kind | model, prompt, ...params, seed?, wait? } -> job. With wait:true the response is the finished job"],
  ["GET", "/api/jobs?limit=&kind=&q=&status=", "Jobs newest first (q searches prompts), from the SQLite history"],
  ["GET", "/api/jobs/:id", "One job; outputs[].url is downloadable"],
  ["DELETE", "/api/jobs/:id?files=1", "Cancel a queued/running job, or delete a finished one from history (files=1 also deletes its files)"],
  ["GET", "/files/<path>", "Generated files"],
  ["GET", "/api/llm", "Ollama LLMs: size, context window (max / configured / loaded), what is in memory, disk use"],
  ["POST", "/api/llm/:name/unload", "Unload an LLM from memory"],
  ["DELETE", "/api/llm/:name", "Delete an Ollama model"],
  ["POST", "/api/models/delete", "{ ids: [file id] } -> delete scanned weight files (plus their cache links)"],
  ["GET", "/api/hub/search?q=&kind=image|video|audio&sort=downloads|likes|trending|modified&limit=", "Search Hugging Face models"],
  ["GET", "/api/hub/files?repo=org/name", "Weight files in a Hugging Face repo, with sizes and links"],
  ["POST", "/api/downloads", "{ target: <family id or org/repo>, files?: [], all?: bool } -> start a Hugging Face download (families fetch only missing files)"],
  ["GET", "/api/downloads", "Download progress"],
  ["POST", "/api/comfy/start | /api/comfy/stop | /api/comfy/free", "Control the ComfyUI process / VRAM"],
  ["GET", "/api/events", "Server-Sent Events: job and download updates"],
];

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body, null, 1);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", ...headers });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 25 * 2 ** 20) throw Object.assign(new Error("body too large"), { status: 413 }); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("body must be JSON"), { status: 400 }); }
}

function authorized(req, url) {
  if (!API_KEY) return true;
  const h = req.headers.authorization || "";
  // EventSource and <img src> cannot set headers, so ?key= is accepted too.
  return h === `Bearer ${API_KEY}` || url.searchParams.get("key") === API_KEY;
}

async function serveFile(req, res, file, mime) {
  let st;
  try { st = await fs.stat(file); } catch { return send(res, 404, { error: "not found" }); }
  if (!st.isFile()) return send(res, 404, { error: "not found" });
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  const base = { "content-type": mime, "accept-ranges": "bytes", "cache-control": "no-cache" };
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...base, "content-length": st.size });
    createReadStream(file).pipe(res);
  }
}

// Resolve a request path inside a root, refusing anything that escapes it.
function inside(root, rel) {
  const p = path.resolve(root, "." + path.sep + decodeURIComponent(rel));
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

function sse(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  const onJob = (j) => res.write(`event: job\ndata: ${JSON.stringify(j)}\n\n`);
  const onDl = (d) => res.write(`event: download\ndata: ${JSON.stringify({ ...d, done: undefined })}\n\n`);
  jobEvents.on("job", onJob);
  dlEvents.on("download", onDl);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(ping); jobEvents.off("job", onJob); dlEvents.off("download", onDl); });
}

async function route(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === "/api" || p === "/api/") return send(res, 200, { name: "dogs-ai", endpoints: ENDPOINTS.map(([method, route, about]) => ({ method, route, about })) });
  if (p === "/api/health" && m === "GET") {
    const up = await comfyUp();
    return send(res, 200, { ok: true, comfy: { url: COMFY_URL, up, ...(up ? await comfyStats().catch((e) => ({ error: e.message })) : {}) }, auth: !!API_KEY });
  }
  if (p === "/api/models" && m === "GET") {
    const r = await listModels({ refresh: url.searchParams.has("refresh") });
    const kind = url.searchParams.get("kind");
    return send(res, 200, kind ? { ...r, models: r.models.filter((x) => x.kind === kind), families: r.families.filter((f) => f.kind === kind) } : r);
  }
  if (p === "/api/generate" && m === "POST") {
    const body = await readBody(req);
    const job = await submit(body);
    if (body.wait) return send(res, 200, await waitFor(job));
    return send(res, 202, job);
  }
  if (p === "/api/jobs" && m === "GET") {
    const s = url.searchParams;
    return send(res, 200, await listJobs({ limit: Math.min(1000, Number(s.get("limit") || 100)), kind: s.get("kind") || undefined, q: s.get("q") || undefined, status: s.get("status") || undefined }));
  }
  const jm = /^\/api\/jobs\/([\w-]+)$/.exec(p);
  if (jm && m === "GET") { const j = await getJob(jm[1]); return j ? send(res, 200, j) : send(res, 404, { error: "no such job" }); }
  if (jm && m === "DELETE") {
    // In flight: cancel it. Finished: remove it from history (and its files with ?files=1).
    const j = await getJob(jm[1]);
    if (!j) return send(res, 404, { error: "no such job" });
    if (["queued", "running"].includes(j.status)) return send(res, 200, await cancel(j.id));
    return send(res, 200, { deleted: (await removeJob(j.id, { files: url.searchParams.get("files") === "1" })).id });
  }

  if (p === "/api/downloads" && m === "GET") return send(res, 200, listDownloads().map((d) => ({ ...d, done: undefined })));
  if (p === "/api/downloads" && m === "POST") {
    const { target, files = [], all = false } = await readBody(req);
    // For a family, fetch only what the installed copy is missing unless all:true.
    const roles = all || files.length ? null : await missingRoles(String(target || ""));
    const dl = startDownload(String(target || ""), files, { roles });
    return send(res, 202, { ...dl, done: undefined });
  }
  if (p === "/api/models/delete" && m === "POST") {
    const { ids } = await readBody(req);
    if (!Array.isArray(ids) || !ids.length) return send(res, 400, { error: "ids: [file id, ...] required" });
    return send(res, 200, await deleteFiles(ids.map(String)));
  }
  if (p === "/api/llm" && m === "GET") return send(res, 200, await listLlms());
  const dlm = /^\/api\/llm\/(.+)$/.exec(p);
  if (dlm && m === "DELETE") { await deleteLlm(decodeURIComponent(dlm[1])); return send(res, 200, { deleted: true }); }
  const um = /^\/api\/llm\/(.+)\/unload$/.exec(p);
  if (um && m === "POST") { await unloadLlm(decodeURIComponent(um[1])); return send(res, 200, { unloaded: true }); }
  if (p === "/api/hub/search" && m === "GET") {
    const s = url.searchParams;
    return send(res, 200, await searchModels({ query: s.get("q") || "", kind: s.get("kind") || undefined, limit: Math.min(100, Number(s.get("limit") || 20)), sort: s.get("sort") || undefined }));
  }
  if (p === "/api/hub/files" && m === "GET") {
    const repo = url.searchParams.get("repo") || "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return send(res, 400, { error: "repo must look like org/name" });
    return send(res, 200, await repoFiles(repo));
  }
  const dm = /^\/api\/downloads\/([\w-]+)$/.exec(p);
  if (dm && m === "GET") { const d = getDownload(dm[1]); return d ? send(res, 200, { ...d, done: undefined }) : send(res, 404, { error: "no such download" }); }

  if (p === "/api/comfy/start" && m === "POST") { await startComfy(); return send(res, 200, { up: true }); }
  if (p === "/api/comfy/stop" && m === "POST") return send(res, 200, { stopped: await stopComfy() });
  if (p === "/api/comfy/free" && m === "POST") { await freeComfy(); return send(res, 200, { freed: true }); }
  if (p === "/api/events" && m === "GET") return sse(req, res);

  if (p.startsWith("/files/") && m === "GET") {
    const f = inside(OUTPUTS, p.slice("/files/".length));
    return f ? serveFile(req, res, f, mimeOf(f)) : send(res, 400, { error: "bad path" });
  }
  // The built desktop app is also served here, so any browser on the network can use it.
  if (m === "GET" && !p.startsWith("/api/")) {
    let f = inside(APP_DIST, p === "/" ? "index.html" : p.slice(1));
    if (f) {
      try { if (!(await fs.stat(f)).isFile()) throw 0; } catch { f = path.join(APP_DIST, "index.html"); }
      try { await fs.access(f); return serveFile(req, res, f, STATIC_MIME[path.extname(f)] || "application/octet-stream"); } catch {}
    }
    return send(res, 404, "dogs-ai API. The app is not built yet: run `npm run build` in app/. Endpoints: GET /api");
  }
  return send(res, 404, { error: `no route ${m} ${p}` });
}

export function serve({ host = API_HOST, port = API_PORT } = {}) {
  if (!API_KEY && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    console.error(`[dogs] WARNING: listening on ${host} without DOGS_API_KEY. Anyone on the network can use the GPU.`);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const url = new URL(req.url, "http://x");
    const isApp = req.method === "GET" && !url.pathname.startsWith("/api") && !url.pathname.startsWith("/files/");
    if (!isApp && !authorized(req, url)) return send(res, 401, { error: "missing or wrong API key (Authorization: Bearer <DOGS_API_KEY>)" });
    try { await route(req, res, url); } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: String(e.message || e) });
      else res.end();
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
