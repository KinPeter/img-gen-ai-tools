import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getFinalNegativePrompt,
  getFinalPositivePrompt,
  getFinalSeed,
  loadWorkflows,
  requireWorkflows,
} from "../../../comfyui/workflows/workflow.mjs";

describe("workflow expansion", () => {
  // Every fixture gets its own throwaway temp "inputs" tree (injected into
  // loadWorkflows/requireWorkflows), so tests never touch real
  // comfyui/inputs data and work in a clean checkout.
  async function withInput(text, callback, subdir = "") {
    const root = await mkdtemp(path.join(tmpdir(), "comfy-inputs-"));
    const inputsDir = path.join(root, "inputs");
    const dir = subdir ? path.join(inputsDir, ...subdir.split("/")) : inputsDir;
    await mkdir(dir, { recursive: true });
    const name = `coverage-${randomUUID()}`;
    await writeFile(path.join(dir, `${name}.yaml`), text);
    try {
      return await callback(subdir ? `${subdir}/${name}` : name, inputsDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("rejects malformed YAML, missing prompts and invalid tries", async () => {
    for (const [text, message] of [
      ["prompts: [", "Invalid YAML"],
      ["base-workflow: example-base-workflow", '"prompts" list'],
      ["prompts: [{}]", 'missing "base-workflow"'],
      [
        "base-workflow: example-base-workflow\nprompts: [{tries: 0}]",
        'Invalid "tries"',
      ],
      [
        "base-workflow: example-base-workflow\nprompts: [{prompt: text}]",
        '"prompt" must be a list',
      ],
      [
        "base-workflow: example-base-workflow\nprompts: [{negative-prompt: text}]",
        '"negative-prompt" must be a list',
      ],
    ]) {
      await withInput(text, async (name, inputsDir) => {
        await expect(loadWorkflows(name, inputsDir)).rejects.toThrow(message);
      });
    }
  });

  it("expands brace groups, inherits overrides, and preserves a single fixed seed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await withInput(
      `base-workflow: example-base-workflow
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
      async (name, inputsDir) => {
        const jobs = await loadWorkflows(name, inputsDir);
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

  it("loads inputs from a configurable base, including archive subfolders", async () => {
    await withInput(
      "base-workflow: example-base-workflow\nprompts: [{prompt: [moved]}]\n",
      async (name, inputsDir) => {
        const jobs = await loadWorkflows(name, inputsDir);
        expect(getFinalPositivePrompt(jobs[0].workflow)).toContain("moved");
      },
    );
    await withInput(
      "base-workflow: example-base-workflow\nprompts: [{prompt: [archived]}]\n",
      async (name, inputsDir) => {
        const jobs = await loadWorkflows(name, inputsDir);
        expect(getFinalPositivePrompt(jobs[0].workflow)).toContain("archived");
      },
      "archive",
    );
  });

  it("resolves the default input base from the project, not the cwd", async () => {
    // input.example.yaml ships only in comfyui/inputs/; reverting the default
    // base to the old root inputs/ makes this reject with ENOENT.
    const jobs = await loadWorkflows("input.example");
    expect(jobs.length).toBeGreaterThan(0);
  });

  it("rejects missing input files", async () => {
    await expect(loadWorkflows("does-not-exist")).rejects.toThrow();
  });

  it("reports missing and empty workflow input through the CLI helper", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(requireWorkflows("does-not-exist")).rejects.toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("comfyui/inputs/does-not-exist.yaml"),
    );
    await withInput("", async (name, inputsDir) => {
      await expect(requireWorkflows(name, inputsDir)).rejects.toThrow("exit 0");
    });
    expect(exit).toHaveBeenCalledWith(0);
  });
});
