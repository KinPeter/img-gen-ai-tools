import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../support/server.mjs";
import { saveOutputs } from "../../../comfyui/jobs/save.mjs";
import {
  convertAll,
  collectPngFiles,
  convertOutputs,
  distPathFor,
} from "../../../comfyui/jobs/convert.mjs";

const png = await readFile(
  new URL("../../fixtures/images/tiny.png", import.meta.url),
);
const dirs = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))),
);

describe("output jobs", () => {
  it("saves fetched images safely and converts PNG files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "img-output-"));
    dirs.push(root);
    server.use(http.get("http://comfy.test/view", () => new HttpResponse(png)));
    const saved = await saveOutputs({
      server: "http://comfy.test",
      destBaseDir: root,
      input: { "output-folder": "../../escape", "filename-prefix": "portrait" },
      historyEntry: {
        outputs: {
          node: { images: [{ filename: "source.png", type: "output" }] },
        },
      },
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].destDir).toBe(root);
    expect((await readFile(path.join(root, saved[0].filename))).length).toBe(
      png.length,
    );
    expect(
      await convertAll({ outputDir: root, distDir: path.join(root, "dist") }),
    ).toEqual({ done: 1, total: 1 });
  });

  it("continues after image fetch and conversion failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "img-output-errors-"));
    dirs.push(root);
    server.use(
      http.get(
        "http://comfy.test/view",
        () => new HttpResponse(null, { status: 500, statusText: "Broken" }),
      ),
    );
    await expect(
      saveOutputs({
        server: "http://comfy.test",
        destBaseDir: root,
        input: {},
        historyEntry: {
          outputs: { node: { images: [{ filename: "bad.png" }] } },
        },
      }),
    ).resolves.toEqual([]);

    await expect(
      convertAll({ outputDir: path.join(root, "missing"), distDir: root }),
    ).rejects.toThrow();
  });

  it("collects nested PNGs and keeps conversion failures isolated", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "img-nested-"));
    dirs.push(root);
    await mkdir(path.join(root, "nested"), { recursive: true });
    await writeFile(path.join(root, "nested", "ok.png"), png);
    await writeFile(path.join(root, "nested", "skip.txt"), "x");
    expect(await collectPngFiles(root)).toHaveLength(1);
    expect(
      distPathFor({
        distBaseDir: root,
        filename: "a.png",
        relativeDir: "nested",
      }),
    ).toBe(path.join(root, "nested", "a.jpg"));
    await expect(
      convertOutputs([{ destDir: root, filename: "missing.png" }], {
        outputBaseDir: root,
        distBaseDir: path.join(root, "dist"),
      }),
    ).resolves.toBeUndefined();
  });
});
