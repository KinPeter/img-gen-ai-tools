import "dotenv/config";
import { getPod, podAction, waitForStatus } from "./pods.mjs";
import { readActivePod, clearActivePod } from "./state.mjs";

const apiKey = process.env.RUNPOD_API_KEY;
if (!apiKey) {
  console.error("Missing RUNPOD_API_KEY in .env");
  process.exit(1);
}

const state = await readActivePod();
if (!state) {
  console.log("No active pod, nothing to do.");
  process.exit(0);
}

try {
  let pod;
  try {
    pod = await getPod(apiKey, state.id);
  } catch (err) {
    if (err.status === 404) {
      await clearActivePod();
      console.log(`Pod ${state.id} is already gone. Pointer cleared.`);
      process.exit(0);
    }
    throw err;
  }

  if (pod.actions?.includes("stop")) {
    console.log(`Stopping pod ${pod.id} (${pod.status})...`);
    await podAction(apiKey, pod.id, "stop");
    pod = await waitForStatus(apiKey, pod.id, "EXITED", {
      timeoutMs: 5 * 60 * 1000,
    });
    console.log(`Pod ${pod.id} EXITED.`);
  } else {
    console.log(`Pod ${pod.id} is ${pod.status}, skipping stop.`);
  }

  await podAction(apiKey, pod.id, "terminate");
  await clearActivePod();
  console.log(`Terminated pod ${pod.id}. Pointer cleared.`);
} catch (err) {
  console.error(`stop-pod failed: ${err.message}`);
  console.error(
    "Pointer kept so you can retry. Check status manually if needed.",
  );
  process.exit(1);
}
