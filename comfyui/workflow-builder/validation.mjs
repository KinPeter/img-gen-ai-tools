export function validateInput(data) {
  if (data == null) return;
  if (!Array.isArray(data)) return;

  for (const item of data) {
    if (!Array.isArray(item?.prompts)) {
      throw new Error(
        `Each input item must have a "prompts" list: ${JSON.stringify(item)}`,
      );
    }
  }
}

export function validatePromptArray(effective, fieldName) {
  if (effective[fieldName] == null) return;
  if (!Array.isArray(effective[fieldName])) {
    throw new Error(
      `"${fieldName}" must be a list of strings: ${JSON.stringify(effective)}`,
    );
  }
}

export function validateClipSkip(effective) {
  if (effective["clip-skip"] == null) return;
  if (
    typeof effective["clip-skip"] !== "number" ||
    !Number.isFinite(effective["clip-skip"])
  ) {
    throw new Error(
      `"clip-skip" must be a finite number: ${JSON.stringify(effective)}`,
    );
  }
}

export function validateLoras(effective) {
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
