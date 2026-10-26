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
  CREATE TABLE IF NOT EXISTS chats (
    id       TEXT PRIMARY KEY,
    title    TEXT NOT NULL,
    model    TEXT,
    created  INTEGER NOT NULL,
    updated  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id        TEXT PRIMARY KEY,
    chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role      TEXT NOT NULL,
    content   TEXT NOT NULL,
    thinking  TEXT,
    model     TEXT,
    tokens    INTEGER,
    context   INTEGER,
    created   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, created);
  CREATE TABLE IF NOT EXISTS characters (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    bio      TEXT NOT NULL DEFAULT '',
    lists    TEXT NOT NULL DEFAULT '[]',
    avatar   TEXT,
    created  INTEGER NOT NULL,
    updated  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS character_media (
    id           TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    file         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    source       TEXT NOT NULL,
    name         TEXT,
    created      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS character_media_char ON character_media (character_id, created);
  CREATE TABLE IF NOT EXISTS prompts (
    id         TEXT PRIMARY KEY,
    text       TEXT NOT NULL UNIQUE,
    title      TEXT,
    category   TEXT NOT NULL DEFAULT 'other',
    kind       TEXT,
    notes      TEXT,
    uses       INTEGER NOT NULL DEFAULT 0,
    created    INTEGER NOT NULL,
    last_used  INTEGER
  );
  CREATE INDEX IF NOT EXISTS prompts_recent ON prompts (COALESCE(last_used, created) DESC);
  PRAGMA foreign_keys = ON;
`);
// Columns added after the first release (SQLite has no ADD COLUMN IF NOT EXISTS).
for (const [table, col, type] of [["chats", "character_id", "TEXT"]]) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

// ---------------------------------------------------------------- characters

const charFromRow = (r) => r && { ...r, lists: JSON.parse(r.lists) };

export async function listCharacters() {
  return db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM character_media m WHERE m.character_id = c.id) AS media_count,
      (SELECT file FROM character_media m WHERE m.id = c.avatar) AS avatarFile
    FROM characters c ORDER BY updated DESC`).all().map(charFromRow);
}

export async function getCharacter(id) {
  const c = charFromRow(db.prepare("SELECT * FROM characters WHERE id = ?").get(id));
  if (!c) return null;
  return { ...c, media: db.prepare("SELECT * FROM character_media WHERE character_id = ? ORDER BY created DESC").all(id) };
}

export async function saveCharacter(c) {
  db.prepare(`INSERT INTO characters (id, name, bio, lists, avatar, created, updated)
    VALUES (:id, :name, :bio, :lists, :avatar, :created, :updated)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, bio = excluded.bio, lists = excluded.lists,
      avatar = excluded.avatar, updated = excluded.updated`)
    .run({ id: c.id, name: c.name, bio: c.bio, lists: JSON.stringify(c.lists || []), avatar: c.avatar ?? null, created: c.created, updated: c.updated });
}

export async function deleteCharacterRow(id) {
  db.prepare("DELETE FROM character_media WHERE character_id = ?").run(id);
  db.prepare("DELETE FROM characters WHERE id = ?").run(id);
}

export async function addCharacterMedia(m) {
  db.prepare(`INSERT INTO character_media (id, character_id, file, kind, source, name, created)
    VALUES (:id, :character_id, :file, :kind, :source, :name, :created)`).run({ name: null, ...m });
  db.prepare("UPDATE characters SET updated = ? WHERE id = ?").run(m.created, m.character_id);
}

export async function getCharacterMedia(id) {
  return db.prepare("SELECT * FROM character_media WHERE id = ?").get(id) || null;
}

export async function deleteCharacterMediaRow(id) {
  db.prepare("DELETE FROM character_media WHERE id = ?").run(id);
}

// ---------------------------------------------------------------- prompts

/** Most recently used first. q matches text, title and notes. */
export async function listPrompts({ q, category } = {}) {
  const where = [], args = {};
  if (category) { where.push("category = :category"); args.category = category; }
  if (q) {
    where.push("(text LIKE :q ESCAPE '\\' OR title LIKE :q ESCAPE '\\' OR notes LIKE :q ESCAPE '\\')");
    args.q = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  }
  return db.prepare(`SELECT * FROM prompts ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(last_used, created) DESC`).all(args);
}

export async function getPrompt(id) {
  return db.prepare("SELECT * FROM prompts WHERE id = ?").get(id) || null;
}

export async function getPromptByText(text) {
  return db.prepare("SELECT * FROM prompts WHERE text = ?").get(text) || null;
}

export async function savePrompt(p) {
  db.prepare(`INSERT INTO prompts (id, text, title, category, kind, notes, uses, created, last_used)
    VALUES (:id, :text, :title, :category, :kind, :notes, :uses, :created, :last_used)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, category = excluded.category, kind = excluded.kind,
      notes = excluded.notes, uses = excluded.uses, last_used = excluded.last_used`)
    .run({ title: null, kind: null, notes: null, uses: 0, last_used: null, ...p });
}

export async function deletePromptRow(id) {
  db.prepare("DELETE FROM prompts WHERE id = ?").run(id);
}

// Built-in prompts are added once (PRAGMA user_version marks it), so deleting one keeps it deleted.
export function seedPromptsOnce(rows) {
  if (db.prepare("PRAGMA user_version").get().user_version >= 1) return;
  db.exec("BEGIN");
  try {
    const ins = db.prepare(`INSERT OR IGNORE INTO prompts (id, text, title, category, kind, notes, uses, created)
      VALUES (:id, :text, :title, :category, :kind, :notes, 0, :created)`);
    for (const r of rows) ins.run(r);
    db.exec("PRAGMA user_version = 1");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---------------------------------------------------------------- chats

export async function listChats(limit = 200) {
  return db.prepare("SELECT * FROM chats ORDER BY updated DESC LIMIT ?").all(limit);
}

export async function getChat(id) {
  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(id);
  if (!chat) return null;
  return { ...chat, messages: db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created").all(id) };
}

export async function createChat({ id, title, model, created, characterId }) {
  db.prepare("INSERT INTO chats (id, title, model, created, updated, character_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, title, model ?? null, created, created, characterId ?? null);
}

export async function updateChat(id, { title, model, updated }) {
  db.prepare("UPDATE chats SET title = COALESCE(?, title), model = COALESCE(?, model), updated = COALESCE(?, updated) WHERE id = ?")
    .run(title ?? null, model ?? null, updated ?? null, id);
}

export async function deleteChat(id) {
  db.prepare("DELETE FROM messages WHERE chat_id = ?").run(id);
  db.prepare("DELETE FROM chats WHERE id = ?").run(id);
}

export async function addMessage(m) {
  db.prepare(`INSERT INTO messages (id, chat_id, role, content, thinking, model, tokens, context, created)
    VALUES (:id, :chat_id, :role, :content, :thinking, :model, :tokens, :context, :created)`)
    .run({ thinking: null, model: null, tokens: null, context: null, ...m });
}

export async function deleteMessagesFrom(chatId, created) {
  db.prepare("DELETE FROM messages WHERE chat_id = ? AND created >= ?").run(chatId, created);
}

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
