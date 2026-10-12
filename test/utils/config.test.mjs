import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../support/env.mjs";

const state = { active: null };
vi.mock("../../runpod/state.mjs", () => ({
  readActivePod: vi.fn(async () => state.active),
}));
const { loadConfig } = await import("../../jobs/config.mjs");

describe("configuration", () => {
  afterEach(() => {
    state.active = null;
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
});
