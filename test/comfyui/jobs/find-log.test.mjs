import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const readline = vi.hoisted(() => ({
  lines: ["", " ", "coverage-nonexistent-20261012.png"],
  handlers: [],
}));
const cliLogs = vi.hoisted(() => ({ enabled: false, lookups: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal();
  return {
    ...fs,
    readdir: (dir, options) => {
      if (cliLogs.enabled) {
        if (!String(dir).endsWith("/output/logs")) {
          throw new Error(`Unexpected CLI log directory: ${dir}`);
        }
        cliLogs.lookups++;
        return Promise.resolve([]);
      }
      return fs.readdir(dir, options);
    },
  };
});
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    on: (name, handler) => readline.handlers.push({ name, handler }),
    async *[Symbol.asyncIterator]() {
      yield* readline.lines;
    },
  }),
}));
import {
  findLogEntry,
  normalizeToPngFilename,
} from "../../../comfyui/jobs/find-log-from-files.mjs";

const dirs = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))),
);

describe("log lookup", () => {
  it("handles missing filenames from CLI arguments and stdin", async () => {
    const previousArg = process.argv[1];
    const previousInput = process.argv[2];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      cliLogs.enabled = true;
      cliLogs.lookups = 0;
      process.argv[1] = new URL(
        "../../../comfyui/jobs/find-log-from-files.mjs",
        import.meta.url,
      ).pathname;
      process.argv[2] = " ";
      await import("../../../comfyui/jobs/find-log-from-files.mjs?cli-test");
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Could not parse a filename"),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("No log entry found for filename"),
      );
      expect(cliLogs.lookups).toBe(1);
      expect(write).toHaveBeenCalledWith("> ");
      expect(readline.handlers.map((event) => event.name)).toContain("SIGINT");
    } finally {
      cliLogs.enabled = false;
      process.argv[1] = previousArg;
      if (previousInput === undefined) delete process.argv[2];
      else process.argv[2] = previousInput;
    }
  });
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
    await writeFile(
      path.join(root, "single.json"),
      JSON.stringify({ filename: "single.png" }),
    );
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
    await expect(
      findLogEntry({ logsDir: root, targetFilename: "single.png" }),
    ).resolves.toMatchObject({ entry: { filename: "single.png" } });
    await expect(
      findLogEntry({
        logsDir: path.join(root, "ignored.txt"),
        targetFilename: "x.png",
      }),
    ).rejects.toThrow();
  });
});
