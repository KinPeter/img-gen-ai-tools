import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findLogEntry,
  normalizeToPngFilename,
} from "../../../comfyui/jobs/find-log-from-files.mjs";

const dirs = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))),
);

describe("log lookup", () => {
  it("normalizes common filename forms", () => {
    expect(normalizeToPngFilename(" C:\\output\\image.jpg ")).toBe("image.png");
    expect(normalizeToPngFilename("/tmp/image.png")).toBe("image.png");
    expect(normalizeToPngFilename(" ")).toBeNull();
    expect(normalizeToPngFilename("/tmp/")).toBe("tmp.png");
  });

  it("searches nested JSON logs and skips malformed files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "img-logs-"));
    dirs.push(root);
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "bad.json"), "not json");
    await writeFile(
      path.join(root, "nested", "good.json"),
      JSON.stringify([
        { filename: "other.png" },
        { filename: "target.png", value: 1 },
      ]),
    );
    await writeFile(path.join(root, "ignored.txt"), "{}");
    await expect(
      findLogEntry({ logsDir: root, targetFilename: "target.png" }),
    ).resolves.toMatchObject({ entry: { value: 1 } });
    await expect(
      findLogEntry({ logsDir: root, targetFilename: "missing.png" }),
    ).resolves.toBeNull();
    await expect(
      findLogEntry({
        logsDir: path.join(root, "missing"),
        targetFilename: "x.png",
      }),
    ).resolves.toBeNull();
  });
});
