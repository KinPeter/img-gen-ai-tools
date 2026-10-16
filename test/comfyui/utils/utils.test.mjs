import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const uploadLogMock = vi.hoisted(() => ({ uploadLog: vi.fn() }));

vi.mock("../../../logging/upload-log.mjs", () => uploadLogMock);

uploadLogMock.uploadLog.mockResolvedValue({ uploaded: 1 });

import {
  parseInputName,
  requireInputName,
} from "../../../comfyui/utils/args.mjs";
import {
  destFileName,
  resolvePrefix,
  timestamp,
} from "../../../comfyui/utils/naming.mjs";
import { resolveDestDir } from "../../../comfyui/utils/paths.mjs";
import { collectOutputImages } from "../../../comfyui/utils/outputs.mjs";
import {
  formatDuration,
  generationTimeMs,
  buildLogEntry,
  writeLog,
  addToLog,
} from "../../../comfyui/jobs/log.mjs";
import { collectOutputImages as collectImages } from "../../../comfyui/utils/outputs.mjs";

const dirs = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))),
);

describe("utilities", () => {
  it("parses and formats stable names", () => {
    expect(parseInputName(["node", "comfy-batch", "demo"])).toBe("demo");
    expect(timestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102030405");
    expect(resolvePrefix("nested/prefix")).toBe("prefix");
    expect(destFileName({ prefix: "x", ts: "1", index: 1, ext: ".png" })).toBe(
      "x_1_1.png",
    );
    expect(resolvePrefix(" ")).toBe("output");
    expect(destFileName({ prefix: "x", ts: "1", index: 0, ext: ".png" })).toBe(
      "x_1.png",
    );
    expect(parseInputName(["node", "cmd"])).toBeNull();
  });

  it("reports missing CLI input", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    expect(() => requireInputName(["node", "cmd"])).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("returns a supplied input name without exiting", () => {
    const exit = vi.spyOn(process, "exit");
    expect(requireInputName(["node", "cmd", "valid"])).toBe("valid");
    expect(exit).not.toHaveBeenCalled();
  });

  it("prevents output-folder traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "img-tools-"));
    dirs.push(root);
    expect(resolveDestDir(root, "nested")).toBe(path.join(root, "nested"));
    expect(resolveDestDir(root, "../../escape")).toBe(root);
  });

  it("handles output images and durations", () => {
    expect(
      collectOutputImages({
        a: { images: [{ type: "output" }, { type: "temp" }] },
      }),
    ).toHaveLength(1);
    expect(
      generationTimeMs({
        status: {
          messages: [
            ["execution_start", { timestamp: 100 }],
            ["execution_success", { timestamp: 2500 }],
          ],
        },
      }),
    ).toBe(2400);
    expect(formatDuration(125000)).toBe("2:05");
    expect(collectImages()).toEqual([]);
    expect(generationTimeMs({})).toBeNull();
    expect(formatDuration(-1)).toBe("0:00");
  });

  it("builds and writes log entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "img-log-"));
    dirs.push(root);
    const entry = buildLogEntry({
      input: { prompt: ["x"] },
      finalSeed: 3,
      finalPrompt: "base, x",
      finalNegativePrompt: "bad",
      filename: "x.png",
      outputPath: root,
      elapsedMs: null,
      comfyJobId: "id",
    });
    expect(entry.generatedIn).toBeNull();
    const log = path.join(root, "nested", "log.json");
    await expect(writeLog(log, [entry])).resolves.toBeUndefined();
    const workflow = {
      KSampler: { class_type: "KSampler", inputs: { seed: 3 } },
      PositiveCLIP_Base: { inputs: { text: "base" } },
      NegativeCLIP_Base: { inputs: { text: "bad" } },
    };
    await addToLog({
      logPath: log,
      logEntries: [],
      job: { input: {}, workflow },
      saved: [{ filename: "x.png", destDir: root }],
      promptId: "id",
      historyEntry: {},
    });
  });
});
