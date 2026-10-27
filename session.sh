# Local session commands for this project.
# Usage:  source ./session.sh
# Only affects the current shell session — nothing installed globally.

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Run with:  source ./session.sh"
  exit 1
fi

# Load extracted logic — all functions become available in this scope.
source "$(dirname "${BASH_SOURCE[0]}")/shell-scripts/runpod.sh"

echo "Registered: start-pod, stop-pod, comfy-batch <input-name>, flf <filepath>, runpod-comfy [-p <image-key>] -i <input1,..>, comfy -i <input1,..>"
