import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "basic-ftp";
import {
  REQUIRED_ENV_VARS,
  createFtpClient,
  defaultPaths,
  deploy,
  main,
  requireDistFile,
  requireEnv,
} from "../../logging/deploy-find-ui.mjs";

const dirs = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const fullEnv = {
  FTP_HOST: " ftp.example.com ",
  FTP_USER: " deploy-user ",
  FTP_PASS: " s3cret ",
  LOG_FIND_UI_FTP_FOLDER: " /public_html/find ",
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

const makeDistFile = async (contents = "<html>ui</html>") => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deploy-ui-"));
  dirs.push(root);
  const distFile = path.join(root, "index.html");
  await writeFile(distFile, contents);
  return distFile;
};

const makeClient = () => ({
  access: vi.fn(async () => ({})),
  cd: vi.fn(async () => ({})),
  uploadFrom: vi.fn(async () => ({})),
  close: vi.fn(() => {}),
});

describe("deploy-find-ui env and paths", () => {
  it("exposes defaults and required vars", () => {
    expect(path.basename(defaultPaths.distFile)).toBe("index.html");
    expect(path.basename(path.dirname(defaultPaths.distFile))).toBe("dist");
    expect(REQUIRED_ENV_VARS).toEqual([
      "FTP_HOST",
      "FTP_USER",
      "FTP_PASS",
      "LOG_FIND_UI_FTP_FOLDER",
    ]);
  });

  it("requires and trims every env var", () => {
    expect(requireEnv(fullEnv)).toEqual({
      host: "ftp.example.com",
      user: "deploy-user",
      password: "s3cret",
      remoteFolder: "/public_html/find",
    });
    expect(() => requireEnv({ ...fullEnv, FTP_HOST: " " })).toThrow(
      "Missing required env vars: FTP_HOST",
    );
    expect(() => requireEnv({})).toThrow(
      `Missing required env vars: ${REQUIRED_ENV_VARS.join(", ")}`,
    );
  });

  it("rejects a URL-form FTP_HOST with a clear message", () => {
    expect(() =>
      requireEnv({ ...fullEnv, FTP_HOST: "ftps://ftp.example.com" }),
    ).toThrow("FTP_HOST should be a bare hostname, not a URL");
    expect(() =>
      requireEnv({ ...fullEnv, FTP_HOST: " ftp://ftp.example.com " }),
    ).toThrow("FTP_HOST should be a bare hostname, not a URL");
  });

  it("creates an FTP client by default", () => {
    expect(createFtpClient()).toBeInstanceOf(Client);
  });
});

describe("deploy-find-ui dist file", () => {
  it("resolves an existing dist file", async () => {
    const distFile = await makeDistFile();
    await expect(requireDistFile(distFile)).resolves.toBe(distFile);
  });

  it("fails clearly when the dist file is missing", async () => {
    const missing = path.join(os.tmpdir(), "deploy-ui-missing-index.html");
    await expect(requireDistFile(missing)).rejects.toThrow(
      `Dist file not found: ${missing}`,
    );
    await expect(requireDistFile(missing)).rejects.toThrow(
      "npm run deploy-find-ui",
    );
  });
});

describe("deploy-find-ui deploy", () => {
  it("connects via plain FTP and uploads over index.html", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const client = makeClient();
      const distFile = await makeDistFile();
      await deploy({
        client,
        host: "ftp.example.com",
        user: "deploy-user",
        password: "s3cret",
        remoteFolder: "/public_html/find",
        localFile: distFile,
      });
      expect(client.access).toHaveBeenCalledWith({
        host: "ftp.example.com",
        user: "deploy-user",
        password: "s3cret",
        secure: false,
      });
      expect(client.cd).toHaveBeenCalledWith("/public_html/find");
      expect(client.uploadFrom).toHaveBeenCalledWith(distFile, "index.html");
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('"/public_html/find/index.html"'),
      );
      expect(client.close).toHaveBeenCalledTimes(1);
      for (const call of log.mock.calls) {
        expect(call.join(" ")).not.toContain("s3cret");
      }
    } finally {
      log.mockRestore();
    }
  });

  it("closes the client even when the upload fails", async () => {
    const client = makeClient();
    client.uploadFrom.mockRejectedValueOnce(new Error("denied"));
    await expect(
      deploy({
        client,
        host: "ftp.example.com",
        user: "deploy-user",
        password: "s3cret",
        remoteFolder: "/public_html/find",
        localFile: "/tmp/index.html",
      }),
    ).rejects.toThrow("denied");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces the upload error even when close throws", async () => {
    const client = makeClient();
    client.uploadFrom.mockRejectedValueOnce(new Error("denied"));
    client.close.mockImplementationOnce(() => {
      throw new Error("close failed");
    });
    await expect(
      deploy({
        client,
        host: "ftp.example.com",
        user: "deploy-user",
        password: "s3cret",
        remoteFolder: "/public_html/find",
        localFile: "/tmp/index.html",
      }),
    ).rejects.toThrow("denied");
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});

describe("deploy-find-ui main", () => {
  it("deploys through injected dependencies without logging secrets", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const distFile = await makeDistFile();
      const client = makeClient();
      const connect = vi.fn(() => client);
      const deployFn = vi.fn(async () => {});
      await main({ env: fullEnv, distFile, connect, deployFn });
      expect(connect).toHaveBeenCalledTimes(1);
      expect(deployFn).toHaveBeenCalledWith({
        client,
        host: "ftp.example.com",
        user: "deploy-user",
        password: "s3cret",
        remoteFolder: "/public_html/find",
        localFile: distFile,
      });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("ftp.example.com"),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("FTP (insecure, plain)"),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Deploy complete."),
      );
      for (const call of log.mock.calls) {
        expect(call.join(" ")).not.toContain("s3cret");
      }
    } finally {
      log.mockRestore();
    }
  });

  it("exits when env vars are missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withExit(() => main({ env: {} }));
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Missing required env vars"),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("exits when the dist file is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const missing = path.join(os.tmpdir(), "deploy-ui-missing-index.html");
      const connect = vi.fn(() => makeClient());
      await withExit(() => main({ env: fullEnv, distFile: missing, connect }));
      expect(connect).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Dist file not found"),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("exits when the FTP deploy fails without logging secrets", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const distFile = await makeDistFile();
      const deployFn = vi.fn(async () => {
        throw new Error("connection refused");
      });
      await withExit(() => main({ env: fullEnv, distFile, deployFn }));
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Deploy failed: connection refused"),
      );
      expect(error.mock.calls.join(" ")).not.toContain("s3cret");
    } finally {
      error.mockRestore();
    }
  });
});
