import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { measure } from "../src/storage.mjs";
import { scanFiles } from "../src/scan.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dogs-storage-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const source = path.join(dir, "source");
  const linked = path.join(dir, "linked");
  await fs.mkdir(source);
  await fs.mkdir(path.join(linked, "diffusion_models"), { recursive: true });
  const original = path.join(source, "NoctQ_V4_int8_convrot.safetensors");
  const alias = path.join(linked, "diffusion_models", path.basename(original));
  await fs.writeFile(original, "");
  await fs.truncate(original, 6 * 2 ** 20);
  await fs.link(original, alias);
  return { source, linked, original, alias, bytes: 6 * 2 ** 20 };
}

test("storage counts a model once across hard links and retains its size after the original is removed", async (t) => {
  const f = await fixture(t);
  const seen = new Set();
  assert.equal((await measure(f.source, seen)).bytes, f.bytes);
  assert.deepEqual(await measure(f.linked, seen), { bytes: 0, files: 1, shared: f.bytes });
  await fs.unlink(f.original);
  assert.deepEqual(await measure(f.linked), { bytes: f.bytes, files: 1, shared: 0 });
});

test("overlapping storage folders do not double count files with just one link", async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.original);
  const seen = new Set();
  assert.equal((await measure(f.linked, seen)).bytes, f.bytes);
  assert.deepEqual(await measure(path.dirname(f.alias), seen), { bytes: 0, files: 1, shared: f.bytes });
});

test("model scanning deduplicates hard links and finds the surviving file after cache cleanup", async (t) => {
  const f = await fixture(t);
  const locations = [
    { label: "source", dir: f.source, kind: "plain" },
    { label: "comfy-linked", dir: f.linked, kind: "plain" },
  ];
  const before = await scanFiles(locations);
  assert.equal(before.files.length, 1);
  assert.equal(before.files[0].path, f.original);
  assert.deepEqual(before.files[0].alsoAt, [f.alias]);
  await fs.unlink(f.original);
  const after = await scanFiles(locations);
  assert.equal(after.files.length, 1);
  assert.equal(after.files[0].path, f.alias);
  assert.equal(after.files[0].folder, "diffusion_models");
  assert.equal(after.files[0].broken, false);
});
