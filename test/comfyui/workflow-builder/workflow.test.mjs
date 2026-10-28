import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getFinalPositivePrompt,
  loadWorkflows,
  requireWorkflows,
} from "../../../comfyui/workflow-builder/workflow.mjs";

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
