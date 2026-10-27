import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    server: "http://comfy.test",
    serverSource: "env",
    pollIntervalMs: 1,
  },
  jobs: [{ workflow: {}, input: {} }],
  queuePrompt: vi.fn(),
  waitForCompletion: vi.fn(),
  saveOutputs: vi.fn(),
  addToLog: vi.fn(),
  writeLog: vi.fn(),
  convertOutputs: vi.fn(),
}));

vi.mock("../../../comfyui/jobs/config.mjs", () => ({
  requireConfig: vi.fn(async () => mocks.config),
}));
vi.mock("../../../comfyui/utils/args.mjs", () => ({
  requireInputName: vi.fn(() => "test"),
}));
vi.mock("../../../comfyui/workflow-builder/workflow.mjs", () => ({
  requireWorkflows: vi.fn(async () => mocks.jobs),
}));
vi.mock("../../../comfyui/jobs/comfy.mjs", () => ({
  queuePrompt: mocks.queuePrompt,
  waitForCompletion: mocks.waitForCompletion,
}));
vi.mock("../../../comfyui/jobs/save.mjs", () => ({
  saveOutputs: mocks.saveOutputs,
}));
vi.mock("../../../comfyui/jobs/convert.mjs", () => ({
  convertOutputs: mocks.convertOutputs,
}));
vi.mock("../../../comfyui/jobs/log.mjs", () => ({
  addToLog: mocks.addToLog,
  writeLog: mocks.writeLog,
}));
vi.mock("../../../comfyui/utils/naming.mjs", () => ({
  timestamp: () => "20260101000000",
}));

const { main } = await import("../../../comfyui/batch.mjs");

describe("batch orchestrator", () => {
  it("runs every job through the pipeline", async () => {
    mocks.queuePrompt.mockResolvedValue("prompt-1");
    mocks.waitForCompletion.mockResolvedValue({ status: {} });
    mocks.saveOutputs.mockResolvedValue([
      { filename: "x.png", destDir: "output" },
    ]);
    mocks.addToLog.mockResolvedValue([]);
    mocks.convertOutputs.mockResolvedValue(undefined);

    await expect(main()).resolves.toBe(true);
    expect(mocks.writeLog).toHaveBeenCalled();
    expect(mocks.addToLog).toHaveBeenCalled();
    expect(mocks.convertOutputs).toHaveBeenCalled();
  });

  it("returns false when a job fails", async () => {
    mocks.queuePrompt.mockRejectedValueOnce(new Error("queue failed"));
    await expect(main()).resolves.toBe(false);
  });
});
