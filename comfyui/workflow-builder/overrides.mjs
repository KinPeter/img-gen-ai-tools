import {
  findNode,
  findNodeLabel,
  findPositiveClip,
  findNegativeClip,
  getRandomSeed,
} from "./utils.mjs";
import { applyLoras } from "./loras.mjs";

/**
 * Find a node by class_type and return { label, node } or null.
 */
function findNodeByClass(workflow, classType) {
  for (const [label, node] of Object.entries(workflow)) {
    if (node?.class_type === classType) return { label, node };
  }
  return null;
}

/**
 * Rewire positive and negative clip nodes to output from clipSkipNode.
 */
function rewireClipsTo(wf, clipSkipLabel, sampler) {
  // Find positive clip node
  const posRef = sampler?.inputs?.positive?.[0];
  let posClip;
  if (typeof posRef === "string" && wf[posRef]) {
    posClip = wf[posRef];
  } else {
    // fallback: look for any CLIPTextEncode (ClipSkip_Base is CLIPSetLastLayer,
    // so findNodeByClass("CLIPTextEncode") won't return it)
    posClip = findNodeByClass(wf, "CLIPTextEncode")?.node;
  }

  // Find negative clip node
  const negRef = sampler?.inputs?.negative?.[0];
  let negClip;
  if (typeof negRef === "string" && wf[negRef]) {
    negClip = wf[negRef];
  } else {
    // fallback: use NegativeCLIP_Base if present, else find a CLIPTextEncode
    // that's not the positive clip and not ClipSkip_Base
    negClip = wf.NegativeCLIP_Base;
    if (!negClip) {
      for (const [label, node] of Object.entries(wf)) {
        if (node?.class_type === "CLIPTextEncode" && label !== clipSkipLabel) {
          // Make sure it's not the positive clip
          if (node !== posClip) {
            negClip = node;
            break;
          }
        }
      }
    }
  }

  // Rewire found clips to point to ClipSkip_Base
  if (posClip) posClip.inputs.clip = [clipSkipLabel, 0];
  if (negClip) negClip.inputs.clip = [clipSkipLabel, 0];
}

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

  // Clip-skip override: after LoRAs so the clip source is correct.
  if (item?.["clip-skip"] != null) {
    let clipSkipNode = findNode(workflow, "CLIPSetLastLayer");
    if (clipSkipNode == null) {
      // CREATE ClipSkip_Base and rewire clips
      const checkpointLabel = findNodeLabel(workflow, "CheckpointLoaderSimple");
      const loras = item.loras;
      let clipSourceLabel = checkpointLabel;
      if (loras && Array.isArray(loras) && loras.length > 0) {
        clipSourceLabel = `Lora_${loras.length}`;
      }

      const clipSkipLabel = "ClipSkip_Base";

      // Insert ClipSkip_Base right after the checkpoint in the workflow object
      const originalKeys = Object.keys(workflow);
      const values = {};
      for (const key of originalKeys) values[key] = workflow[key];
      for (const key of originalKeys) delete workflow[key];
      const cpIndex = originalKeys.indexOf(checkpointLabel);
      for (let i = 0; i < originalKeys.length; i++) {
        const key = originalKeys[i];
        workflow[key] = values[key];
        if (i === cpIndex) {
          workflow[clipSkipLabel] = {
            class_type: "CLIPSetLastLayer",
            inputs: {
              clip: [clipSourceLabel, 1],
              stop_at_clip_layer: item["clip-skip"],
            },
          };
        }
      }

      // Rewire positive and negative clip nodes to point to ClipSkip_Base
      rewireClipsTo(workflow, clipSkipLabel, sampler);
    } else {
      // ClipSkip_Base exists — just override the value
      clipSkipNode.inputs.stop_at_clip_layer = item["clip-skip"];
    }
  }
}
