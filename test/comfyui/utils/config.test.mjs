import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../support/env.mjs";

const state = { active: null, error: null };
vi.mock("../../../runpod/state.mjs", () => ({
  readActivePod: vi.fn(async () => {
    if (state.error) throw state.error;
    return state.active;
  }),
}));
const { loadConfig } = await import("../../../comfyui/jobs/config.mjs");

describe("configuration", () => {
  afterEach(() => {
    state.active = null;
    state.error = null;
  });

  it("requires a server and validates polling", async () => {
    await withEnv(
      { COMFY_SERVER: "", COMFY_POLL_INTERVAL_MS: "" },
      async () => {
        await expect(loadConfig()).rejects.toThrow("Missing COMFY_SERVER");
        await expect(
          loadConfig({
            COMFY_SERVER: "http://env",
            COMFY_POLL_INTERVAL_MS: "0",
          }),
        ).rejects.toThrow("integer");
        await expect(
          loadConfig({ COMFY_SERVER: "http://env" }),
        ).resolves.toMatchObject({ pollIntervalMs: 5000 });
      },
    );
  });

  it("prefers the active pod URL", async () => {
    state.active = { comfyUrl: " http://pod " };
    await expect(
      loadConfig({ COMFY_SERVER: "http://env", COMFY_POLL_INTERVAL_MS: "10" }),
    ).resolves.toMatchObject({ server: "http://pod", serverSource: "pod" });
    state.active = null;
  });

  it("falls back after unreadable state and reports requireConfig failures", async () => {
    state.error = new Error("bad state");
    await expect(
      loadConfig({ COMFY_SERVER: "http://env" }),
    ).resolves.toMatchObject({ serverSource: "env" });
    const { requireConfig } = await import("../../../comfyui/jobs/config.mjs");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(requireConfig({ COMFY_SERVER: "" })).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
