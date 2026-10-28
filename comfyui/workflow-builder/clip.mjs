import { findNode, findNodeByClass } from "./utils.mjs";

/**
 * Determine the clip source label for a ClipSkip_Base node.
 * Without LoRAs → checkpoint label; with LoRAs → last LoRA label (e.g. "Lora_2").
 */
export function findClipSourceLabel(workflow, loras, checkpointLabel) {
  if (loras && Array.isArray(loras) && loras.length > 0) {
    return `Lora_${loras.length}`;
  }
  return checkpointLabel;
}

/**
 * Create a ClipSkip_Base node and insert it after the checkpoint in the workflow.
 * The clip input always references the checkpoint (or last LoRA when LoRAs are
 * already applied).  Insertion always happens after the *checkpoint* so that
 * key order stays stable regardless of whether LoRAs are present.
 *
 * @param {object} workflow - The workflow object.
 * @param {number} clipSkipValue - The clip-skip value to set.
 * @param {string} clipSourceLabel - The node label that provides the clip input (checkpoint or last LoRA).
 * @param {string} checkpointLabel - The workflow key label of the checkpoint node (for key-order insertion).
 * @returns {string} The label used ("ClipSkip_Base").
 */
export function createClipSkipNode(
  workflow,
  clipSkipValue,
  clipSourceLabel,
  checkpointLabel,
) {
  const label = "ClipSkip_Base";

  const originalKeys = Object.keys(workflow);
  const values = {};
  for (const key of originalKeys) values[key] = workflow[key];
  for (const key of originalKeys) delete workflow[key];

  // Always insert after the checkpoint, never after the (possibly-loRA) clip source.
  const cpIndex = originalKeys.indexOf(checkpointLabel);

  for (let i = 0; i < originalKeys.length; i++) {
    const key = originalKeys[i];
    workflow[key] = values[key];
    if (i === cpIndex) {
      workflow[label] = {
        class_type: "CLIPSetLastLayer",
        inputs: {
          clip: [clipSourceLabel, 1],
          stop_at_clip_layer: clipSkipValue,
        },
      };
    }
  }
  return label;
}

/**
 * Rewire positive and negative clip nodes to read from clipSkipLabel.
 * Uses sampler inputs first, then falls back to node lookup.
 */
export function rewireClipsTo(wf, clipSkipLabel, sampler) {
  // Find positive clip node
  const posRef = sampler?.inputs?.positive?.[0];
  let posClip;
  if (typeof posRef === "string" && wf[posRef]) {
    posClip = wf[posRef];
  } else {
    // fallback: prefer PositiveCLIP_Base (matching findPositiveClip logic),
    // then general CLIPTextEncode lookup (ClipSkip_Base is CLIPSetLastLayer,
    // so findNodeByClass("CLIPTextEncode") won't return it)
    posClip =
      wf.PositiveCLIP_Base ?? findNodeByClass(wf, "CLIPTextEncode")?.node;
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

/**
 * Apply clip-skip override (create node if missing, override value if exists).
 * Expects LoRAs to already be applied (clip source must be correct).
 */
export function applyClipSkipOverride(
  workflow,
  clipSkipValue,
  loras,
  checkpointLabel,
  sampler,
) {
  const clipSkipNode = findNode(workflow, "CLIPSetLastLayer");
  if (clipSkipNode == null) {
    // ClipSkip_Base does NOT exist — CREATE it and rewire clips
    const clipSourceLabel = findClipSourceLabel(
      workflow,
      loras,
      checkpointLabel,
    );
    const clipSkipLabel = createClipSkipNode(
      workflow,
      clipSkipValue,
      clipSourceLabel,
      checkpointLabel,
    );
    rewireClipsTo(workflow, clipSkipLabel, sampler);
  } else {
    // ClipSkip_Base exists — just override the value (existing behavior)
    clipSkipNode.inputs.stop_at_clip_layer = clipSkipValue;
  }
}
