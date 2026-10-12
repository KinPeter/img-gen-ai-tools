import "dotenv/config";
import { listGpuTypes } from "./list-types.mjs";
import {
  createPodWithFallback,
  getPod,
  waitForStatus,
  waitForComfyReady,
} from "./pods.mjs";
import { readActivePod, writeActivePod } from "./state.mjs";
import { POD_TEMPLATE_IMAGE, ALLOWED_CUDA_VERSIONS } from "./common.mjs";
import { POD_IMAGES } from "./pod-images.mjs";
import { timestamp } from "../utils/naming.mjs";

const imageKey = process.argv[2];
let image = POD_TEMPLATE_IMAGE;
if (imageKey !== undefined) {
  if (!POD_IMAGES.has(imageKey)) {
    console.error(
      `Invalid image "${imageKey}". Valid options: ${[...POD_IMAGES.keys()].join(", ")}`,
    );
    process.exit(1);
  }
  image = POD_IMAGES.get(imageKey);
}

const apiKey = process.env.RUNPOD_API_KEY;
if (!apiKey) {
  console.error("Missing RUNPOD_API_KEY in .env");
  process.exit(1);
}

const existing = await readActivePod();
if (existing) {
  console.error(
    `Active pod ${existing.id} already exists — run "npm run stop-pod" first.`,
  );
  process.exit(1);
}

const types = await listGpuTypes().catch((err) => {
  console.error(`Could not list GPU types: ${err.message}`);
  process.exit(1);
});
if (types.length === 0) {
  console.error("No suitable GPU types currently available.");
  process.exit(1);
}

const name = `comfyui-${timestamp()}`;
let placed;
try {
  console.log(`Creating Pod with image ${image}...`);
  placed = await createPodWithFallback(apiKey, types, (gpu) => ({
    name,
    image,
    gpu: { id: gpu.id, count: 1, allowedCudaVersions: ALLOWED_CUDA_VERSIONS },
    ports: ["8188/http", "22/tcp"],
    disk: 150,
    startSsh: true,
  }));
} catch (err) {
  if (err.status === 422) {
    console.error(
      `Bad create request, not retrying: ${err.data?.errors ?? err.message}`,
    );
  } else if (err.status === 402) {
    console.error(`Insufficient balance, stopping: ${err.message}`);
  } else {
    console.error(
      `No GPU candidate could be placed. Last error: ${err.message}`,
    );
  }
  process.exit(1);
}

const { pod, gpu } = placed;
console.log(`\nCreated pod ${pod.id} on ${gpu.name} ($${gpu.price}/hr)`);

// Pointer file first: from here on the pod is tracked even if we get killed.
await writeActivePod({
  id: pod.id,
  name,
  gpu: gpu.name,
  createdAt: new Date().toISOString(),
});

let running;
try {
  running = await waitForStatus(apiKey, pod.id, "RUNNING");
} catch (err) {
  console.error(
    `${err.message}\nPod is left as-is — run "npm run stop-pod" to clean it up.`,
  );
  process.exit(1);
}

// Uncomment this to wait for direct SSH command if needed
// try {
//   running = await waitForDirectSsh(apiKey, pod.id);
// } catch (err) {
//   console.warn(`${err.message} — continuing with proxy SSH only.`);
// }

const comfyUrl = `https://${running.id}-8188.proxy.runpod.net`;

await writeActivePod({
  id: running.id,
  name: running.name,
  gpu: gpu.name,
  createdAt: new Date().toISOString(),
  comfyUrl,
  ssh: {
    proxy: running.ssh?.proxy?.command ?? null,
    direct: running.ssh?.direct?.command ?? null,
  },
});

try {
  await waitForComfyReady(comfyUrl, {
    getStatus: () => getPod(apiKey, running.id).then((pod) => pod.status),
  });
} catch (err) {
  console.error(
    `${err.message}\nPod is left as-is — run "npm run stop-pod" to clean it up.`,
  );
  process.exit(1);
}

console.log(`\n${running.gpu.id} Pod with ID ${running.id} is RUNNING.`);
console.log(`\nComfyUI is ready: ${comfyUrl}`);

if (running.ssh?.proxy?.command)
  console.log(`SSH (proxy):  ${running.ssh.proxy.command}`);
if (running.ssh?.direct?.command)
  console.log(`SSH (direct): ${running.ssh.direct.command}`);

console.log(`\nState saved. When done, run "npm run stop-pod".`);
