import {
  findNode,
  findNodeLabel,
  findPositiveClip,
  findNegativeClip,
  getRandomSeed,
} from "./utils.mjs";
import { applyLoras } from "./loras.mjs";
import { applyClipSkipOverride } from "./clip.mjs";

/**
 * Apply sampler-level overrides: steps, cfg, seed.
 */
function applySamplerOverrides(workflow, item, forceRandomSeed) {
  const sampler = findNode(workflow, "KSampler") ?? workflow.Sampler;
  if (!sampler) return;

  if (item?.steps != null) sampler.inputs.steps = item.steps;
  if (item?.cfg != null) sampler.inputs.cfg = item.cfg;

  if (!forceRandomSeed && item?.seed != null && item.seed !== "random") {
    sampler.inputs.seed = item.seed;
  } else {
    sampler.inputs.seed = getRandomSeed();
  }
}

/**
 * Apply latent-image size override.
 */
function applySizeOverrides(workflow, item) {
  const latent =
    findNode(workflow, "EmptyLatentImage") ?? workflow.EmptyLatentImage;
  if (!latent) return;

  if (item?.size?.width != null) latent.inputs.width = item.size.width;
  if (item?.size?.height != null) latent.inputs.height = item.size.height;
}

/**
 * Apply SaveImage filename-prefix override.
 */
function applyFilenamePrefixOverride(workflow, item) {
  const saveImage = findNode(workflow, "SaveImage") ?? workflow.SaveImage;
  if (!saveImage) return;

  if (item?.["filename-prefix"] != null) {
    saveImage.inputs.filename_prefix = item["filename-prefix"];
  }
}

/**
 * Append prompt strings to the positive CLIP node's text.
 */
function applyPositivePromptOverride(workflow, sampler, item) {
  const positiveClip = findPositiveClip(workflow, sampler);
  if (!positiveClip || item?.prompt == null) return;

  const parts = item.prompt.map((v) => String(v ?? "").trim()).filter(Boolean);
  if (parts.length === 0) return;

  const baseText = String(positiveClip.inputs.text ?? "").trim();
  positiveClip.inputs.text = baseText
    ? `${baseText}, ${parts.join(", ")}`
    : parts.join(", ");
}

/**
 * Append negative-prompt strings to the negative CLIP node's text.
 */
function applyNegativePromptOverride(workflow, sampler, item) {
  const negativeClip = findNegativeClip(workflow, sampler);
  if (!negativeClip || item?.["negative-prompt"] == null) return;

  const parts = item["negative-prompt"]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  if (parts.length === 0) return;

  const baseText = String(negativeClip.inputs.text ?? "").trim();
  negativeClip.inputs.text = baseText
    ? `${baseText}, ${parts.join(", ")}`
    : parts.join(", ");
}

/**
 * Apply all item-level overrides to a workflow clone.
 * Order matters: LoRAs are applied before clip-skip so the clip source is correct.
 */
export function applyOverrides(workflow, item, forceRandomSeed) {
  const sampler = findNode(workflow, "KSampler") ?? workflow.Sampler;

  applySamplerOverrides(workflow, item, forceRandomSeed);
  applySizeOverrides(workflow, item);
  applyFilenamePrefixOverride(workflow, item);
  applyPositivePromptOverride(workflow, sampler, item);
  applyNegativePromptOverride(workflow, sampler, item);

  if (item?.loras != null) {
    applyLoras(workflow, item);
  }

  if (item?.["clip-skip"] != null) {
    const checkpointLabel = findNodeLabel(workflow, "CheckpointLoaderSimple");
    applyClipSkipOverride(
      workflow,
      item["clip-skip"],
      item.loras,
      checkpointLabel,
      sampler,
    );
  }
}
