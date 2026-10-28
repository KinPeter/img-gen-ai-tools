import { describe, expect, it } from "vitest";
import {
  expandPrompts,
  expandBraceVariants,
} from "../../../comfyui/workflow-builder/prompts.mjs";

describe("prompts.mjs", () => {
  describe("expandPrompts", () => {
    it("returns empty array for empty input", () => {
      expect(expandPrompts([])).toEqual([]);
    });

    it("throws when item is missing prompts", () => {
      expect(() => expandPrompts([{ foo: "bar" }])).toThrow('"prompts" list');
    });

    it("throws when prompts is not an array", () => {
      expect(() => expandPrompts([{ prompts: "not-an-array" }])).toThrow(
        '"prompts" list',
      );
    });

    it("expands multiple prompt entries", () => {
      const result = expandPrompts([
        {
          prompts: [{ prompt: ["a"] }, { prompt: ["b"] }],
        },
      ]);
      expect(result).toHaveLength(2);
      expect(result[0].prompt).toEqual(["a"]);
      expect(result[1].prompt).toEqual(["b"]);
    });

    it("inherits parent-level fields into prompt entries", () => {
      const result = expandPrompts([
        {
          prompts: [{ prompt: ["a"] }],
          "base-workflow": "test",
          steps: 10,
        },
      ]);
      expect(result[0]["base-workflow"]).toBe("test");
      expect(result[0].steps).toBe(10);
      expect(result[0].prompt).toEqual(["a"]);
    });

    it("entry-level fields override parent-level fields", () => {
      const result = expandPrompts([
        {
          prompts: [{ prompt: ["a"], steps: 20 }],
          "base-workflow": "test",
          steps: 10,
        },
      ]);
      expect(result[0].steps).toBe(20);
    });

    it("validates prompt is a list", () => {
      expect(() =>
        expandPrompts([{ prompts: [{ prompt: "not-an-array" }] }]),
      ).toThrow('"prompt" must be a list');
    });

    it("validates negative-prompt is a list", () => {
      expect(() =>
        expandPrompts([{ prompts: [{ "negative-prompt": "not-an-array" }] }]),
      ).toThrow('"negative-prompt" must be a list');
    });
  });

  describe("expandBraceVariants", () => {
    it("returns single variant when no brace groups", () => {
      const result = expandBraceVariants({ prompt: ["hello world"] });
      expect(result).toEqual([{ prompt: ["hello world"] }]);
    });

    it("expands single brace group: 2 options", () => {
      const result = expandBraceVariants({ prompt: ["{red, blue} ball"] });
      expect(result).toHaveLength(2);
      expect(result[0].prompt).toEqual(["red ball"]);
      expect(result[1].prompt).toEqual(["blue ball"]);
    });

    it("expands multi-group brace: cartesian product", () => {
      const result = expandBraceVariants({
        prompt: ["{red, blue} {ball, cube}"],
      });
      expect(result).toHaveLength(4);
      expect(result[0].prompt).toEqual(["red ball"]);
      expect(result[1].prompt).toEqual(["red cube"]);
      expect(result[2].prompt).toEqual(["blue ball"]);
      expect(result[3].prompt).toEqual(["blue cube"]);
    });

    it("handles unbalanced braces gracefully", () => {
      const result = expandBraceVariants({ prompt: ["literal {unbalanced"] });
      expect(result).toHaveLength(1);
      expect(result[0].prompt).toEqual(["literal {unbalanced"]);
    });

    it("deletes fixed seed when multiple brace variants produced", () => {
      const result = expandBraceVariants({
        prompt: ["{red, blue} ball"],
        seed: 123,
      });
      expect(result).toHaveLength(2);
      expect(result[0].seed).toBeUndefined();
      expect(result[1].seed).toBeUndefined();
    });

    it("keeps seed when only one variant", () => {
      const result = expandBraceVariants({
        prompt: ["no braces"],
        seed: 123,
      });
      expect(result).toHaveLength(1);
      expect(result[0].seed).toBe(123);
    });

    it("handles mixed text with and without braces", () => {
      const result = expandBraceVariants({
        prompt: ["base", "{red, blue} {hat, scarf}"],
      });
      expect(result).toHaveLength(4);
      expect(result[0].prompt).toEqual(["base", "red hat"]);
      expect(result[1].prompt).toEqual(["base", "red scarf"]);
      expect(result[2].prompt).toEqual(["base", "blue hat"]);
      expect(result[3].prompt).toEqual(["base", "blue scarf"]);
    });

    it("handles braces in only one prompt part", () => {
      const result = expandBraceVariants({
        prompt: ["always this", "{red, blue}"],
      });
      expect(result).toHaveLength(2);
      expect(result[0].prompt).toEqual(["always this", "red"]);
      expect(result[1].prompt).toEqual(["always this", "blue"]);
    });

    it("handles empty brace group options", () => {
      const result = expandBraceVariants({ prompt: ["{,}"] });
      expect(result).toHaveLength(2);
      expect(result[0].prompt).toEqual([""]);
      expect(result[1].prompt).toEqual([""]);
    });

    it("handles nested brace syntax literally (not recursive)", () => {
      // The regex \{([^{}]*)\} matches the inner {c, d} (not the outer {b, {c, d}}
      // because [^{}]* can't cross brace boundaries).
      const result = expandBraceVariants({ prompt: ["a {b, {c, d}} e"] });
      expect(result).toHaveLength(2);
      expect(result[0].prompt).toEqual(["a {b, c} e"]);
      expect(result[1].prompt).toEqual(["a {b, d} e"]);
    });

    it("preserves non-prompt fields across variants", () => {
      const result = expandBraceVariants({
        prompt: ["{red, blue}"],
        steps: 20,
        "base-workflow": "test",
      });
      expect(result).toHaveLength(2);
      expect(result[0].steps).toBe(20);
      expect(result[0]["base-workflow"]).toBe("test");
      expect(result[1].steps).toBe(20);
      expect(result[1]["base-workflow"]).toBe("test");
    });
  });
});
