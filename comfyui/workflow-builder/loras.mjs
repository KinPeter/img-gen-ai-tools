import { findNodeLabel } from "./utils.mjs";

export function applyLoras(workflow, item) {
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
