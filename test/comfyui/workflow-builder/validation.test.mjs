import { describe, expect, it } from "vitest";
import {
  validateInput,
  validatePromptArray,
  validateClipSkip,
  validateLoras,
} from "../../../comfyui/workflow-builder/validation.mjs";

describe("validation.mjs", () => {
  describe("validateInput", () => {
    it("allows null and non-array data", () => {
      expect(validateInput(null)).toBeUndefined();
      expect(validateInput({})).toBeUndefined();
      expect(validateInput("string")).toBeUndefined();
    });

    it("allows valid array of items with prompts", () => {
      expect(
        validateInput([{ prompts: [{ prompt: ["hello"] }] }]),
      ).toBeUndefined();
      expect(validateInput([])).toBeUndefined();
    });

    it("throws when item is missing prompts list", () => {
      expect(() => validateInput([{ foo: "bar" }])).toThrow('"prompts" list');
    });

    it("throws when item prompts is not an array", () => {
      expect(() => validateInput([{ prompts: "not-an-array" }])).toThrow(
        '"prompts" list',
      );
    });
  });

  describe("validatePromptArray", () => {
    it("allows missing field", () => {
      expect(validatePromptArray({}, "prompt")).toBeUndefined();
    });

    it("allows valid array of strings", () => {
      expect(
        validatePromptArray({ prompt: ["hello", "world"] }, "prompt"),
      ).toBeUndefined();
    });

    it("throws when field is not an array", () => {
      expect(() =>
        validatePromptArray({ prompt: "not-an-array" }, "prompt"),
      ).toThrow('"prompt" must be a list');
    });
  });

  describe("validateClipSkip", () => {
    it("allows missing field", () => {
      expect(validateClipSkip({})).toBeUndefined();
    });

    it("allows valid finite numbers", () => {
      expect(validateClipSkip({ "clip-skip": -1 })).toBeUndefined();
      expect(validateClipSkip({ "clip-skip": 0 })).toBeUndefined();
      expect(validateClipSkip({ "clip-skip": 2 })).toBeUndefined();
    });

    it("throws when clip-skip is not a number", () => {
      expect(() => validateClipSkip({ "clip-skip": "abc" })).toThrow(
        '"clip-skip" must be a finite number',
      );
    });

    it("throws when clip-skip is NaN or Infinity", () => {
      expect(() => validateClipSkip({ "clip-skip": NaN })).toThrow(
        '"clip-skip" must be a finite number',
      );
      expect(() => validateClipSkip({ "clip-skip": Infinity })).toThrow(
        '"clip-skip" must be a finite number',
      );
      expect(() => validateClipSkip({ "clip-skip": -Infinity })).toThrow(
        '"clip-skip" must be a finite number',
      );
    });
  });

  describe("validateLoras", () => {
    it("allows missing field", () => {
      expect(validateLoras({})).toBeUndefined();
    });

    it("throws when loras is not an array", () => {
      expect(() => validateLoras({ loras: "text" })).toThrow(
        '"loras" must be a list',
      );
    });

    it("throws when loras is empty", () => {
      expect(() => validateLoras({ loras: [] })).toThrow(
        '"loras" must contain at least one entry',
      );
    });

    it("throws when loras entries are not objects", () => {
      expect(() => validateLoras({ loras: [42] })).toThrow(
        'Each "loras" entry must be a {name, strength} object',
      );
    });

    it("throws when lora name is not a non-empty string", () => {
      expect(() => validateLoras({ loras: [{ strength: 1 }] })).toThrow(
        '"loras[].name" must be a non-empty string',
      );
      expect(() =>
        validateLoras({ loras: [{ name: 123, strength: 1 }] }),
      ).toThrow('"loras[].name" must be a non-empty string');
    });

    it("throws when lora strength is not a finite number", () => {
      expect(() =>
        validateLoras({ loras: [{ name: "a.safetensors", strength: "0.5" }] }),
      ).toThrow('"loras[].strength" must be a finite number');
      expect(() =>
        validateLoras({
          loras: [{ name: "a.safetensors", strength: Infinity }],
        }),
      ).toThrow('"loras[].strength" must be a finite number');
    });

    it("allows valid lora entries", () => {
      expect(
        validateLoras({ loras: [{ name: "a.safetensors", strength: 0.5 }] }),
      ).toBeUndefined();
      expect(
        validateLoras({
          loras: [
            { name: "a.safetensors", strength: 0.5 },
            { name: "b.safetensors", strength: 1 },
          ],
        }),
      ).toBeUndefined();
    });
  });
});
