import test from "node:test";
import assert from "node:assert/strict";
import { planDownload } from "../src/downloads.mjs";

const repo = "Noctaluna/Noct-Q-Uncensored-Qwen-Image-2.1";
const v3 = "NoctQ_V3_base_int8_convrot.safetensors";
const v4 = "NoctQ_V4_int8_convrot.safetensors";
const companions = {
  repo: "Comfy-Org/Qwen-Image-2.1",
  files: ["text_encoders/qwen3vl_8b_int8_convrot.safetensors", "vae/qwen_image_2.1_vae_bf16.safetensors"],
};

test("either Noct Q search download installs companions without switching versions", () => {
  for (const file of [v3, v4]) {
    assert.deepEqual(planDownload(repo, [file]).steps, [{ repo, files: [file] }, companions]);
  }
  assert.deepEqual(planDownload(repo, [v3, v4]).steps, [{ repo, files: [v3, v4] }, companions]);
});

test("the Anime search result installs its own main weight and shared companions", () => {
  const animeRepo = "Noctaluna/Noct-Q-Anime-Uncensored-Qwen-Image-2.1";
  const files = ["NoctQA_V1_int8_convrot.safetensors"];
  assert.deepEqual(planDownload(animeRepo, files).steps, [{ repo: animeRepo, files }, companions]);
});

test("finishing a partial family fetches only the missing roles", () => {
  assert.deepEqual(planDownload("noct-q", [], ["text_encoder", "vae"]).steps, [companions]);
});

test("unrelated repos, auxiliary files, and whole-repo downloads keep their explicit scope", () => {
  for (const [target, files] of [["someone/other", [v4]], [repo, ["README.md"]], [repo, []], [companions.repo, [companions.files[0]]]]) {
    assert.deepEqual(planDownload(target, files).steps, [{ repo: target, files }]);
  }
});

test("file paths are validated before planning a supported download", () => {
  for (const files of [["../escape.safetensors"], [v4 + "&whoami"], [null], "not-an-array"]) {
    assert.throws(() => planDownload(repo, files), { status: 400 });
  }
});
