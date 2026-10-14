import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LambdaClient } from "@aws-sdk/client-lambda";
import {
  REQUIRED_ENV_VARS,
  createLambdaClient,
  createZipBuffer,
  defaultPaths,
  deploy,
  main,
  requireEnv,
  waitForSuccessfulUpdate,
} from "../../logging/deploy-find-lambda.mjs";

const execFileAsync = promisify(execFile);
const dirs = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const fullEnv = {
  AWS_REGION: " us-east-1 ",
  AWS_ACCESS_KEY_ID: "key-id",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_LOGS_FIND_LAMBDA_NAME: " find-logs ",
};

const withExit = async (fn, code = 1) => {
  const exit = vi.spyOn(process, "exit").mockImplementation((actual) => {
    throw new Error(`exit ${actual}`);
  });
  try {
    await expect(fn()).rejects.toThrow(`exit ${code}`);
  } finally {
    exit.mockRestore();
  }
};

describe("deploy-find-lambda env and client", () => {
  it("exposes defaults and required vars", () => {
    expect(path.basename(defaultPaths.lambdaFile)).toBe("log-find-lambda.mjs");
    expect(REQUIRED_ENV_VARS).toEqual([
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_LOGS_FIND_LAMBDA_NAME",
    ]);
  });

  it("requires and trims every env var", () => {
    expect(requireEnv(fullEnv)).toEqual({
      region: "us-east-1",
      accessKeyId: "key-id",
      secretAccessKey: "secret",
      functionName: "find-logs",
    });
    expect(() =>
      requireEnv({
        ...fullEnv,
        AWS_REGION: " ",
        AWS_SECRET_ACCESS_KEY: "",
      }),
    ).toThrow("Missing required env vars: AWS_REGION, AWS_SECRET_ACCESS_KEY");
    expect(() => requireEnv({})).toThrow(
      `Missing required env vars: ${REQUIRED_ENV_VARS.join(", ")}`,
    );
  });

  it("creates a Lambda client with explicit credentials", () => {
    const client = createLambdaClient({
      region: "us-east-1",
      accessKeyId: "key-id",
      secretAccessKey: "secret",
    });
    expect(client).toBeInstanceOf(LambdaClient);
  });
});

describe("deploy-find-lambda packaging", () => {
  it("zips only the lambda file under its basename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deploy-zip-"));
    dirs.push(root);
    const lambdaFile = path.join(root, "custom-lambda.mjs");
    const sibling = path.join(root, "sibling.mjs");
    await writeFile(lambdaFile, "export const handler = async () => ({});\n");
    await writeFile(sibling, "should not be packaged\n");

    const buffer = await createZipBuffer(lambdaFile);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 2).toString("binary")).toBe("PK");

    const checkDir = await mkdtemp(path.join(os.tmpdir(), "deploy-check-"));
    dirs.push(checkDir);
    const zipPath = path.join(checkDir, "function.zip");
    await writeFile(zipPath, buffer);
    const { stdout } = await execFileAsync("unzip", ["-l", zipPath]);
    expect(stdout).toContain("custom-lambda.mjs");
    expect(stdout).not.toContain("sibling.mjs");
  });

  it("explains a missing lambda file or zip binary", async () => {
    await expect(
      createZipBuffer(path.join(os.tmpdir(), "deploy-missing-xyz.mjs")),
    ).rejects.toThrow("The `zip` binary is required");
  });

  it("rethrows unexpected packaging failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deploy-bad-"));
    dirs.push(root);
    await expect(createZipBuffer(root)).rejects.toThrow();
  });
});

describe("deploy-find-lambda update polling", () => {
  it("returns once the update succeeds", async () => {
    const configuration = { LastUpdateStatus: "Successful", Version: "1" };
    const send = vi.fn(async () => ({ Configuration: configuration }));
    await expect(
      waitForSuccessfulUpdate({ send }, "fn", { intervalMs: 1 }),
    ).resolves.toBe(configuration);
    const command = send.mock.calls[0][0];
    expect(command.input).toMatchObject({ FunctionName: "fn" });
  });

  it("waits through in-progress updates", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Configuration: { LastUpdateStatus: "InProgress" },
      })
      .mockResolvedValueOnce({
        Configuration: { LastUpdateStatus: "Successful" },
      });
    await expect(
      waitForSuccessfulUpdate({ send }, "fn", { intervalMs: 1 }),
    ).resolves.toMatchObject({ LastUpdateStatus: "Successful" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("reports failed updates", async () => {
    const send = vi.fn(async () => ({
      Configuration: {
        LastUpdateStatus: "Failed",
        LastUpdateStatusReason: "bad code",
      },
    }));
    await expect(
      waitForSuccessfulUpdate({ send }, "fn", { intervalMs: 1 }),
    ).rejects.toThrow("Lambda update failed: bad code");
    send.mockResolvedValueOnce({
      Configuration: { LastUpdateStatus: "Failed" },
    });
    await expect(
      waitForSuccessfulUpdate({ send }, "fn", { intervalMs: 1 }),
    ).rejects.toThrow("unknown reason");
  });

  it("times out when the update never succeeds", async () => {
    const send = vi.fn(async () => ({
      Configuration: { LastUpdateStatus: "InProgress" },
    }));
    await expect(
      waitForSuccessfulUpdate({ send }, "fn", {
        maxAttempts: 2,
        intervalMs: 1,
      }),
    ).rejects.toThrow("Timed out waiting for the Lambda update");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("deploy-find-lambda deploy and main", () => {
  it("sends code and waits for success", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const update = { Version: "7" };
      const configuration = { LastUpdateStatus: "Successful" };
      const calls = [];
      const lambdaClient = {
        send: vi.fn(async (command) => {
          calls.push(command.constructor.name);
          return command.constructor.name === "UpdateFunctionCodeCommand"
            ? update
            : { Configuration: configuration };
        }),
      };
      const zipBuffer = Buffer.from([1, 2, 3]);
      await expect(
        deploy({ lambdaClient, functionName: "fn", zipBuffer }),
      ).resolves.toEqual({ update, configuration });
      const codeCommand = lambdaClient.send.mock.calls[0][0];
      expect(codeCommand.input).toMatchObject({
        FunctionName: "fn",
        ZipFile: zipBuffer,
      });
      expect(calls).toEqual([
        "UpdateFunctionCodeCommand",
        "GetFunctionCommand",
      ]);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Code update sent"),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("deploys through injected dependencies", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const zipBuffer = Buffer.from([9]);
      const createZip = vi.fn(async () => zipBuffer);
      const lambdaClient = { send: vi.fn() };
      const connect = vi.fn(() => lambdaClient);
      const deployFn = vi.fn(async () => ({
        update: { Version: "3" },
        configuration: {},
      }));
      await main({
        env: fullEnv,
        zipLambdaFile: "lambda.mjs",
        createZip,
        connect,
        deployFn,
      });
      expect(createZip).toHaveBeenCalledWith("lambda.mjs");
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "find-logs" }),
      );
      expect(deployFn).toHaveBeenCalledWith({
        lambdaClient,
        functionName: "find-logs",
        zipBuffer,
      });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(
          'Deployed version 3. Ensure the Lambda Handler is "log-find-lambda.handler".',
        ),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("exits when env is missing or deploy fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withExit(() => main({ env: {} }));
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Missing required env vars"),
      );
      const deployFn = vi.fn(async () => {
        throw new Error("denied");
      });
      await withExit(() =>
        main({
          env: fullEnv,
          createZip: async () => Buffer.from([1]),
          connect: () => ({}),
          deployFn,
        }),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Deploy failed: denied"),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("covers the zip and client defaults", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deploy-main-"));
    dirs.push(root);
    await mkdir(path.join(root, "nested"), { recursive: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const deployFn = vi.fn(async () => ({
        update: { Version: "1" },
        configuration: {},
      }));
      await main({
        env: fullEnv,
        zipLambdaFile: defaultPaths.lambdaFile,
        deployFn,
      });
      expect(deployFn).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "find-logs" }),
      );
    } finally {
      log.mockRestore();
    }
  });
});
