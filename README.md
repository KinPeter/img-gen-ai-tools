# Image generation AI tools

This repo will hold several tools to interact with image generation AI.

# Comfy Batch

Batch image generation against a ComfyUI backend — local or on a RunPod cloud GPU — plus a small toolkit for managing RunPod pods from the terminal.

The main flow: describe any number of prompts in a YAML file, run one command, and get PNGs in `output/`, JPGs in `dist/`, and a live JSON run log. The RunPod scripts are an optional addition: spin up a GPU pod, point the batch at it, tear it down when done.

## Requirements

- Node.js 24 (ES modules, top-level await)
- A ComfyUI backend: local (`http://127.0.0.1:8188`) or a RunPod pod exposing port `8188`
- Dependencies: `dotenv`, `yaml`, `sharp` (`npm install`)

## Quick start

```sh
cp .env.example .env   # then fill in values
npm install

# session shortcuts (current shell only, nothing installed globally)
source ./session.sh    # or: . ./session.sh

start-pod              # fire up a RunPod GPU pod (optional - skip for local)
batch input.example    # run a batch
stop-pod               # stop + terminate the pod when done
comfy -p <pod-name> -i <input1>,<input2>,... # runs all the above in sequence
```

`batch.mjs` picks the ComfyUI URL from the active pod state file first (`runpod/.active-pod.json`, written by `start-pod`) and falls back to `COMFY_SERVER` from `.env`.

## Tools used

- **ComfyUI API** (`/prompt`, `/history/{id}`, `/view`) — queueing, polling, image download
- **RunPod REST API v2** — GPU catalog, pod create/get/action
- **sharp** — PNG to JPG conversion (quality 90)
- **yaml** — input file parsing (order-preserving)
- **dotenv** — `.env` config (values are literal, no variable expansion)

## Batch usage

```sh
batch <input-name>   # reads ./inputs/<input-name>.yaml
```

### Input YAML

A list of settings blocks. Each block shares its settings across a `prompts` list; per-prompt `tries`/`seed`/`prompt` override the parent:

```yaml
- base-workflow: juggernaut-simple-base # workflows/<name>.json, required
  output-folder: rover-city # subfolder of output/
  filename-prefix: rover
  steps: 20 # optional, base default otherwise
  cfg: 3.5 # optional, base default otherwise
  size: # optional, base default otherwise
    width: 832
    height: 1216
  lora-strengths:
    [1, 0.5] # optional, one entry per LoraLoader node
    # (workflow order, sets strength_model);
    # omitted keeps base values; wrong count errors
  prompts:
    - tries: 4 # optional, default 1; forces random seeds
      prompt: # list of parts, joined in order
        - glossy, soft light
        - woman, {black, blonde, red} hair # a separate prompt is created with the values inside {...}
        - city background
      negative-prompt: # optional, same join logic on the base negative prompt
        - blurry, lowres

    - seed: 12345 # optional; number, "random", or omitted (= random)
      prompt:
        - vintage, broken clouds
        - beach, waves, storm
```

Rules: `seed` is random unless set to a fixed number (a fixed seed is kept only when `tries` is unset or `1` — `tries > 1` always randomizes). Prompt parts are appended in list order to the base workflow's positive prompt; `negative-prompt` parts work the same way on the base negative prompt (found via the sampler's `negative` link, else `NegativeCLIP_Base`). `lora-strengths` sets each `LoraLoader` node's `strength_model` (`strength_clip` untouched); the list must have exactly one entry per LoRA node or the job errors. Per-prompt `tries`/`seed`/`prompt`/`negative-prompt`/`lora-strengths` override the parent. The base workflow's seed is never reused.

### Outputs

- `output/<output-folder>/<prefix>_YYYYMMDDHHmmss.png` (extra images in one job get `_<n>`)
- `dist/<output-folder>/<prefix>_YYYYMMDDHHmmss.jpg` — converted, ready for upload
- `output/logs/<input-name>_<run-timestamp>.json` — one file per run, entries appended live as images finish:

```json
{
  "prompt": { "…yaml settings…", "seed": 12345, "prompt": "full positive prompt…", ... },
  "filename": "rover_20261003212855.png",
  "outputPath": "…/output/rover-city",
  "generatedIn": "12:21",
  "comfyJobId": "52104f5d-…"
}
```

### Config (.env)

| Variable                 | Required                     | Description                         |
| ------------------------ | ---------------------------- | ----------------------------------- |
| `COMFY_SERVER`           | yes (unless a pod is active) | ComfyUI base URL                    |
| `COMFY_POLL_INTERVAL_MS` | no (default `5000`)          | History poll interval while waiting |
| `RUNPOD_API_KEY`         | for RunPod scripts           | RunPod REST API v2 key              |

## RunPod tools (addition)

See [RunPod README](./runpod/README.md)

## npm scripts

| Script                                   | Command                                                |
| ---------------------------------------- | ------------------------------------------------------ |
| `npm run batch -- <input-name>`          | run a batch (or `batch <input-name>` via `session.sh`) |
| `npm run start-pod` / `npm run stop-pod` | pod up / down                                          |
| `npm run convert-all`                    | re-convert all PNGs in `output/`                       |
