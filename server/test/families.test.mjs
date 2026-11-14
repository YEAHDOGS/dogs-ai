import test from "node:test";
import assert from "node:assert/strict";
import { FAMILIES, normalizeParams } from "../src/families.mjs";

const family = (id) => FAMILIES.find((f) => f.id === id);

test("Noct Q weights are recognized exactly once without confusing realism, anime, or companions", () => {
  const examples = [
    ["NoctQ_V3_base_int8_convrot.safetensors", "noct-q"],
    ["NoctQ_V4_int8_convrot.safetensors", "noct-q"],
    ["NoctQA_V1_int8_convrot.safetensors", "noct-q-anime"],
    ["qwen_image_2.1_int8_convrot.safetensors", "qwen-image-2.1"],
    ["qwen3vl_8b_int8_convrot.safetensors", null],
    ["qwen_image_2.1_vae_bf16.safetensors", null],
    ["NoctQ_V4_workflow.json", null],
  ];
  for (const [name, expected] of examples) {
    assert.deepEqual(FAMILIES.filter((f) => f.files.model.match.test(name)).map((f) => f.id), expected ? [expected] : [], name);
  }
});

test("Noct Q download bundles include one variant and the matching Qwen 2.1 companions", () => {
  for (const id of ["noct-q", "noct-q-anime"]) {
    const f = family(id);
    assert.deepEqual(f.download.items.map((it) => it.role).sort(), ["model", "text_encoder", "vae"]);
    for (const item of f.download.items) assert.ok(f.files[item.role].match.test(item.file.split("/").at(-1)), item.file);
    assert.deepEqual(f.download.items.filter((it) => it.role !== "model"), family("qwen-image-2.1").download.items.filter((it) => it.role !== "model"));
  }
  assert.equal(family("noct-q").download.items[0].file, "NoctQ_V4_int8_convrot.safetensors");
});

test("Noct Q generation uses the requested weights and Qwen conditioning with the author's sampler settings", () => {
  for (const id of ["noct-q", "noct-q-anime"]) {
    const f = family(id);
    const files = Object.fromEntries(f.download.items.map((it) => [it.role, it.file.split("/").at(-1)]));
    const graph = f.graph({ files, ...normalizeParams(f.params, {}), prompt: "A dog beside a lake", negative: "blurry", seed: 42, prefix: "test" });
    assert.equal(graph.unet.class_type, "UNETLoader");
    assert.equal(graph.unet.inputs.unet_name, files.model);
    assert.equal(graph.clip.inputs.type, "qwen_image");
    assert.equal(graph.cond.class_type, "TextEncodeQwenImage21");
    assert.equal(graph.cond.inputs.negative_prompt, "blurry");
    assert.equal(graph.sample.inputs.cfg, 3);
    assert.equal(graph.sample.inputs.steps, 25);
    assert.equal(graph.sample.inputs.sampler_name, "euler");
    assert.equal(graph.sample.inputs.scheduler, "simple");
    assert.deepEqual(f.nodesFor(files), []);
    for (const node of Object.values(graph)) {
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value)) assert.ok(graph[value[0]], `Missing graph node ${value[0]}`);
      }
    }
  }
});

test("the original Qwen family retains its defaults and GGUF loader", () => {
  const f = family("qwen-image-2.1");
  assert.equal(f.params.cfg.default, 1);
  const files = { model: "qwen-image-2.1-Q4_K_M.gguf", text_encoder: "qwen3vl_8b_int8_convrot.safetensors", vae: "qwen_image_2.1_vae_bf16.safetensors" };
  assert.deepEqual(f.nodesFor(files), ["UnetLoaderGGUF"]);
  assert.equal(f.graph({ files, ...normalizeParams(f.params, {}), prompt: "A dog", seed: 42, prefix: "test" }).unet.class_type, "UnetLoaderGGUF");
});
