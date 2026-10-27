import {
  validatePromptArray,
  validateClipSkip,
  validateLoras,
} from "./validation.mjs";

export function expandPrompts(items) {
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
      validatePromptArray(effective, "prompt");
      validatePromptArray(effective, "negative-prompt");
      validateClipSkip(effective);
      validateLoras(effective);
      for (const variant of expandBraceVariants(effective)) {
        expanded.push(variant);
      }
    }
  }
  return expanded;
}

export function expandBraceVariants(effective) {
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
