# AGENTS.md

## Managed agentic delivery

Use `/deliver <inline requirement or path-to-requirements-file>` to run the
managed workflow: implementation, independent read-only review, then review
fixes. The orchestrator passes the exact review artifact path to the fixer and
finishes with QA evidence, a manual-testing request, and a suggested commit
message.

- Do not commit, reset, checkout, stash, or discard user changes.
- Every generated workflow artifact belongs under `.tmp/` and must include a
  unique UTC timestamp with seconds in its filename; never use a fixed review
  filename.
- OpenCode definitions live under `.opencode/`; Claude Code mirrors live under
  `.claude/`. Keep both trees synchronized whenever agents, skills, commands,
  or workflow behavior changes. `CLAUDE.md` points back to this file.

Node 24, ESM (`"type": "module"`, top-level await). Vitest (`vitest.config.mjs`, tests under `test/`); no typecheck or CI.

## Setup

```sh
cp .env.example .env  # then fill in values
npm install
source ./session.sh   # optional shortcuts: `comfy-batch <name>`, `start-pod`, `stop-pod`, `models <name>`
```

`dotenv` values are literal (no variable expansion). `package-lock.json` is gitignored — do not commit it.

## Commands

| Command                                  | Notes                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run comfy-batch -- <input-name>`    | Reads `comfyui/inputs/<input-name>.yaml` (bare name, no path/extension)                                                                                                                                                  |
| `npm run start-pod` / `npm run stop-pod` | RunPod GPU pod up/down; needs `RUNPOD_API_KEY`                                                                                                                                                                           |
| `npm run convert-all`                    | Re-convert every PNG under `output/` to `dist/`                                                                                                                                                                          |
| `npm run find-log-from-files`            | Look up a run-log entry by image filename in `output/logs/`                                                                                                                                                              |
| `npm run deploy-find-lambda`             | Zip + publish `logging/log-find-lambda.mjs` to AWS Lambda                                                                                                                                                                |
| `npm run build-find-ui`                  | Inject `LOG_FIND_LAMBDA_URL` into browser UI → `logging/dist/`                                                                                                                                                           |
| `npm run deploy-find-ui`                 | Build (`build-find-ui`) then upload `logging/dist/index.html` via plain FTP to `LOG_FIND_UI_FTP_FOLDER`, overwriting `index.html`; needs `FTP_HOST` (bare hostname) / `FTP_USER` / `FTP_PASS` / `LOG_FIND_UI_FTP_FOLDER` |
| `npm run test` / `npm run test:coverage` | Vitest run / run with per-file 90% line coverage (`vitest.config.mjs`)                                                                                                                                                   |

## Required QA

Every new development change must pass both checks before it is considered complete:

```sh
npm run lint
npm run format:check
```

## Config precedence

ComfyUI server is resolved in `comfyui/jobs/config.mjs`: `runpod/.active-pod.json` `comfyUrl` (written by `start-pod`) wins over `COMFY_SERVER` from `.env`. One must be set. `COMFY_POLL_INTERVAL_MS` defaults to `5000`, must be integer >= 1.

## Pipeline (`comfyui/batch.mjs` is thin orchestrator only)

`requireConfig -> requireInputName -> requireWorkflows ->` per job `queuePrompt -> waitForCompletion -> saveOutputs -> addToLog -> convertOutputs`. Failure in any job logs and `process.exit(1)`; log file `output/logs/<input>_<run-ts>.json` is created empty up front and appended live (subfolder inputs keep their relative subfolder, e.g. `output/logs/archive/<input>_<run-ts>.json`).

- `comfyui/workflows/workflow.mjs`: YAML parsing + base-workflow overrides. Images fetched via `GET /view` only — never assumes server disk access.
- `comfyui/jobs/comfy.mjs`: `POST /prompt`, poll `GET /history/{id}` until entry appears with `status_str === "success"`.
- `comfyui/jobs/save.mjs` + `comfyui/utils/paths.mjs`: unsafe `output-folder` (path escape) is ignored with a warning, falls back to `output/`.
- `comfyui/jobs/convert.mjs`: PNG → JPG quality 90 into `dist/` (mirrors `output/` subfolders).

## Input YAML (`comfyui/inputs/`, gitignored except `input.example.yaml`)

- Top-level list of blocks; every block **must** have a `prompts` list. Each entry merges over its parent — per-prompt `tries`/`seed`/`prompt` win.
- `base-workflow: <name>` loads `comfyui/workflows/<name>.json` (`.json` suffix optional). `steps`/`cfg`/`size`/`filename-prefix` applied only when set.
- `prompt` must be a list of strings, appended in order to the base positive prompt (`PositiveCLIP_Base` or sampler-linked `CLIPTextEncode`). `tries` must be int >= 1, default 1.
- `loras` (list of `{name, strength}`, minimum one entry) builds the `Lora_1..Lora_N` `LoraLoader` chain; omitted → no LoRAs. `clip-skip` (any number) overrides `stop_at_clip_layer`.
- Seed rule: fixed seed kept only when `tries` is unset/`1`; `tries > 1` always randomizes. Otherwise seed is `Math.floor(Math.random() * MAX_SAFE_INTEGER)`.
- Overrides locate nodes by `class_type` (`KSampler`, `EmptyLatentImage`, `SaveImage`); new base JSONs must keep those node types or overrides silently no-op.
- Tests never use gitignored files: base-workflow fixtures live in `test/fixtures/workflows/` and are loaded via the `workflowsDir` parameter of `loadWorkflows`.

## Outputs (all gitignored)

- `output/<output-folder>/<prefix>_YYYYMMDDHHmmss.png` (`_<n>` suffix for multi-image jobs)
- `dist/<output-folder>/<prefix>_YYYYMMDDHHmmss.jpg` (mirrors `output/` subfolders)
- `output/logs/<input>_<run-ts>.json` (subfolder inputs keep their relative subfolder, e.g. `output/logs/archive/<input>_<run-ts>.json`)

## RunPod (`runpod/`)

Lifecycle is strictly linear, never restart/reuse: create → wait `RUNNING` → work → `stop-pod` (stop, wait `EXITED`, terminate). `start-pod` refuses to run while `.active-pod.json` exists; `stop-pod` is safe to re-run (missing pod just clears the pointer). Pointer file is written immediately after create and deleted only after confirmed terminate — never delete it manually while a pod may be billable. Pod SSH details print at the end of `start-pod`;

## Logging (`logging/`, see `logging/README.md`)

- `logging/log-find-lambda.mjs`: AWS Lambda handler — `GET ?filename=<image-file>` looks up the run-log entry in DynamoDB (key: basename without extension). Needs `TABLE_NAME` (or `AWS_LOGS_TABLE_NAME`) on the Lambda.
- `logging/upload-log.mjs`: exports `uploadLog(logEntries)` — uploads each entry to DynamoDB (key: basename without extension, `data`: JSON-stringified entry). Called by `addToLog` after every `writeLog`; failures only `console.error`. Needs `TABLE_NAME` (or `AWS_LOGS_TABLE_NAME`).
- `logging/deploy-find-lambda.mjs` (`npm run deploy-find-lambda`): zips + publishes the lambda via `UpdateFunctionCodeCommand` (needs the `zip` binary; env: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_LOGS_FIND_LAMBDA_NAME`). Handler stays `<basename>.handler`.
- `comfyui/jobs/find-log-from-files.mjs` (`npm run find-log-from-files`): local lookup of a run-log entry by image filename under `output/logs/`.
- `logging/log-find-ui.html`: browser source UI (single file, `__LOG_FIND_LAMBDA_URL__` placeholder only — never the real URL).
- `logging/build-find-ui.mjs` (`npm run build-find-ui`): injects `LOG_FIND_LAMBDA_URL` from `.env` into `logging/dist/index.html` (gitignored).
- `logging/deploy-find-ui.mjs` (`npm run deploy-find-ui`): builds then uploads `logging/dist/index.html` via plain FTP (insecure, `basic-ftp` `secure: false` — provider cert is for `*.tarhely.com`, not the FTP hostname, so FTPS fails cert verification) to `LOG_FIND_UI_FTP_FOLDER`, overwriting `index.html`.
- `logging/temp-scripts/` holds one-off migration helpers (own README); excluded from vitest coverage. Vitest covers `logging/**/*.mjs` otherwise (`vitest.config.mjs`, per-file 90% line threshold).
