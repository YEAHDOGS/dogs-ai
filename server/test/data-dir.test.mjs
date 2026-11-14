// node --test server/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultDataDir, hasContent, settle } from "../src/data-dir.mjs";

test("the shared folder is per user and per system", () => {
  assert.equal(defaultDataDir({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a"), "C:\\Users\\a\\AppData\\Local\\DOGS AI");
  assert.equal(defaultDataDir({}, "darwin", "/Users/a"), "/Users/a/Library/Application Support/DOGS AI");
  assert.equal(defaultDataDir({}, "linux", "/home/a"), "/home/a/.local/share/dogs-ai");
  assert.equal(defaultDataDir({ XDG_DATA_HOME: "/data" }, "linux", "/home/a"), "/data/dogs-ai");
});

test("an older copy's folders move into the shared one, ComfyUI's paths with them", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dogs-data-"));
  const old = path.join(root, "old-copy");
  const shared = path.join(root, "shared");
  mkdirSync(path.join(old, "runtime"), { recursive: true });
  writeFileSync(path.join(old, "runtime", "dogs.db"), "history");
  const oldRuntime = path.join(old, "runtime").replace(/\\/g, "/");
  writeFileSync(path.join(old, "runtime", "extra_model_paths.yaml"), `dogs_linked:\n  base_path: ${oldRuntime}/models/linked\n`);
  mkdirSync(path.join(old, "outputs", "generated"), { recursive: true });
  mkdirSync(path.join(old, "models"), { recursive: true });
  writeFileSync(path.join(old, "models", ".gitkeep"), "");
  mkdirSync(path.join(old, "workflows"), { recursive: true });
  writeFileSync(path.join(old, "workflows", "mine.json"), "{}");

  const { places, notes } = settle(shared, [old]);
  assert.equal(places.workflows, path.join(shared, "workflows"));
  assert.ok(existsSync(path.join(shared, "workflows", "mine.json")));
  assert.equal(places.runtime, path.join(shared, "runtime"));
  assert.equal(readFileSync(path.join(shared, "runtime", "dogs.db"), "utf8"), "history");
  assert.match(readFileSync(path.join(shared, "runtime", "extra_model_paths.yaml"), "utf8"), new RegExp(path.join(shared, "runtime").replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(existsSync(path.join(shared, "outputs", "generated")));
  assert.ok(!existsSync(path.join(old, "runtime")));
  // A models/ with only .gitkeep in it has nothing to move.
  assert.ok(hasContent(path.join(old, "models")) === false && existsSync(path.join(old, "models")));
  assert.equal(notes.filter((n) => n.startsWith("moved")).length, 3);
});

test("a shared folder that already has something is kept, and the older one left alone", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dogs-data-"));
  const old = path.join(root, "old-copy");
  const shared = path.join(root, "shared");
  mkdirSync(path.join(old, "runtime"), { recursive: true });
  writeFileSync(path.join(old, "runtime", "dogs.db"), "old");
  mkdirSync(path.join(shared, "runtime"), { recursive: true });
  writeFileSync(path.join(shared, "runtime", "dogs.db"), "new");
  const { places } = settle(shared, [old]);
  assert.equal(places.runtime, path.join(shared, "runtime"));
  assert.equal(readFileSync(path.join(shared, "runtime", "dogs.db"), "utf8"), "new");
  assert.equal(readFileSync(path.join(old, "runtime", "dogs.db"), "utf8"), "old");
});
