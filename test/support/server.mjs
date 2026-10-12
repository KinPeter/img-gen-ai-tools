import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export const server = setupServer();
export const comfyHandlers = ({ server: base = "http://comfy.test" } = {}) => [
  http.post(`${base}/prompt`, () =>
    HttpResponse.json({ prompt_id: "prompt-1" }),
  ),
  http.get(`${base}/history/:id`, ({ params }) =>
    HttpResponse.json({
      [params.id]: { status: { status_str: "success" }, outputs: {} },
    }),
  ),
  http.get(`${base}/view`, () => new HttpResponse(Uint8Array.from([1, 2, 3]))),
];
