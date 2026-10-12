# Custom docker images

Custom images based on the official RunPod image templates with added models, LoRAs and other extras.

## Building and publishing new images

All models and other extra files that you want to add to the image need to be in the `runpod/images/models/` folder.
Example below to build a new image and publish it to Docker Hub. (Do `docker login` first if not authenticated.)
You have to be in the `runpod/images/` folder to run these commands.

```
docker buildx build --platform linux/amd64 -f juggernaut-cyberpunk.dockerfile -t kinp/crazy-beaver:1.0.0 --push .
```

## Using the custom images to start up Pods

The list of available images have to be updated in the `runpod/pod-images.mjs` file.

## Trying the image locally before pushing it

Use these commands instead:

```
# build and load the image:
docker buildx build --platform linux/amd64 -f juggernaut-cyberpunk.dockerfile -t kinp/crazy-beaver:1.0.0 --push .

# confirm layers
docker history kinp/crazy-beaver:1.0.0

# confirm the model is copied properly
docker run --rm --entrypoint ls kinp/crazy-beaver:1.0.0 /workspace/runpod-slim/ComfyUI/models/checkpoints

# push when ready
docker push kinp/crazy-beaver:1.0.0
```
