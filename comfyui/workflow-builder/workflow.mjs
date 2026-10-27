import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { findNode, findPositiveClip, findNegativeClip } from "./utils.mjs";
import { validateInput } from "./validation.mjs";
import { expandPrompts } from "./prompts.mjs";
import { applyOverrides } from "./overrides.mjs";

const PROJECT_ROOT = path.join(import.meta.dirname, "..", "..");
const DEFAULT_INPUTS_DIR = path.join(PROJECT_ROOT, "comfyui", "inputs");
const WORKFLOWS_DIR = path.join(import.meta.dirname, "..", "workflows");

function inputPath(name, inputsDir) {
  return path.join(inputsDir, `${name}.yaml`);
}

// Project-relative label so messages stay cwd-independent and cannot drift
// from the resolved inputs base (default: comfyui/inputs/<name>.yaml).
function inputLabel(name, inputsDir) {
  return path
    .relative(PROJECT_ROOT, inputPath(name, inputsDir))
    .split(path.sep)
    .join("/");
}

export async function loadWorkflows(
  name,
  inputsDir = DEFAULT_INPUTS_DIR,
  workflowsDir_ = WORKFLOWS_DIR,
) {
  const yamlPath = inputPath(name, inputsDir);
  const text = await readFile(yamlPath, "utf8");
  let data;
  try {
    data = parse(text);
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${inputLabel(name, inputsDir)}: ${err.message}`,
      {
        cause: err,
      },
    );
  }

  validateInput(data);

  const items = expandPrompts(
    data == null ? [] : Array.isArray(data) ? data : [data],
  );
  const baseCache = new Map();
  const workflows = [];

  for (const item of items) {
    const baseName = item?.["base-workflow"];
    if (!baseName) {
      throw new Error(
        `Input item is missing "base-workflow": ${JSON.stringify(item)}`,
      );
    }
    const fileName = String(baseName).endsWith(".json")
      ? String(baseName)
      : `${baseName}.json`;
    if (!baseCache.has(fileName)) {
      const basePath = path.join(workflowsDir_, fileName);
      const baseText = await readFile(basePath, "utf8");
      baseCache.set(fileName, JSON.parse(baseText));
    }
    const base = baseCache.get(fileName);
    const tries = item?.tries == null ? 1 : Number(item.tries);
    if (!Number.isInteger(tries) || tries < 1) {
      throw new Error(
        `Invalid "tries" (must be an integer >= 1): ${JSON.stringify(item)}`,
      );
    }
    for (let t = 0; t < tries; t++) {
      const workflow = structuredClone(base);
      applyOverrides(workflow, item, tries > 1);
      workflows.push({ workflow, input: item });
    }
  }

  return workflows;
}

export async function requireWorkflows(
  name,
  inputsDir = DEFAULT_INPUTS_DIR,
  workflowsDir_ = WORKFLOWS_DIR,
) {
  let workflows;
  try {
    workflows = await loadWorkflows(name, inputsDir, workflowsDir_);
  } catch (err) {
    console.error(
      `Could not load ${inputLabel(name, inputsDir)}: ${err.message}`,
    );
    process.exit(1);
  }

  if (workflows.length === 0) {
    console.warn(
      `No workflows found in ${inputLabel(name, inputsDir)}, nothing to do.`,
    );
    process.exit(0);
  }

  return workflows;
}

export function getFinalSeed(workflow) {
  const sampler = findNode(workflow, "KSampler") ?? workflow.Sampler;
  return sampler?.inputs?.seed;
}

export function getFinalPositivePrompt(workflow) {
  const sampler = findNode(workflow, "KSampler") ?? workflow.Sampler;
  return findPositiveClip(workflow, sampler)?.inputs?.text;
}

export function getFinalNegativePrompt(workflow) {
  const sampler = findNode(workflow, "KSampler") ?? workflow.Sampler;
  return findNegativeClip(workflow, sampler)?.inputs?.text;
}
