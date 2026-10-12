# RunPod tools (addition)

Standalone helpers for GPU pods; the batch script only consumes the pod's ComfyUI URL from the shared state file. Needs `RUNPOD_API_KEY`.

| Command                              | What it does                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run start-pod [-- <image-key>]` | picks cheapest suitable GPU from the catalog, creates a ComfyUI pod (`8188/http` + `22/tcp`, SSH enabled), saves the pointer to `runpod/.active-pod.json` immediately, waits for `RUNNING`, then polls the ComfyUI API (`/system_stats`) until it answers, prints the ComfyUI URL and SSH commands. Refuses to run while a pod is active. |
| `npm run stop-pod`                   | stops the active pod, waits for `EXITED`, terminates it, clears the pointer. Safe to re-run: already-gone pods just clear the pointer, failures keep it for retry.                                                                                                                                                                        |
| `node runpod/list-types.mjs`         | lists available GPU types (secure, in-stock, CUDA 12.8, under $1/hr), cheapest first. Importable as `listGpuTypes()` for other scripts.                                                                                                                                                                                                   |
| `npm run convert-all`                | converts every PNG under `output/` to `dist/` (manual re-runs, e.g. different settings).                                                                                                                                                                                                                                                  |

Pod lifecycle is strictly linear — pods are never restarted or reused: create → verify `RUNNING` + ComfyUI API ready → your work in another terminal → stop → terminate, always. The pointer file (`runpod/.active-pod.json`, gitignored) is written right after create and deleted only after a confirmed terminate, so a billing pod can never become untracked.

## Image map for `start-pod` scripts

You have to create a `pod-images.mjs` file in this folder with a `Map` constructor like this:

```javascript
export const POD_IMAGES = new Map([
  ["juggernaut", "username/my-juggernaut-image:1.0.0"],
  ["image-key", "username/docker-image-name:1.0.0"],
  // ...
]);
```

And then you can call `start-pod <docker-image-key>` to spin up a GPU pod with that image from docker.
