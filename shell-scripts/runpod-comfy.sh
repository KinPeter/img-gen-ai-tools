#!/usr/bin/env bash
# Local session helper — full managed workflow (pod + batch loop).
# Depends on: start-pod, stop-pod, comfy-batch, _run_batches (all from sourcing chain).
source "$(dirname "${BASH_SOURCE[0]}")/comfyui.sh"

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
