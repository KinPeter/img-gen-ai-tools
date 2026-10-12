import { writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  getFinalNegativePrompt,
  getFinalPositivePrompt,
  getFinalSeed,
  loadWorkflows,
  requireWorkflows,
} from "../../../comfyui/workflows/workflow.mjs";

describe("workflow expansion", () => {
  async function withInput(text, callback) {
    const name = `coverage-${randomUUID()}`;
    const file = new URL(`../../../inputs/${name}.yaml`, import.meta.url);
    await writeFile(file, text);
    try {
      return await callback(name);
    } finally {
      await rm(file);
    }
  }

  it("rejects malformed YAML, missing prompts, invalid tries and LoRA values", async () => {
    for (const [text, message] of [
      ["prompts: [", "Invalid YAML"],
      ["base-workflow: juggernaut-simple-base", '"prompts" list'],
      ["prompts: [{}]", 'missing "base-workflow"'],
      [
        "base-workflow: juggernaut-simple-base\nprompts: [{tries: 0}]",
        'Invalid "tries"',
      ],
      [
        "base-workflow: juggernaut-simple-base\nprompts: [{prompt: text}]",
        '"prompt" must be a list',
      ],
      [
        "base-workflow: juggernaut-simple-base\nprompts: [{negative-prompt: text}]",
        '"negative-prompt" must be a list',
      ],
      [
        "base-workflow: juggernaut-simple-base\nprompts: [{lora-strengths: text}]",
        '"lora-strengths" must be a list',
      ],
      [
        "base-workflow: juggernaut-simple-base\nprompts: [{lora-strengths: [1]}]",
        "LoraLoader nodes",
      ],
      [
        "base-workflow: juggernaut-cyberpunk-neon-lora\nprompts: [{lora-strengths: [bad, 1]}]",
        "entries must be numbers",
      ],
    ]) {
      await withInput(text, async (name) => {
        await expect(loadWorkflows(name)).rejects.toThrow(message);
      });
    }
  });

  it("expands brace groups, inherits overrides, and preserves a single fixed seed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await withInput(
      `base-workflow: juggernaut-simple-base
steps: 4
cfg: 5
size: {width: 512, height: 768}
filename-prefix: test
seed: 123
prompts:
  - prompt: ["{red, blue} {hat, scarf}"]
  - prompt: ["literal {unbalanced"]
    tries: 1
    seed: 42
`,
      async (name) => {
        const jobs = await loadWorkflows(name);
        expect(jobs).toHaveLength(5);
        expect(
          jobs.slice(0, 4).map((job) => getFinalPositivePrompt(job.workflow)),
        ).toEqual(
          expect.arrayContaining([
            expect.stringContaining("red hat"),
            expect.stringContaining("blue scarf"),
          ]),
        );
        expect(jobs[0].input.seed).toBeUndefined();
        expect(getFinalSeed(jobs[4].workflow)).toBe(42);
        expect(
          Object.values(jobs[4].workflow).find(
            (node) => node.class_type === "KSampler",
          ).inputs.steps,
        ).toBe(4);
        expect(
          Object.values(jobs[4].workflow).find(
            (node) => node.class_type === "EmptyLatentImage",
          ).inputs.height,
        ).toBe(768);
      },
    );
  });
  it("expands alternatives and applies overrides", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const jobs = await loadWorkflows("input.example");
    expect(jobs.length).toBeGreaterThan(4);
    expect(getFinalPositivePrompt(jobs[0].workflow)).toContain("black hair");
    expect(getFinalSeed(jobs[0].workflow)).toBe(
      Math.floor(0.25 * Number.MAX_SAFE_INTEGER),
    );
    expect(jobs[0].workflow.EmptyLatentImage.inputs.width).toBe(832);
    const negativeJob = jobs.find((job) => job.input["negative-prompt"]);
    expect(getFinalNegativePrompt(negativeJob.workflow)).toContain("insects");
  });

  it("rejects missing input files", async () => {
    await expect(loadWorkflows("does-not-exist")).rejects.toThrow();
  });

  it("reports missing and empty workflow input through the CLI helper", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(requireWorkflows("does-not-exist")).rejects.toThrow("exit 1");
    await withInput("", async (name) => {
      await expect(requireWorkflows(name)).rejects.toThrow("exit 0");
    });
    expect(exit).toHaveBeenCalledWith(0);
  });
});
