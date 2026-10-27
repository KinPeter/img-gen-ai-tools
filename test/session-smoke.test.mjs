import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const sessionPath = join(projectRoot, "session.sh");

const checks = [
  "start-pod",
  "stop-pod",
  "comfy-batch",
  "flf",
  "runpod-comfy",
  "comfy",
];

function assertFunctionsSourceable(fromCwd = null) {
  const cd = fromCwd ? `cd "${fromCwd}" && ` : "";
  const cmd =
    `${cd}source "${sessionPath}" ` +
    checks.map((fn) => `type ${fn} > /dev/null`).join(" && ");

  return execSync(`bash -c ${JSON.stringify(cmd)}`, {
    cwd: fromCwd,
    stdio: "pipe",
  });
}

describe("session.sh smoke test", () => {
  it("defines all 7 functions when sourced from project root", () => {
    const result = assertFunctionsSourceable(projectRoot);
    if (result.length > 0) {
      throw new Error(`Unexpected stdout: ${result.toString()}`);
    }
  });

  it("defines all functions when sourced from a sibling directory (path-resolution fix)", () => {
    const siblingDir = join(projectRoot, "test");
    const result = assertFunctionsSourceable(siblingDir);
    if (result.length > 0) {
      throw new Error(`Unexpected stdout: ${result.toString()}`);
    }
  });

  it("refuses to run as a standalone script (exit code 1)", () => {
    let result;
    try {
      execSync(`bash "${sessionPath}"`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch (e) {
      result = e.stdout?.toString().trim() ?? "";
    }
    if (result !== "Run with:  source ./session.sh") {
      throw new Error(
        `Expected "Run with:  source ./session.sh", got: ${JSON.stringify(result)}`,
      );
    }
  });
});
