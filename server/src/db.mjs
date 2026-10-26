// SQLite database (runtime/dogs.db) via Node's built-in node:sqlite: no dependency, no server process.
// Holds every generation: prompt, model, parameters, seed, timestamps and output files.
// All access goes through the async functions below and the SQL is plain SQLite, so moving to Cloudflare D1
// (also SQLite, async API) means swapping only this file.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { RUNTIME, OUTPUTS } from "./config.mjs";

export const DB_PATH = path.join(RUNTIME, "dogs.db");
const LEGACY_JSON = path.join(OUTPUTS, "jobs.json");

mkdirSync(RUNTIME, { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    model       TEXT NOT NULL,
    model_label TEXT,
    prompt      TEXT NOT NULL,
    params      TEXT NOT NULL DEFAULT '{}',
    seed        INTEGER,
    status      TEXT NOT NULL,
    error       TEXT,
    outputs     TEXT NOT NULL DEFAULT '[]',
    client      TEXT,
    created     INTEGER NOT NULL,
    started     INTEGER,
    finished    INTEGER
  );
  CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created DESC);
  CREATE INDEX IF NOT EXISTS jobs_kind ON jobs (kind, created DESC);
`);

const upsert = db.prepare(`
  INSERT INTO jobs (id, kind, model, model_label, prompt, params, seed, status, error, outputs, client, created, started, finished)
  VALUES (:id, :kind, :model, :modelLabel, :prompt, :params, :seed, :status, :error, :outputs, :client, :created, :started, :finished)
  ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error, outputs = excluded.outputs,
    started = excluded.started, finished = excluded.finished`);

const toParams = (j) => ({
  id: j.id, kind: j.kind, model: j.model, modelLabel: j.modelLabel ?? null, prompt: j.prompt,
  params: JSON.stringify(j.params || {}), seed: j.seed ?? null, status: j.status, error: j.error ?? null,
  outputs: JSON.stringify(j.outputs || []), client: j.client ?? null, created: j.created, started: j.started ?? null, finished: j.finished ?? null,
});

/** Insert or update a job (the in-memory shape used by jobs.mjs). */
export async function saveJob(j) {
  upsert.run(toParams(j));
}

const fromRow = (r) => ({
  id: r.id, kind: r.kind, model: r.model, modelLabel: r.model_label, prompt: r.prompt, params: JSON.parse(r.params),
  seed: r.seed, status: r.status, error: r.error, outputs: JSON.parse(r.outputs), client: r.client,
  created: r.created, started: r.started, finished: r.finished, progress: null,
});

/** Newest first. q matches the prompt (case-insensitive substring). */
export async function queryJobs({ kind, q, status, limit = 100, before } = {}) {
  const where = [], args = {};
  if (kind) { where.push("kind = :kind"); args.kind = kind; }
  if (status) { where.push("status = :status"); args.status = status; }
  if (q) { where.push("prompt LIKE :q ESCAPE '\\'"); args.q = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`; }
  if (before) { where.push("created < :before"); args.before = before; }
  const sql = `SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created DESC LIMIT :limit`;
  return db.prepare(sql).all({ ...args, limit }).map(fromRow);
}

export async function getJobRow(id) {
  const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  return r ? fromRow(r) : null;
}

export async function deleteJobRow(id) {
  db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
}

// Jobs left queued/running by a crash or restart can never finish.
db.prepare("UPDATE jobs SET status = 'error', error = 'interrupted by a server restart' WHERE status IN ('queued', 'running')").run();

// One-time import of the old JSON history.
if (existsSync(LEGACY_JSON)) {
  try {
    const old = JSON.parse(readFileSync(LEGACY_JSON, "utf8"));
    db.exec("BEGIN");
    for (const j of old) upsert.run(toParams({ ...j, status: ["queued", "running"].includes(j.status) ? "error" : j.status }));
    db.exec("COMMIT");
    renameSync(LEGACY_JSON, LEGACY_JSON + ".imported");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    console.error("[dogs] could not import jobs.json:", e.message);
  }
}
