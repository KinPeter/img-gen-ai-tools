import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function runNode(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

describe("CLI failure paths", () => {
  it("reports missing ComfyUI configuration and exits non-zero", async () => {
    const result = await runNode("comfyui/batch.mjs", {
      COMFY_SERVER: "",
      RUNPOD_STATE_PATH: "/tmp/img-gen-test-no-state.json",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing COMFY_SERVER");
  });

  it("reports missing RunPod credentials and exits non-zero", async () => {
    const result = await runNode("runpod/stop-pod.mjs", {
      RUNPOD_API_KEY: "",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing RUNPOD_API_KEY");
  });
});
