# dogs-ai: local opencode + ComfyUI stack

Everything runs on your machine:

| Piece | What | Where |
|---|---|---|
| **opencode** `1.19.4` | Coding agent CLI/TUI | global npm, config in `~/.config/opencode/opencode.json` (generated) |
| **Qwen3.5-9B** (Ollama `qwen3.5:9b`, Q4_K_M, 6.6 GB) | Agentic coding model | Ollama model store |
| **ComfyUI** `v0.42.5` | Image pipeline server, `127.0.0.1:8188` | `runtime/ComfyUI` (git-ignored) |
| **FLUX.3 Image Klein** distilled int8 (5.8 GB + 4.9 GB encoder + VAE) | Text-to-image and image editing | `runtime/models/flux3-klein` (git-ignored) |
| **comfy-mcp** | MCP server that gives opencode `comfy_generate_image` / `comfy_edit_image` | `mcp/comfy-mcp` |

Versions and model files are pinned in [`stack.json`](stack.json). Change them there and re-run the installer.

> **Video/audio:** FLUX 3 Video and Audio weights are not public (API/early access only), so this stack is
> image-only. The MCP server is set up so a `generate_video` tool can be added once open weights ship.

## Requirements

- Windows 10/11, NVIDIA GPU (tested: RTX 4050 Laptop 6 GB) with a current driver, 32 GB RAM recommended
- ~35 GB free disk (PyTorch ~5 GB, FLUX ~11 GB, Qwen ~7 GB, ComfyUI deps)
- `winget` (built into Windows) or Chocolatey in an **elevated** shell. Everything else is installed for you
- A Hugging Face account (FLUX.3 Klein is gated)

## Install on a new machine

```powershell
git clone <this repo> dogs-ai
cd dogs-ai
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer is idempotent (re-run it to repair or upgrade). It:

1. installs git, Node.js LTS, uv and Ollama if missing (choco when elevated, otherwise winget per-user)
2. clones ComfyUI at the pinned tag, creates a Python 3.12 venv with CUDA PyTorch (`cu128`)
3. installs opencode and the MCP server's npm deps
4. runs `scripts\download-models.ps1`:
   - `ollama pull qwen3.5:9b` plus the two aliases from [`ollama/Modelfile`](ollama/Modelfile)
   - FLUX.3 Klein from Hugging Face. **Before this step**, accept the license at
     <https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy>. The script then asks for a
     read token (`hf auth login`) if you are not logged in yet
5. renders [`opencode/opencode.template.json`](opencode/opencode.template.json) into your global opencode
   config. An existing non-dogs-ai config is backed up as `opencode.json.bak-<timestamp>`

Flags: `-SkipModels` (do downloads later), `-SkipOpencodeConfig`.
Check everything with `.\scripts\doctor.ps1`.

## Daily use

```powershell
.\scripts\start.ps1      # Ollama + ComfyUI (optional: ComfyUI also auto-starts on the first image request)
cd C:\path\to\any\project
opencode
```

In opencode:

- **Code**: just ask. The default model is `ollama/qwen3.5-9b-fast` (thinking off, fastest).
  The `plan` agent (Tab) uses `qwen3.5-9b-agent` with thinking on, for harder reasoning.
- **Images**: `/image a watercolor logo of a beagle wearing headphones` or ask in plain words
  ("make a 512x512 app icon and save it to ./assets"). The `media` agent (Tab to switch) is tuned for prompts.
- **Edits**: `/edit-image ./assets/logo.png make the headphones red`. Multiple inputs work too:
  refer to them as `<ref_image_0>`, `<ref_image_1>`.

Images land in `outputs/` (or the `save_to` folder you or the agent name). The ComfyUI web UI at
<http://127.0.0.1:8188> also works directly. Templates: *FLUX 3 Image Klein Distilled*.

`.\scripts\stop.ps1` stops ComfyUI.

### 6 GB VRAM notes

Qwen 9B and FLUX don't fit on the GPU together, so the MCP server hands the GPU over: before sampling it
unloads Ollama's models, and afterwards it tells ComfyUI to free VRAM. The first chat turn after an image
is a few seconds slower while Qwen reloads. Turn this off with `VRAM_HANDOFF=0` in the template's MCP
`environment` on bigger GPUs. The 9B Prompt Upsampler from the official templates is left out (it needs
another 6.7 GB). The agent writes the detailed caption instead.

## Layout

```
install.ps1                 one-shot installer
stack.json                  pinned versions + model file list (single source of truth)
scripts/                    common.ps1, download-models, link-opencode, start, start-comfyui, stop, doctor
ollama/Modelfile            32k context + Qwen coding sampler settings
opencode/                   config template, global AGENTS instructions, media agent prompt
mcp/comfy-mcp/              MCP server (server.mjs), API-format FLUX graphs (workflows.mjs), smoke test
runtime/  outputs/          created by the installer, git-ignored
```

## Testing the pipeline without opencode

```powershell
cd mcp\comfy-mcp
node smoke.mjs --generate                      # renders outputs\smoke_t2i_*.png
node smoke.mjs --edit ..\..\outputs\smoke_t2i_00001_.png
```

## Updating

Bump a version in `stack.json` (for example `comfyui.ref`, `opencode.version`), re-run `install.ps1`, run
`doctor.ps1` and the smoke test, then commit.
