# Local session commands for this project.
# Usage (from the project folder):  source ./session.sh
# Only affects the current shell session - nothing is installed globally.

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Run with:  source ./session.sh"
  exit 1
fi

start-pod() { npm run start-pod -- "$@"; }
stop-pod() { npm run stop-pod; }
comfy-batch() { node comfyui/batch.mjs "$@"; }
flf() { node comfyui/jobs/find-log-from-files.mjs "$@"; }

# Shared batch loop — called by both comfy() and runpod-comfy().
# Uses the caller's 'interrupted' and 'failed' variables (declared as local -g).
# usage: _run_batches <csv_input_string>
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

# Full run: start a pod, batch each input, always stop the pod.
# Usage: runpod-comfy [-p <image-key>] -i <input1,input2,...>
#   Failed inputs don't stop the remaining ones, but the exit code
#   is non-zero if anything failed. stop-pod runs in every case
#   (batch failure, start-pod failure, Ctrl+C) so a pod never
#   keeps billing unattended.
runpod-comfy() {
  local opt pod_image="" inputs=""
  local OPTIND=1
  while getopts ":p:i:" opt; do
    case "$opt" in
      p) pod_image="$OPTARG" ;;
      i) inputs="$OPTARG" ;;
      :) echo "runpod-comfy: option -$OPTARG requires an argument." >&2; return 2 ;;
      \?) echo "runpod-comfy: invalid option -$OPTARG." >&2; return 2 ;;
    esac
  done
  if [[ -z "${inputs//[[:space:],]/}" ]]; then
    echo "Usage: runpod-comfy [-p <image-key>] -i <input1,input2,...>" >&2
    echo "  Starts a pod, runs batch for each input, always stops the pod." >&2
    return 2
  fi

  local -g interrupted=0
  local -g failed=()
  trap 'interrupted=1' INT TERM

  if [[ -n "$pod_image" ]]; then start-pod "$pod_image"; else start-pod; fi
  local status=$?
  if (( status != 0 )); then
    trap - INT TERM
    stop-pod # start-pod can fail after creating the pod; never leave it billing
    return "$status"
  fi

  _run_batches "$inputs"
  trap - INT TERM
  stop-pod
  local stop_status=$?
  if (( interrupted )); then
    echo "runpod-comfy: interrupted; pod stopped." >&2
    return 130
  fi
  if (( ${#failed[@]} > 0 )); then
    echo "runpod-comfy: failed inputs: ${failed[*]}" >&2
    return 1
  fi
  return "$stop_status"
}

echo "Registered: start-pod, stop-pod, comfy-batch <input-name>, flf <filepath>, runpod-comfy [-p <image-key>] -i <input1,..>, comfy -i <input1,..>"
