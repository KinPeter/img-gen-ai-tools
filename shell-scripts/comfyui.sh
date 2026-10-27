#!/usr/bin/env bash
# Local session helper — ComfyUI-related commands and shared logic.
# Loaded by session.sh via runpod.sh.

# Run a single batch by input name (resolves from project root).
comfy-batch() { node "$(dirname "${BASH_SOURCE[0]}")/../comfyui/batch.mjs" "$@"; }

# Look up a run-log entry by image filename.
flf() { node "$(dirname "${BASH_SOURCE[0]}")/../comfyui/jobs/find-log-from-files.mjs" "$@"; }

# Shared batch loop — called by both comfy() and runpod-comfy().
# Modifies caller's 'interrupted' and 'failed' (declared as local -g in the caller).
_run_batches() {
  local inputs="$1" name
  local -a names=()
  IFS=',' read -ra names <<< "$inputs"
  for name in "${names[@]}"; do
    name="${name//[[:space:]]/}"
    [[ -z "$name" ]] && continue
    if (( interrupted )); then return 130; fi
    if ! comfy-batch "$name"; then
      failed+=("$name")
      (( interrupted )) && return 1
    fi
  done
  return 0
}

# Local batch loop: iterate over inputs, call comfy-batch for each.
# No pod management — just runs batches against whatever ComfyUI is already running.
# Usage: comfy -i <input1,input2,...>
comfy() {
  # Deprecation shim: forward 'comfy -p' to runpod-comfy.
  for arg in "$@"; do
    if [[ "$arg" == "-p" ]]; then
      echo "Warning: 'comfy -p' is deprecated; use 'runpod-comfy' instead." >&2
      runpod-comfy "$@"
      return
    fi
  done

  local inputs=""
  local OPTIND=1
  while getopts ":i:" opt; do
    case "$opt" in
      i) inputs="$OPTARG" ;;
      :) echo "comfy: option -$OPTARG requires an argument." >&2; return 2 ;;
      \?) echo "comfy: invalid option -$OPTARG." >&2; return 2 ;;
    esac
  done
  if [[ -z "${inputs//[[:space:],]/}" ]]; then
    echo "Usage: comfy -i <input1,input2,...>" >&2
    echo "  Runs batch for each input (no pod management)." >&2
    return 2
  fi

  local -g interrupted=0
  trap 'interrupted=1' INT TERM

  _run_batches "$inputs"
  local status=$?

  trap - INT TERM
  if (( interrupted )); then
    echo "comfy: interrupted; remaining inputs skipped." >&2
    return 130
  fi
  if (( ${#failed[@]} > 0 )); then
    echo "comfy: failed inputs: ${failed[*]}" >&2
    return 1
  fi
  return "$status"
}
