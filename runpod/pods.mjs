const API_BASE = "https://api.runpod.io";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiKeyOf(apiKey) {
  const key = apiKey ?? process.env.RUNPOD_API_KEY;
  if (!key) throw new Error("Missing RUNPOD_API_KEY in .env");
  return key;
}

async function request(apiKey, path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKeyOf(apiKey)}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || `Runpod API error: ${res.status}`);
    err.status = res.status;
    err.data = data;
    err.retryAfter = res.headers.get("Retry-After");
    throw err;
  }
  return data;
}

export async function createPod(apiKey, body) {
  return request(apiKey, "/v2/pods", { method: "POST", body });
}

export async function getPod(apiKey, id) {
  return request(apiKey, `/v2/pods/${id}`);
}

export async function podAction(apiKey, id, action) {
  return request(apiKey, `/v2/pods/${id}/action`, {
    method: "POST",
    body: { action },
  });
}

export async function waitForStatus(
  apiKey,
  id,
  target,
  { pollMs = 3000, timeoutMs = 15 * 60 * 1000 } = {},
) {
  const start = Date.now();
  while (true) {
    const pod = await getPod(apiKey, id);
    if (pod.status === target) return pod;
    console.log(`Pod status: ${pod.status}...`);
    if (pod.status === "ERROR" && target !== "EXITED") {
      throw new Error(`Pod ${id} entered ERROR state`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for pod ${id} to reach ${target} (still ${pod.status})`,
      );
    }
    await sleep(pollMs);
  }
}

export async function waitForDirectSsh(
  apiKey,
  id,
  { pollMs = 1000, timeoutMs = 60 * 1000 } = {},
) {
  const start = Date.now();
  while (true) {
    const pod = await getPod(apiKey, id);
    if (pod.ssh?.direct?.command) return pod;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for direct SSH mapping on pod ${id}`);
    }
    await sleep(pollMs);
  }
}

// Polls the ComfyUI HTTP API until it answers. Pod RUNNING only means the
// container is healthy, so this is the definitive "ComfyUI is up" signal.
// Any fetch failure or non-2xx status counts as not-ready. getStatus is an
// optional async () => pod.status used to fail fast if the pod dies.
export async function waitForComfyReady(
  comfyUrl,
  { pollMs = 5000, timeoutMs = 15 * 60 * 1000, getStatus } = {},
) {
  const base = String(comfyUrl).replace(/\/+$/, "");
  const url = `${base}/system_stats`;
  console.log(`Waiting for ComfyUI at ${base}...`);
  const start = Date.now();
  while (true) {
    if (getStatus) {
      const status = await getStatus();
      if (
        status === "ERROR" ||
        status === "EXITED" ||
        status === "TERMINATED"
      ) {
        throw new Error(
          `Pod entered ${status} state while waiting for ComfyUI`,
        );
      }
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
      console.log(`Waiting for ComfyUI (HTTP ${res.status})...`);
    } catch (err) {
      console.log(`ComfyUI API threw an error: (${err.message})...`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ComfyUI at ${base}`);
    }
    await sleep(pollMs);
  }
}

function retryAfterMs(err, attempt) {
  const header = Number(err.retryAfter);
  if (Number.isFinite(header) && header >= 0) return header * 1000;
  return 2 ** attempt * 1000;
}

// Tries each GPU in order (cheapest first). 429/5xx are retried in place,
// 400/403 move to the next candidate, 422/402 abort immediately.
export async function createPodWithFallback(
  apiKey,
  gpuTypes,
  makeBody,
  { attempts = 5 } = {},
) {
  let lastErr = null;
  for (const gpu of gpuTypes) {
    console.log(`\n---\nTrying ${gpu.id}...`);
    for (let a = 0; a <= attempts; a++) {
      try {
        return { pod: await createPod(apiKey, makeBody(gpu)), gpu };
      } catch (err) {
        lastErr = err;
        if ((err.status === 429 || err.status >= 500) && a < attempts) {
          await sleep(retryAfterMs(err, a));
          continue;
        }
        break;
      }
    }
    if (lastErr?.status === 422 || lastErr?.status === 402) throw lastErr;
    console.warn(`Skipping ${gpu.id}: ${lastErr?.message}`);
  }
  throw lastErr ?? new Error("No GPU candidates to try");
}
