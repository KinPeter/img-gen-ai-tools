import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../support/server.mjs";
import { withEnv } from "../support/env.mjs";
import {
  createPod,
  createPodWithFallback,
  getPod,
  podAction,
  waitForStatus,
  waitForComfyReady,
} from "../../runpod/pods.mjs";
import { listGpuTypes } from "../../runpod/list-types.mjs";

describe("RunPod client", () => {
  it("uses credentials for pod requests", async () => {
    server.use(
      http.post("https://api.runpod.io/v2/pods", ({ request }) =>
        request.headers.get("authorization") === "Bearer key"
          ? HttpResponse.json({ id: "pod-1" })
          : HttpResponse.json({ detail: "unauthorized" }, { status: 401 }),
      ),
      http.get("https://api.runpod.io/v2/pods/pod-1", () =>
        HttpResponse.json({ id: "pod-1", status: "RUNNING" }),
      ),
    );
    expect(await createPod("key", { name: "test" })).toEqual({ id: "pod-1" });
    await expect(getPod("key", "pod-1")).resolves.toMatchObject({
      status: "RUNNING",
    });
  });

  it("covers catalog filtering, actions, and status polling", async () => {
    server.use(
      http.get("https://api.runpod.io/v2/catalog/gpus", () =>
        HttpResponse.json({
          gpus: [
            {
              name: "cheap",
              id: "gpu-cheap",
              secure: true,
              availability: "HIGH",
              cudaVersions: [{ version: "12.8" }],
              price: { secure: 0.2 },
            },
            {
              name: "filtered",
              id: "gpu-filtered",
              secure: false,
              availability: "HIGH",
              cudaVersions: [{ version: "12.8" }],
              price: { secure: 0.1 },
            },
          ],
        }),
      ),
      http.post(
        "https://api.runpod.io/v2/pods/pod-1/action",
        async ({ request }) => {
          const body = await request.json();
          return HttpResponse.json({ id: "pod-1", action: body.action });
        },
      ),
      http.get("https://api.runpod.io/v2/pods/pod-poll", () =>
        HttpResponse.json({ id: "pod-poll", status: "EXITED" }),
      ),
      http.get("https://api.runpod.io/v2/pods/pod-error", () =>
        HttpResponse.json({ detail: "no access" }, { status: 403 }),
      ),
    );
    await expect(listGpuTypes()).resolves.toEqual([
      { name: "cheap", id: "gpu-cheap", price: 0.2, availability: "HIGH" },
    ]);
    await expect(podAction("key", "pod-1", "stop")).resolves.toMatchObject({
      action: "stop",
    });
    await expect(
      waitForStatus("key", "pod-poll", "EXITED", { pollMs: 1 }),
    ).resolves.toMatchObject({ status: "EXITED" });
    await expect(getPod("key", "pod-error")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("tries fallback GPUs and detects ComfyUI readiness failures", async () => {
    let attempts = 0;
    server.use(
      http.post("https://api.runpod.io/v2/pods", () => {
        attempts++;
        return attempts === 1
          ? HttpResponse.json({ detail: "busy" }, { status: 400 })
          : HttpResponse.json({ id: "pod-2" });
      }),
      http.get("https://api.runpod.io/v2/pods/pod-2", () =>
        HttpResponse.json({ id: "pod-2", status: "RUNNING" }),
      ),
      http.get(
        "http://comfy.test/system_stats",
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    await expect(
      createPodWithFallback(
        "key",
        [{ id: "first" }, { id: "second" }],
        (gpu) => ({ gpu: gpu.id }),
        { attempts: 0 },
      ),
    ).resolves.toMatchObject({ pod: { id: "pod-2" }, gpu: { id: "second" } });
    await expect(
      waitForComfyReady("http://comfy.test", { pollMs: 1, timeoutMs: 0 }),
    ).rejects.toThrow("Timed out waiting for ComfyUI");
  });

  it("requires credentials before making RunPod requests", async () => {
    await withEnv({ RUNPOD_API_KEY: "" }, async () => {
      await expect(createPod(undefined, {})).rejects.toThrow(
        "Missing RUNPOD_API_KEY",
      );
    });
  });

  it("handles empty responses, malformed errors, retries and exhausted GPUs", async () => {
    let requests = 0;
    server.use(
      http.post("https://api.runpod.io/v2/pods", () => {
        requests++;
        if (requests === 1)
          return HttpResponse.json(
            { detail: "busy" },
            { status: 429, headers: { "Retry-After": "0" } },
          );
        if (requests === 2) return HttpResponse.json({ id: "retried" });
        return new HttpResponse("invalid-json", { status: 500 });
      }),
      http.post(
        "https://api.runpod.io/v2/pods/empty/action",
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    await expect(
      createPodWithFallback("key", [{ id: "one" }], () => ({ gpu: "one" }), {
        attempts: 1,
      }),
    ).resolves.toMatchObject({ pod: { id: "retried" } });
    await expect(podAction("key", "empty", "terminate")).resolves.toBeNull();
    await expect(createPodWithFallback("key", [], () => ({}))).rejects.toThrow(
      "No GPU candidates",
    );
    await expect(
      createPodWithFallback("key", [{ id: "fail" }], () => ({}), {
        attempts: 0,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(requests).toBe(3);
  });

  it("times out while polling status, SSH, and readiness and fails on dead pods", async () => {
    server.use(
      http.get("https://api.runpod.io/v2/pods/wait", () =>
        HttpResponse.json({ status: "PENDING" }),
      ),
      http.get("http://comfy.test/system_stats", () =>
        HttpResponse.json({ ok: true }),
      ),
    );
    await expect(
      waitForStatus("key", "wait", "RUNNING", { timeoutMs: -1 }),
    ).rejects.toThrow("Timed out");
    const { waitForDirectSsh } = await import("../../runpod/pods.mjs");
    await expect(
      waitForDirectSsh("key", "wait", { timeoutMs: -1 }),
    ).rejects.toThrow("Timed out");
    await expect(
      waitForComfyReady("http://comfy.test", {
        getStatus: async () => "EXITED",
      }),
    ).rejects.toThrow("EXITED");
    await expect(
      waitForComfyReady("http://comfy.test/", {
        getStatus: async () => "RUNNING",
      }),
    ).resolves.toBeUndefined();
  });
});
