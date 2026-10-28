export function findNode(workflow, classType) {
  for (const node of Object.values(workflow)) {
    if (node?.class_type === classType) return node;
  }
  return undefined;
}

export function findNodeLabel(workflow, classType) {
  for (const [label, node] of Object.entries(workflow)) {
    if (node?.class_type === classType) return label;
  }
  return undefined;
}

export function findPositiveClip(workflow, sampler) {
  const ref = sampler?.inputs?.positive?.[0];
  if (typeof ref === "string" && workflow[ref]) return workflow[ref];
  return workflow.PositiveCLIP_Base ?? findNode(workflow, "CLIPTextEncode");
}

export function findNegativeClip(workflow, sampler) {
  const ref = sampler?.inputs?.negative?.[0];
  if (typeof ref === "string" && workflow[ref]) return workflow[ref];
  if (workflow.NegativeCLIP_Base) return workflow.NegativeCLIP_Base;
  const positive = findPositiveClip(workflow, sampler);
  for (const node of Object.values(workflow)) {
    if (node?.class_type === "CLIPTextEncode" && node !== positive) return node;
  }
  return undefined;
}

export function getRandomSeed() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/**
 * Find a node by class_type and return { label, node } or undefined.
 */
export function findNodeByClass(workflow, classType) {
  for (const [label, node] of Object.entries(workflow)) {
    if (node?.class_type === classType) return { label, node };
  }
  return undefined;
}
