const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withDetails(message, data) {
  return Object.assign(new Error(message), {
    details: JSON.stringify(data, null, 2),
  });
}

export async function queuePrompt(server, workflow) {
  const res = await fetch(`${server}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw withDetails("ComfyUI rejected the request:", data);
  }

  return data.prompt_id;
}

export async function waitForCompletion(
  server,
  promptId,
  { pollIntervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS } = {},
) {
  const started = Date.now();
  while (true) {
    await sleep(pollIntervalMs);
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for job ${promptId}`);
    }
    const response = await fetch(`${server}/history/${promptId}`);
    if (!response.ok) {
      throw new Error(
        `Could not fetch history for ${promptId}: ${response.status} ${response.statusText}`,
      );
    }
    const history = await response.json();
    const historyEntry = history[promptId];
    if (!historyEntry) continue; // still queued or running
    if (historyEntry.status?.status_str !== "success") {
      throw withDetails("Job failed:", historyEntry.status);
    }
    return historyEntry;
  }
}

export async function fetchImage(server, { filename, subfolder, type }) {
  const qs = new URLSearchParams({
    filename,
    subfolder: subfolder ?? "",
    type: type ?? "output",
  });
  const res = await fetch(`${server}/view?${qs}`);
  if (!res.ok) {
    throw new Error(
      `Could not fetch image ${filename}: ${res.status} ${res.statusText}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}
