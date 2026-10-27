import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const PROJECT_ROOT = path.join(import.meta.dirname, "..", "..");
const DEFAULT_INPUTS_DIR = path.join(PROJECT_ROOT, "comfyui", "inputs");
const WORKFLOWS_DIR = import.meta.dirname;

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

// Reads comfyui/inputs/<name>.yaml and returns one { workflow, input }
// pair per requested image. Base workflow JSON is loaded from the
// workflows folder; scalar overrides (steps/cfg/seed/size/filename-prefix)
// are applied only when set in the input. Prompt parts (a YAML list) are
// appended to the base positive prompt in list order; negative-prompt
// parts (a YAML list) are appended to the base negative prompt the
// same way. Prompt strings support {a, b} alternation: each brace
// group with comma-separated options expands to one variant per
// option, cartesian-producted across all groups in the entry's
// `prompt` list (negative-prompt is left literal).
export async function loadWorkflows(
  name,
  inputsDir = DEFAULT_INPUTS_DIR,
  workflowsDir = WORKFLOWS_DIR,
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
      const basePath = path.join(workflowsDir, fileName);
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

// Every top-level item shares its settings across a `prompts` list.
// Each list entry merges over the parent (per-prompt tries/seed/prompt/
// negative-prompt win), so the rest of the pipeline always sees plain
// effective items.
function expandPrompts(items) {
  const expanded = [];
  for (const item of items) {
    if (!Array.isArray(item?.prompts)) {
      throw new Error(
        `Each input item must have a "prompts" list: ${JSON.stringify(item)}`,
      );
    }
    const { prompts, ...parent } = item;
    for (const entry of prompts) {
      const effective = { ...parent, ...(entry ?? {}) };
      if (effective.prompt != null && !Array.isArray(effective.prompt)) {
        throw new Error(
          `"prompt" must be a list of strings: ${JSON.stringify(effective)}`,
        );
      }
      if (
        effective["negative-prompt"] != null &&
        !Array.isArray(effective["negative-prompt"])
      ) {
        throw new Error(
          `"negative-prompt" must be a list of strings: ${JSON.stringify(effective)}`,
        );
      }
      validateLoras(effective);
      for (const variant of expandBraceVariants(effective)) {
        expanded.push(variant);
      }
    }
  }
  return expanded;
}

// The `loras` key (absent = no LoRAs, valid) must be a non-empty list of
// { name, strength } entries when present. Validated on the effective item
// so it fails fast, before cloning/tries expansion.
function validateLoras(effective) {
  if (effective.loras == null) return;
  if (!Array.isArray(effective.loras)) {
    throw new Error(
      `"loras" must be a list of {name, strength} objects: ${JSON.stringify(effective)}`,
    );
  }
  if (effective.loras.length === 0) {
    throw new Error(
      `"loras" must contain at least one entry: ${JSON.stringify(effective)}`,
    );
  }
  for (const lora of effective.loras) {
    if (typeof lora !== "object" || lora == null || Array.isArray(lora)) {
      throw new Error(
        `Each "loras" entry must be a {name, strength} object: ${JSON.stringify(lora)}`,
      );
    }
    if (typeof lora.name !== "string" || lora.name.length === 0) {
      throw new Error(
        `"loras[].name" must be a non-empty string: ${JSON.stringify(lora)}`,
      );
    }
    if (typeof lora.strength !== "number" || !Number.isFinite(lora.strength)) {
      throw new Error(
        `"loras[].strength" must be a finite number: ${JSON.stringify(lora)}`,
      );
    }
  }
}

// Expands {a, b} alternations in an entry's `prompt` list. Every brace
// group contributes its comma-separated options (trimmed, empties
// kept so `{, beard}` means optional); variants are the cartesian
// product across all groups in document order. Unbalanced or nested
// braces are left literal. A fixed `seed` is dropped when one entry
// fans out to several variants so they don't all render identically.
function expandBraceVariants(effective) {
  const list = effective?.prompt;
  if (!Array.isArray(list) || list.length === 0) return [effective];

  const matchesPerPart = [];
  const allGroups = [];
  for (let idx = 0; idx < list.length; idx++) {
    const part = list[idx];
    if (typeof part !== "string") continue;
    const matches = [];
    const re = /\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(part)) !== null) {
      const options = m[1].split(",").map((s) => s.trim());
      matches.push({ start: m.index, end: m.index + m[0].length, options });
      allGroups.push(options);
    }
    if (matches.length > 0) matchesPerPart.push({ idx, matches });
  }
  if (allGroups.length === 0) return [effective];

  let combos = [[]];
  for (const options of allGroups) {
    const next = [];
    for (const prefix of combos) {
      for (const option of options) next.push([...prefix, option]);
    }
    combos = next;
  }

  return combos.map((combo) => {
    const newPrompt = [...list];
    let gi = 0;
    for (const { idx, matches } of matchesPerPart) {
      const orig = list[idx];
      let out = "";
      let last = 0;
      for (const mm of matches) {
        out += orig.slice(last, mm.start) + combo[gi++];
        last = mm.end;
      }
      out += orig.slice(last);
      newPrompt[idx] = out;
    }
    const variant = { ...effective, prompt: newPrompt };
    if (
      combos.length > 1 &&
      variant.seed != null &&
      variant.seed !== "random"
    ) {
      delete variant.seed;
    }
    return variant;
  });
}

export async function requireWorkflows(
  name,
  inputsDir = DEFAULT_INPUTS_DIR,
  workflowsDir = WORKFLOWS_DIR,
) {
  let workflows;
  try {
    workflows = await loadWorkflows(name, inputsDir, workflowsDir);
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

function findNode(workflow, classType) {
  for (const node of Object.values(workflow)) {
    if (node?.class_type === classType) return node;
  }
  return undefined;
}

function findNodeLabel(workflow, classType) {
  for (const [label, node] of Object.entries(workflow)) {
    if (node?.class_type === classType) return label;
  }
  return undefined;
}

function findPositiveClip(workflow, sampler) {
  const ref = sampler?.inputs?.positive?.[0];
  if (typeof ref === "string" && workflow[ref]) return workflow[ref];
  return workflow.PositiveCLIP_Base ?? findNode(workflow, "CLIPTextEncode");
}

function findNegativeClip(workflow, sampler) {
  const ref = sampler?.inputs?.negative?.[0];
  if (typeof ref === "string" && workflow[ref]) return workflow[ref];
  if (workflow.NegativeCLIP_Base) return workflow.NegativeCLIP_Base;
  const positive = findPositiveClip(workflow, sampler);
  for (const node of Object.values(workflow)) {
    if (node?.class_type === "CLIPTextEncode" && node !== positive) return node;
  }
  return undefined;
}

function applyOverrides(workflow, item, forceRandomSeed) {
  const sampler = findNode(workflow, "KSampler") ?? workflow.Sampler;
  const latent =
    findNode(workflow, "EmptyLatentImage") ?? workflow.EmptyLatentImage;
  const saveImage = findNode(workflow, "SaveImage") ?? workflow.SaveImage;

  if (item?.steps != null && sampler) sampler.inputs.steps = item.steps;
  if (item?.cfg != null && sampler) sampler.inputs.cfg = item.cfg;

  if (sampler) {
    if (!forceRandomSeed && item?.seed != null && item.seed !== "random") {
      sampler.inputs.seed = item.seed;
    } else {
      sampler.inputs.seed = getRandomSeed();
    }
  }

  if (item?.size?.width != null && latent)
    latent.inputs.width = item.size.width;
  if (item?.size?.height != null && latent)
    latent.inputs.height = item.size.height;

  if (item?.["filename-prefix"] != null && saveImage) {
    saveImage.inputs.filename_prefix = item["filename-prefix"];
  }

  const positiveClip = findPositiveClip(workflow, sampler);
  if (item?.prompt != null && positiveClip) {
    const parts = item.prompt
      .map((v) => String(v ?? "").trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const baseText = String(positiveClip.inputs.text ?? "").trim();
      positiveClip.inputs.text = baseText
        ? `${baseText}, ${parts.join(", ")}`
        : parts.join(", ");
    }
  }

  const negativeClip = findNegativeClip(workflow, sampler);
  if (item?.["negative-prompt"] != null && negativeClip) {
    const parts = item["negative-prompt"]
      .map((v) => String(v ?? "").trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const baseText = String(negativeClip.inputs.text ?? "").trim();
      negativeClip.inputs.text = baseText
        ? `${baseText}, ${parts.join(", ")}`
        : parts.join(", ");
    }
  }

  if (item?.loras != null) {
    applyLoras(workflow, item);
  }
}

// Builds a Lora_1..Lora_N LoraLoader chain from item.loras, inserts it right
// after the checkpoint node, and rewires pre-existing model (slot 0) and
// clip (slot 1) references from the checkpoint onto the last Lora node. Slot
// 2 (VAE) references and non-array inputs are left untouched, and the newly
// created Lora nodes are skipped by the rewire walk to avoid cycles.
function applyLoras(workflow, item) {
  const checkpointLabel = findNodeLabel(workflow, "CheckpointLoaderSimple");
  if (checkpointLabel === undefined) {
    throw new Error(
      '"loras" requires a CheckpointLoaderSimple node in the base workflow',
    );
  }
  const loras = item.loras;
  const labels = loras.map((_, i) => `Lora_${i + 1}`);
  for (const label of labels) {
    if (label in workflow) {
      throw new Error(
        `"loras" cannot be applied: the base workflow already defines a node labeled "${label}"`,
      );
    }
  }

  const newNodes = {};
  let prev = checkpointLabel;
  for (let i = 0; i < loras.length; i++) {
    const label = labels[i];
    newNodes[label] = {
      class_type: "LoraLoader",
      inputs: {
        model: [prev, 0],
        clip: [prev, 1],
        lora_name: loras[i].name,
        strength_model: loras[i].strength,
        strength_clip: loras[i].strength,
      },
    };
    prev = label;
  }

  // Rebuild the node object with the new Lora labels inserted immediately
  // after the checkpoint key (cosmetic — the API is order-independent).
  const originalKeys = Object.keys(workflow);
  const values = {};
  for (const key of originalKeys) values[key] = workflow[key];
  for (const key of originalKeys) delete workflow[key];
  const cpIndex = originalKeys.indexOf(checkpointLabel);
  for (let i = 0; i < originalKeys.length; i++) {
    const key = originalKeys[i];
    workflow[key] = values[key];
    if (i === cpIndex) {
      for (const label of labels) workflow[label] = newNodes[label];
    }
  }

  // Rewire pre-existing nodes only (the new Lora labels are not in
  // originalKeys, so they are naturally skipped).
  const lastLabel = labels[labels.length - 1];
  for (const key of originalKeys) {
    const inputs = values[key]?.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const [inputKey, value] of Object.entries(inputs)) {
      if (!Array.isArray(value) || value.length !== 2) continue;
      if (value[0] !== checkpointLabel) continue;
      if (value[1] === 0) inputs[inputKey] = [lastLabel, 0];
      else if (value[1] === 1) inputs[inputKey] = [lastLabel, 1];
    }
  }
}

function getRandomSeed() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}
