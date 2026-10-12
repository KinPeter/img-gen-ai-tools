import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  active: null,
  listGpuTypes: vi.fn(async () => [{ id: "gpu", name: "GPU", price: 1 }]),
  createPodWithFallback: vi.fn(async () => ({
    pod: { id: "p", name: "pod", ssh: {} },
    gpu: { id: "gpu", name: "GPU", price: 1 },
  })),
  waitForStatus: vi.fn(async () => ({
    id: "p",
    name: "pod",
    status: "RUNNING",
    gpu: { id: "gpu" },
    ssh: {},
  })),
  waitForComfyReady: vi.fn(async () => undefined),
  getPod: vi.fn(async () => ({ status: "RUNNING" })),
  writeActivePod: vi.fn(async () => undefined),
  readActivePod: vi.fn(async () => m.active),
  clearActivePod: vi.fn(async () => undefined),
  podAction: vi.fn(async () => undefined),
}));
vi.mock("../../runpod/list-types.mjs", () => ({
  listGpuTypes: m.listGpuTypes,
}));
vi.mock("../../runpod/pods.mjs", () => ({
  createPodWithFallback: m.createPodWithFallback,
  waitForStatus: m.waitForStatus,
  waitForComfyReady: m.waitForComfyReady,
  getPod: m.getPod,
  podAction: m.podAction,
}));
vi.mock("../../runpod/state.mjs", () => ({
  readActivePod: m.readActivePod,
  writeActivePod: m.writeActivePod,
  clearActivePod: m.clearActivePod,
}));

const { main: start } = await import("../../runpod/start-pod.mjs");
const { main: stop } = await import("../../runpod/stop-pod.mjs");

describe("RunPod command orchestration", () => {
  afterEach(() => {
    m.active = null;
    vi.clearAllMocks();
    m.listGpuTypes.mockResolvedValue([{ id: "gpu", name: "GPU", price: 1 }]);
    m.createPodWithFallback.mockResolvedValue({
      pod: { id: "p", name: "pod", ssh: {} },
      gpu: { id: "gpu", name: "GPU", price: 1 },
    });
    m.waitForStatus.mockResolvedValue({
      id: "p",
      name: "pod",
      status: "RUNNING",
      gpu: { id: "gpu" },
      ssh: {},
    });
    m.getPod.mockResolvedValue({ status: "RUNNING" });
  });
  const withExit = async (fn, code = 1) => {
    const exit = vi.spyOn(process, "exit").mockImplementation((actual) => {
      throw new Error(`exit ${actual}`);
    });
    await expect(fn()).rejects.toThrow(`exit ${code}`);
    exit.mockRestore();
  };

  it("rejects invalid start configuration and placement failures", async () => {
    const previousKey = process.env.RUNPOD_API_KEY;
    const previousArg = process.argv[2];
    delete process.env.RUNPOD_API_KEY;
    await withExit(() => start());
    process.env.RUNPOD_API_KEY = "key";
    process.argv[2] = "not-an-image";
    await withExit(() => start());
    delete process.argv[2];
    m.listGpuTypes.mockResolvedValueOnce([]);
    await withExit(() => start());
    m.listGpuTypes.mockRejectedValueOnce(new Error("catalog"));
    await withExit(() => start());
    if (previousArg === undefined) delete process.argv[2];
    else process.argv[2] = previousArg;
    if (previousKey == null) delete process.env.RUNPOD_API_KEY;
    else process.env.RUNPOD_API_KEY = previousKey;
  });

  it("starts a pod and records readiness", async () => {
    const previous = process.env.RUNPOD_API_KEY;
    process.env.RUNPOD_API_KEY = "key";
    await expect(start()).resolves.toBeUndefined();
    expect(m.writeActivePod).toHaveBeenCalled();
    if (previous == null) delete process.env.RUNPOD_API_KEY;
    else process.env.RUNPOD_API_KEY = previous;
  });

  it("records available SSH commands on a ready pod", async () => {
    const previous = process.env.RUNPOD_API_KEY;
    process.env.RUNPOD_API_KEY = "key";
    try {
      m.waitForStatus.mockResolvedValueOnce({
        id: "p",
        name: "pod",
        status: "RUNNING",
        gpu: { id: "gpu" },
        ssh: {
          proxy: { command: "proxy ssh" },
          direct: { command: "direct ssh" },
        },
      });
      await start();
      expect(m.writeActivePod).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ssh: { proxy: "proxy ssh", direct: "direct ssh" },
        }),
      );
      expect(m.waitForComfyReady).toHaveBeenCalledWith(
        "https://p-8188.proxy.runpod.net",
        expect.objectContaining({ getStatus: expect.any(Function) }),
      );
    } finally {
      if (previous == null) delete process.env.RUNPOD_API_KEY;
      else process.env.RUNPOD_API_KEY = previous;
    }
  });

  it("stops an active pod and clears its pointer", async () => {
    m.active = { id: "p" };
    const previous = process.env.RUNPOD_API_KEY;
    process.env.RUNPOD_API_KEY = "key";
    m.getPod.mockResolvedValueOnce({
      id: "p",
      status: "RUNNING",
      actions: ["stop"],
    });
    m.waitForStatus.mockResolvedValueOnce({ id: "p", status: "EXITED" });
    await expect(stop()).resolves.toBeUndefined();
    expect(m.podAction).toHaveBeenCalledWith("key", "p", "terminate");
    m.active = null;
    if (previous == null) delete process.env.RUNPOD_API_KEY;
    else process.env.RUNPOD_API_KEY = previous;
  });

  it("handles already-gone and already-stopped pods", async () => {
    const previous = process.env.RUNPOD_API_KEY;
    process.env.RUNPOD_API_KEY = "key";
    m.active = { id: "gone" };
    const missing = Object.assign(new Error("gone"), { status: 404 });
    m.getPod.mockRejectedValueOnce(missing);
    await expect(stop()).resolves.toBeUndefined();
    expect(m.clearActivePod).toHaveBeenCalled();
    m.active = { id: "idle" };
    m.getPod.mockResolvedValueOnce({
      id: "idle",
      status: "EXITED",
      actions: [],
    });
    await expect(stop()).resolves.toBeUndefined();
    m.active = null;
    if (previous == null) delete process.env.RUNPOD_API_KEY;
    else process.env.RUNPOD_API_KEY = previous;
  });

  it("preserves the pointer when stop operations fail", async () => {
    const previous = process.env.RUNPOD_API_KEY;
    process.env.RUNPOD_API_KEY = "key";
    m.active = { id: "broken" };
    m.getPod.mockRejectedValueOnce(new Error("network"));
    await withExit(() => stop());
    m.active = null;
    if (previous == null) delete process.env.RUNPOD_API_KEY;
    else process.env.RUNPOD_API_KEY = previous;
  });

  it("refuses duplicate pods and reports placement failures without writing state", async () => {
    const previous = process.env.RUNPOD_API_KEY;
    process.env.RUNPOD_API_KEY = "key";
    try {
      m.active = { id: "existing" };
      await withExit(() => start());
      expect(m.listGpuTypes).not.toHaveBeenCalled();
      expect(m.createPodWithFallback).not.toHaveBeenCalled();
      m.active = null;
      for (const status of [422, 402, 500]) {
        m.createPodWithFallback.mockRejectedValueOnce(
          Object.assign(new Error("unavailable"), {
            status,
            data: { errors: "bad request" },
          }),
        );
        await withExit(() => start());
      }
      expect(m.writeActivePod).not.toHaveBeenCalled();
    } finally {
      if (previous == null) delete process.env.RUNPOD_API_KEY;
      else process.env.RUNPOD_API_KEY = previous;
    }
  });

  it("keeps the pointer when startup polling or readiness fails", async () => {
    const previous = process.env.RUNPOD_API_KEY;
    process.env.RUNPOD_API_KEY = "key";
    try {
      m.waitForStatus.mockRejectedValueOnce(new Error("pod crashed"));
      await withExit(() => start());
      expect(m.writeActivePod).toHaveBeenCalledTimes(1);
      m.waitForComfyReady.mockRejectedValueOnce(new Error("API unavailable"));
      await withExit(() => start());
      expect(m.writeActivePod).toHaveBeenCalledTimes(3);
      expect(m.clearActivePod).not.toHaveBeenCalled();
    } finally {
      if (previous == null) delete process.env.RUNPOD_API_KEY;
      else process.env.RUNPOD_API_KEY = previous;
    }
  });

  it("handles missing API key and absent state without calling the cloud", async () => {
    const previous = process.env.RUNPOD_API_KEY;
    delete process.env.RUNPOD_API_KEY;
    await withExit(() => stop());
    process.env.RUNPOD_API_KEY = "key";
    await withExit(() => stop(), 0);
    expect(m.getPod).not.toHaveBeenCalled();
    if (previous == null) delete process.env.RUNPOD_API_KEY;
    else process.env.RUNPOD_API_KEY = previous;
  });
});
