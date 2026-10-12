import "dotenv/config";
import path from "node:path";
import { requireWorkflows } from "./workflows/workflow.mjs";
import { requireConfig } from "./jobs/config.mjs";
import { requireInputName } from "./utils/args.mjs";
import { queuePrompt, waitForCompletion } from "./jobs/comfy.mjs";
import { saveOutputs } from "./jobs/save.mjs";
import { convertOutputs } from "./jobs/convert.mjs";
import { addToLog, writeLog } from "./jobs/log.mjs";
import { timestamp } from "./utils/naming.mjs";

const LOCAL_OUTPUT_PATH = path.join(import.meta.dirname, "..", "output");
const LOCAL_DIST_PATH = path.join(import.meta.dirname, "..", "dist");

const config = await requireConfig();
console.log(`ComfyUI server: ${config.server} (from ${config.serverSource})`);
const name = requireInputName();
const runTs = timestamp();
const logPath = path.join(LOCAL_OUTPUT_PATH, "logs", `${name}_${runTs}.json`);
const logEntries = [];
await writeLog(logPath, logEntries);

const jobs = await requireWorkflows(name);

for (let i = 0; i < jobs.length; i++) {
  console.log(`[${i + 1}/${jobs.length}] Running workflow...`);
  // Uncomment to see final workflow payload
  // console.log(JSON.stringify(jobs[i], null, 2));
  const ok = await runJob(jobs[i]);
  if (!ok) process.exit(1);
}

async function runJob(job) {
  try {
    const promptId = await queuePrompt(config.server, job.workflow);
    console.log(`Queued: ${promptId}`);
    const historyEntry = await waitForCompletion(config.server, promptId, {
      pollIntervalMs: config.pollIntervalMs,
    });
    const saved = await saveOutputs({
      server: config.server,
      destBaseDir: LOCAL_OUTPUT_PATH,
      input: job.input,
      historyEntry,
    });
    await addToLog({ logPath, logEntries, job, saved, promptId, historyEntry });
    await convertOutputs(saved, {
      outputBaseDir: LOCAL_OUTPUT_PATH,
      distBaseDir: LOCAL_DIST_PATH,
    });
    return true;
  } catch (err) {
    console.error(err.message);
    if (err.details) console.error(err.details);
    return false;
  }
}
