import { describe, expect, it, vi } from "vitest";
import {
  getFinalNegativePrompt,
  getFinalPositivePrompt,
  getFinalSeed,
  loadWorkflows,
} from "../../../comfyui/workflows/workflow.mjs";

describe("workflow expansion", () => {
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
});
