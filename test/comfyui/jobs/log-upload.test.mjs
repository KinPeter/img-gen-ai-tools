import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ uploadLog: vi.fn() }));

vi.mock("../../../logging/upload-log.mjs", () => mocks);

const { addToLog } = await import("../../../comfyui/jobs/log.mjs");

const dirs = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const workflow = {
  KSampler: { class_type: "KSampler", inputs: { seed: 3 } },
  PositiveCLIP_Base: { inputs: { text: "base" } },
  NegativeCLIP_Base: { inputs: { text: "bad" } },
};

async function runAddToLog({ saved, uploadImpl } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "img-log-upload-"));
  dirs.push(root);
  mocks.uploadLog.mockReset();
  if (uploadImpl) mocks.uploadLog.mockImplementation(uploadImpl);
  else mocks.uploadLog.mockResolvedValue({ uploaded: 1 });
  const logEntries = [];
  const result = await addToLog({
    logPath: path.join(root, "log.json"),
    logEntries,
    job: { input: {}, workflow },
    saved: saved ?? [{ filename: "x.png", destDir: root }],
    promptId: "id",
    historyEntry: {},
  });
  return { result, logEntries };
}

describe("addToLog remote upload", () => {
  it("uploads newly logged entries after writing the log file", async () => {
    const { result } = await runAddToLog({
      saved: [
        { filename: "a.png", destDir: "out" },
        { filename: "b.png", destDir: "out" },
      ],
    });
    expect(result).toHaveLength(2);
    expect(mocks.uploadLog).toHaveBeenCalledTimes(1);
    expect(mocks.uploadLog.mock.calls[0][0]).toHaveLength(2);
    expect(mocks.uploadLog.mock.calls[0][0]).toEqual(result);
  });

  it("handles upload failures gracefully without losing local entries", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { result } = await runAddToLog({
        uploadImpl: async () => {
          throw new Error("network down");
        },
      });
      expect(result).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Log upload failed"),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("skips the upload when nothing new was logged", async () => {
    const { result } = await runAddToLog({ saved: [] });
    expect(result).toHaveLength(0);
    expect(mocks.uploadLog).not.toHaveBeenCalled();
  });
});
