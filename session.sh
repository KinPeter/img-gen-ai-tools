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

# Full run: start a pod, batch each input, always stop the pod.
# Usage: comfy [-p <image-key>] -i <input1,input2,...>
#   Failed inputs don't stop the remaining ones, but the exit code
#   is non-zero if anything failed. stop-pod runs in every case
#   (batch failure, start-pod failure, Ctrl+C) so a pod never
#   keeps billing unattended.
comfy() {
  local opt pod_image="" inputs=""
  local OPTIND=1
  while getopts ":p:i:" opt; do
    case "$opt" in
      p) pod_image="$OPTARG" ;;
      i) inputs="$OPTARG" ;;
      :) echo "comfy: option -$OPTARG requires an argument." >&2; return 2 ;;
      \?) echo "comfy: invalid option -$OPTARG." >&2; return 2 ;;
    esac
  done
  if [[ -z "${inputs//[[:space:],]/}" ]]; then
    echo "Usage: comfy [-p <image-key>] -i <input1,input2,...>" >&2
    echo "  Starts a pod, runs batch for each input, always stops the pod." >&2
    return 2
  fi

  local status=0 interrupted=0 stop_status=0 name
  local -a names=() failed=()
  trap 'interrupted=1' INT TERM

  if [[ -n "$pod_image" ]]; then start-pod "$pod_image"; else start-pod; fi
  status=$?
  if (( status != 0 )); then
    trap - INT TERM
    stop-pod # start-pod can fail after creating the pod; never leave it billing
    return "$status"
  fi

  IFS=',' read -ra names <<< "$inputs"
  for name in "${names[@]}"; do
    name="${name//[[:space:]]/}"
    [[ -z "$name" ]] && continue
    if (( interrupted )); then status=130; break; fi
    if comfy-batch "$name"; then
      :
    else
      status=1
      failed+=("$name")
      (( interrupted )) && break
    fi
  done

  trap - INT TERM
  stop-pod
  stop_status=$?
  if (( interrupted )); then
    echo "comfy: interrupted; pod stopped." >&2
    return 130
  fi
  if (( ${#failed[@]} > 0 )); then
    echo "comfy: failed inputs: ${failed[*]}" >&2
    return 1
  fi
  return "$stop_status"
}

echo "Registered: start-pod, stop-pod, comfy-batch <input-name>, flf <filepath>, comfy [-p <image-key>] -i <input1,..>"
