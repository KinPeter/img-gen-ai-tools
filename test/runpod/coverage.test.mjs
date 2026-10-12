import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_CUDA_VERSIONS,
  POD_TEMPLATE_IMAGE,
} from "../../runpod/common.mjs";
import { POD_IMAGES } from "../../runpod/pod-images.mjs";
const stateDir = await mkdtemp(path.join(os.tmpdir(), "runpod-state-test-"));
const previousStatePath = process.env.RUNPOD_STATE_PATH;
process.env.RUNPOD_STATE_PATH = path.join(stateDir, "state.json");
const { ACTIVE_POD_PATH, clearActivePod, readActivePod, writeActivePod } =
  await import("../../runpod/state.mjs");
if (previousStatePath == null) delete process.env.RUNPOD_STATE_PATH;
else process.env.RUNPOD_STATE_PATH = previousStatePath;
import { http, HttpResponse } from "msw";
import { server } from "../support/server.mjs";
import { listGpuTypes } from "../../runpod/list-types.mjs";
import {
  createPodWithFallback,
  waitForComfyReady,
  waitForDirectSsh,
  waitForStatus,
} from "../../runpod/pods.mjs";

afterEach(async () => {
  await clearActivePod();
  vi.useRealTimers();
});

import { afterAll } from "vitest";
afterAll(async () => rm(stateDir, { recursive: true, force: true }));

describe("RunPod coverage helpers", () => {
  it("exposes image and GPU configuration", () => {
    expect(POD_TEMPLATE_IMAGE).toContain("comfyui");
    expect(ALLOWED_CUDA_VERSIONS).toEqual(["12.8"]);
    expect(POD_IMAGES.get("unholy")).toContain("squirrel");
  });

  it("persists and reads pod state", async () => {
    await clearActivePod();
    await expect(readActivePod()).resolves.toBeNull();
    await writeActivePod({ id: "pod" });
    await expect(readActivePod()).resolves.toEqual({ id: "pod" });
    expect(JSON.parse(await readFile(ACTIVE_POD_PATH))).toEqual({ id: "pod" });
    await writeFile(ACTIVE_POD_PATH, "invalid json");
    await expect(readActivePod()).rejects.toThrow("Could not read pod state");
  });

  it("handles catalog errors and direct SSH polling", async () => {
    server.use(
      http.get(
        "https://api.runpod.io/v2/catalog/gpus",
        () => new HttpResponse(null, { status: 500, statusText: "Broken" }),
      ),
    );
    await expect(listGpuTypes()).rejects.toThrow("RunPod API error");
    server.use(
      http.get("https://api.runpod.io/v2/pods/ssh", () =>
        HttpResponse.json({ ssh: { direct: { command: "ssh" } } }),
      ),
    );
    await expect(
      waitForDirectSsh("key", "ssh", { pollMs: 1 }),
    ).resolves.toMatchObject({ ssh: { direct: { command: "ssh" } } });
  });

  it("prints GPU catalog results and errors when invoked as a CLI", async () => {
    const previousArg = process.argv[1];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      process.argv[1] = new URL(
        "../../runpod/list-types.mjs",
        import.meta.url,
      ).pathname;
      server.use(
        http.get("https://api.runpod.io/v2/catalog/gpus", () =>
          HttpResponse.json({ gpus: [] }),
        ),
      );
      await import("../../runpod/list-types.mjs?cli-success");
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith("[]"));
      server.use(
        http.get(
          "https://api.runpod.io/v2/catalog/gpus",
          () => new HttpResponse(null, { status: 503 }),
        ),
      );
      await import("../../runpod/list-types.mjs?cli-error");
      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining("RunPod API error"),
        ),
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv[1] = previousArg;
      process.exitCode = previousExitCode;
    }
  });

  it("covers polling failures, fallback aborts, and readiness success", async () => {
    server.use(
      http.get("https://api.runpod.io/v2/pods/error", () =>
        HttpResponse.json({ status: "ERROR" }),
      ),
      http.get("https://api.runpod.io/v2/pods/ready", () =>
        HttpResponse.json({ status: "RUNNING" }),
      ),
      http.get("http://comfy.test/system_stats", () =>
        HttpResponse.json({ ok: true }),
      ),
      http.post("https://api.runpod.io/v2/pods", () =>
        HttpResponse.json({ detail: "bad" }, { status: 422 }),
      ),
    );
    await expect(
      waitForStatus("key", "error", "RUNNING", { pollMs: 1 }),
    ).rejects.toThrow("ERROR state");
    await expect(
      waitForComfyReady("http://comfy.test", {
        getStatus: async () => "RUNNING",
      }),
    ).resolves.toBeUndefined();
    await expect(
      createPodWithFallback("key", [{ id: "gpu" }], () => ({}), {
        attempts: 0,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
