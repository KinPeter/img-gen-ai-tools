import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./server.mjs";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());
