# AGENTS.md

Node 24, ESM (`"type": "module"`, top-level await). No tests, typecheck, or CI.

## Setup

```sh
cp .env.example .env  # then fill in values
npm install
source ./session.sh   # optional shortcuts: `batch <name>`, `start-pod`, `stop-pod`, `models <name>`
```

`dotenv` values are literal (no variable expansion). `package-lock.json` is gitignored — do not commit it.

## Commands

| Command                                  | Notes                                                             |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `npm run batch -- <input-name>`          | Reads `./inputs/<input-name>.yaml` (bare name, no path/extension) |
| `npm run start-pod` / `npm run stop-pod` | RunPod GPU pod up/down; needs `RUNPOD_API_KEY`                    |
| `npm run convert-all`                    | Re-convert every PNG under `output/` to `dist/`                   |

## Required QA

Every new development change must pass both checks before it is considered complete:

```sh
npm run lint
npm run format:check
```

## Config precedence

ComfyUI server is resolved in `jobs/config.mjs`: `runpod/.active-pod.json` `comfyUrl` (written by `start-pod`) wins over `COMFY_SERVER` from `.env`. One must be set. `COMFY_POLL_INTERVAL_MS` defaults to `5000`, must be integer >= 1.

## Pipeline (`batch.mjs` is thin orchestrator only)

`requireConfig -> requireInputName -> requireWorkflows ->` per job `queuePrompt -> waitForCompletion -> saveOutputs -> addToLog -> convertOutputs`. Failure in any job logs and `process.exit(1)`; log file `output/logs/<input>_<run-ts>.json` is created empty up front and appended live.

- `workflows/workflow.mjs`: YAML parsing + base-workflow overrides. Images fetched via `GET /view` only — never assumes server disk access.
- `jobs/comfy.mjs`: `POST /prompt`, poll `GET /history/{id}` until entry appears with `status_str === "success"`.
- `jobs/save.mjs` + `utils/paths.mjs`: unsafe `output-folder` (path escape) is ignored with a warning, falls back to `output/`.
- `jobs/convert.mjs`: PNG → JPG quality 90 into flat `dist/` (subfolders not preserved).
- `workflows/models.mjs`: per-`base-workflow` model + LoRA URL registry (`WORKFLOW_MODELS`).

## Input YAML (`inputs/`, gitignored except `input.example.yaml`)

- Top-level list of blocks; every block **must** have a `prompts` list. Each entry merges over its parent — per-prompt `tries`/`seed`/`prompt` win.
- `base-workflow: <name>` loads `workflows/<name>.json` (`.json` suffix optional). `steps`/`cfg`/`size`/`filename-prefix` applied only when set.
- `prompt` must be a list of strings, appended in order to the base positive prompt (`PositiveCLIP_Base` or sampler-linked `CLIPTextEncode`). `tries` must be int >= 1, default 1.
- Seed rule: fixed seed kept only when `tries` is unset/`1`; `tries > 1` always randomizes. Otherwise seed is `Math.floor(Math.random() * MAX_SAFE_INTEGER)`.
- Overrides locate nodes by `class_type` (`KSampler`, `EmptyLatentImage`, `SaveImage`); new base JSONs must keep those node types or overrides silently no-op.

## Outputs (all gitignored)

- `output/<output-folder>/<prefix>_YYYYMMDDHHmmss.png` (`_<n>` suffix for multi-image jobs)
- `dist/<prefix>_YYYYMMDDHHmmss.jpg` (flat)
- `output/logs/<input>_<run-ts>.json`

## RunPod (`runpod/`)

Lifecycle is strictly linear, never restart/reuse: create → wait `RUNNING` → work → `stop-pod` (stop, wait `EXITED`, terminate). `start-pod` refuses to run while `.active-pod.json` exists; `stop-pod` is safe to re-run (missing pod just clears the pointer). Pointer file is written immediately after create and deleted only after confirmed terminate — never delete it manually while a pod may be billable. Pod SSH details print at the end of `start-pod`;
