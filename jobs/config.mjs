import { readActivePod } from "../runpod/state.mjs";

export const DEFAULT_POLL_INTERVAL_MS = 5000;

export async function loadConfig(env = process.env) {
  let server = null;
  let serverSource = null;
  try {
    const comfyUrl = (await readActivePod())?.comfyUrl;
    if (comfyUrl != null && String(comfyUrl).trim() !== "") {
      server = String(comfyUrl).trim();
      serverSource = "pod";
    }
  } catch (err) {
    console.warn(`Ignoring unreadable pod state: ${err.message}`);
  }
  if (!server) {
    server = env.COMFY_SERVER;
    serverSource = "env";
  }
  if (!server) {
    throw new Error("Missing COMFY_SERVER in .env and no active pod state");
  }
  const pollIntervalMs =
    env.COMFY_POLL_INTERVAL_MS == null ||
    String(env.COMFY_POLL_INTERVAL_MS).trim() === ""
      ? DEFAULT_POLL_INTERVAL_MS
      : Number(env.COMFY_POLL_INTERVAL_MS);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("COMFY_POLL_INTERVAL_MS must be an integer >= 1");
  }
  return { server, serverSource, pollIntervalMs };
}

export async function requireConfig(env = process.env) {
  try {
    return await loadConfig(env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
