import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, comfyHandlers } from "../../support/server.mjs";
import {
  fetchImage,
  queuePrompt,
  waitForCompletion,
} from "../../../comfyui/jobs/comfy.mjs";

const base = "http://comfy.test";
describe("ComfyUI client", () => {
  it("queues and downloads without network access", async () => {
    server.use(...comfyHandlers({ server: base }));
    expect(await queuePrompt(base, { node: {} })).toBe("prompt-1");
    expect((await fetchImage(base, { filename: "x.png" })).length).toBe(3);
  });

  it("polls pending history and reports failures", async () => {
    let calls = 0;
    server.use(
      http.get(`${base}/history/:id`, () => {
        calls++;
        return calls === 1
          ? HttpResponse.json({})
          : HttpResponse.json({ id: { status: { status_str: "success" } } });
      }),
    );
    await expect(
      waitForCompletion(base, "id", { pollIntervalMs: 1 }),
    ).resolves.toMatchObject({ status: { status_str: "success" } });
    server.use(
      http.get(`${base}/history/fail`, () =>
        HttpResponse.json({ fail: { status: { status_str: "error" } } }),
      ),
    );
    await expect(
      waitForCompletion(base, "fail", { pollIntervalMs: 1 }),
    ).rejects.toThrow("Job failed");
  });

  it("reports HTTP and malformed API responses", async () => {
    server.use(
      http.post(
        `${base}/prompt`,
        () => new HttpResponse("not-json", { status: 502 }),
      ),
      http.get(
        `${base}/view`,
        () => new HttpResponse(null, { status: 404, statusText: "Not Found" }),
      ),
      http.get(
        `${base}/history/bad-http`,
        () => new HttpResponse("unavailable", { status: 503 }),
      ),
    );
    await expect(queuePrompt(base, {})).rejects.toThrow();
    await expect(fetchImage(base, { filename: "missing.png" })).rejects.toThrow(
      "Could not fetch image",
    );
    await expect(
      waitForCompletion(base, "bad-http", { pollIntervalMs: 1 }),
    ).rejects.toThrow("Could not fetch history");
  });

  it("times out when history never appears", async () => {
    server.use(http.get(`${base}/history/slow`, () => HttpResponse.json({})));
    await expect(
      waitForCompletion(base, "slow", { pollIntervalMs: 1, timeoutMs: 0 }),
    ).rejects.toThrow("Timed out waiting");
  });
});
