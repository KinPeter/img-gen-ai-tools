import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { uploadLog } from "../../logging/upload-log.mjs";
import {
  getFinalSeed,
  getFinalPositivePrompt,
  getFinalNegativePrompt,
} from "../workflows/workflow.mjs";

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function generationTimeMs(historyEntry) {
  const messages = historyEntry?.status?.messages ?? [];
  const at = (type) => messages.find((m) => m?.[0] === type)?.[1]?.timestamp;
  const start = at("execution_start");
  const end = at("execution_success");
  return start != null && end != null ? end - start : null;
}

export function buildLogEntry({
  input,
  finalSeed,
  finalPrompt,
  finalNegativePrompt,
  filename,
  outputPath,
  elapsedMs,
  comfyJobId,
}) {
  return {
    prompt: {
      ...input,
      seed: finalSeed,
      prompt: finalPrompt,
      "negative-prompt": finalNegativePrompt,
    },
    filename,
    outputPath,
    generatedIn: elapsedMs == null ? null : formatDuration(elapsedMs),
    comfyJobId,
  };
}

export async function writeLog(logPath, entries) {
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, JSON.stringify(entries, null, 2));
}

export async function addToLog({
  logPath,
  logEntries,
  job,
  saved,
  promptId,
  historyEntry,
}) {
  const elapsedMs = generationTimeMs(historyEntry);
  const finalSeed = getFinalSeed(job.workflow);
  const finalPrompt = getFinalPositivePrompt(job.workflow);
  const finalNegativePrompt = getFinalNegativePrompt(job.workflow);
  const newEntries = [];
  for (const file of saved) {
    const entry = buildLogEntry({
      input: job.input,
      finalSeed,
      finalPrompt,
      finalNegativePrompt,
      filename: file.filename,
      outputPath: file.destDir,
      elapsedMs,
      comfyJobId: promptId,
    });
    logEntries.push(entry);
    newEntries.push(entry);
  }
  await writeLog(logPath, logEntries);
  if (newEntries.length > 0) {
    try {
      await uploadLog(newEntries);
    } catch (error) {
      console.error(`Log upload failed: ${error?.message ?? error}`);
    }
  }
  return logEntries;
}
