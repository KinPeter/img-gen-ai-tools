import {
  findNode,
  findPositiveClip,
  findNegativeClip,
  getRandomSeed,
} from "./utils.mjs";
import { applyLoras } from "./loras.mjs";

export function applyOverrides(workflow, item, forceRandomSeed) {
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

  if (item?.["clip-skip"] != null) {
    const clipSkip =
      findNode(workflow, "CLIPSetLastLayer") ?? workflow.ClipSkip_Base;
    if (clipSkip == null) {
      throw new Error(
        '"clip-skip" requires a CLIPSetLastLayer node in the base workflow',
      );
    }
    clipSkip.inputs.stop_at_clip_layer = item["clip-skip"];
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
