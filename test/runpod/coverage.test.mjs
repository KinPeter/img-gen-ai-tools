import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_CUDA_VERSIONS,
  POD_TEMPLATE_IMAGE,
} from "../../runpod/common.mjs";
import { POD_IMAGES } from "../../runpod/pod-images.mjs";
import {
  clearActivePod,
  readActivePod,
  writeActivePod,
} from "../../runpod/state.mjs";
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
    expect(
      JSON.parse(
        await readFile(
          new URL("../../runpod/.active-pod.json", import.meta.url),
        ),
      ),
    ).toEqual({ id: "pod" });
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
