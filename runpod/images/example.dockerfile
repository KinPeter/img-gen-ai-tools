# Base image from RunPod
FROM runpod/comfyui:1.3.3-comfyuiv0.30.0-cuda12.8

# Path to copy models on the VM
ARG MODELS=/workspace/runpod-slim/ComfyUI/models

# Copy models, LoRAs, etc from the local ./models/ folder to the image
COPY models/<base-model>.safetensors $MODELS/checkpoints/
COPY models/<lora-1>.safetensors $MODELS/loras/
COPY models/<lora-2>.safetensors $MODELS/loras/