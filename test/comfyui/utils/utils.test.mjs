import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseInputName } from "../../../comfyui/utils/args.mjs";
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
} from "../../../comfyui/jobs/log.mjs";

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
  });
});
