import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

export const ACTIVE_POD_PATH =
  process.env.RUNPOD_STATE_PATH ?? path.join(import.meta.dirname, ".active-pod.json");

export async function readActivePod() {
  try {
    return JSON.parse(await readFile(ACTIVE_POD_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`Could not read pod state: ${err.message}`);
  }
}

export async function writeActivePod(state) {
  await writeFile(ACTIVE_POD_PATH, JSON.stringify(state, null, 2));
}

export async function clearActivePod() {
  await rm(ACTIVE_POD_PATH, { force: true });
}
