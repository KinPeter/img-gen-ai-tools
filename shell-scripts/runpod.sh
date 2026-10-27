#!/usr/bin/env bash
# Local session helper — RunPod pod lifecycle.
# Sources runpod-comfy.sh so all commands are registered together.
source "$(dirname "${BASH_SOURCE[0]}")/runpod-comfy.sh"

start-pod() { npm run start-pod -- "$@"; }
stop-pod()  { npm run stop-pod; }
