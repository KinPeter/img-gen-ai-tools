import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLACEHOLDER,
  build,
  defaultPaths,
  injectUrl,
  main,
  requireLambdaUrl,
} from "../../logging/build-find-ui.mjs";

const dirs = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

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

const makeTemplate = async (contents) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-find-ui-"));
  dirs.push(root);
  const templatePath = path.join(root, "template.html");
  await writeFile(templatePath, contents);
  return { root, templatePath };
};

describe("build-find-ui env", () => {
  it("requires LOG_FIND_LAMBDA_URL and trims it", () => {
    expect(
      requireLambdaUrl({ LOG_FIND_LAMBDA_URL: " https://example.com/x " }),
    ).toBe("https://example.com/x");
    expect(() => requireLambdaUrl({})).toThrow(
      "Missing required env var: LOG_FIND_LAMBDA_URL",
    );
    expect(() => requireLambdaUrl({ LOG_FIND_LAMBDA_URL: "   " })).toThrow(
      "Missing required env var: LOG_FIND_LAMBDA_URL",
    );
  });
});

describe("build-find-ui injectUrl", () => {
  it("replaces every placeholder occurrence", () => {
    const template = `<a href="${PLACEHOLDER}">x</a><script>fetch("${PLACEHOLDER}")</script>`;
    const html = injectUrl(template, "https://example.com/find");
    expect(html).toBe(
      '<a href="https://example.com/find">x</a><script>fetch("https://example.com/find")</script>',
    );
    expect(html).not.toContain(PLACEHOLDER);
  });

  it("refuses a template without the placeholder", () => {
    expect(() => injectUrl("<html>no token here</html>", "https://x")).toThrow(
      `Template is missing placeholder ${PLACEHOLDER}`,
    );
  });
});

describe("build-find-ui build and main", () => {
  it("exposes default template and output paths", () => {
    expect(path.basename(defaultPaths.templateFile)).toBe("log-find-ui.html");
    expect(path.basename(defaultPaths.outFile)).toBe("index.html");
    expect(path.basename(path.dirname(defaultPaths.outFile))).toBe("dist");
  });

  it("writes the injected html and creates nested dirs", async () => {
    const { root, templatePath } = await makeTemplate(
      `<html><body>${PLACEHOLDER} and ${PLACEHOLDER}</body></html>`,
    );
    const outPath = path.join(root, "nested", "deep", "index.html");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await build({
        env: { LOG_FIND_LAMBDA_URL: "https://lambda.example/find" },
        templatePath,
        outPath,
      });
      const written = await readFile(outPath, "utf8");
      expect(written).toContain("https://lambda.example/find");
      expect(written).not.toContain(PLACEHOLDER);
      expect(result).toMatchObject({
        url: "https://lambda.example/find",
        templatePath,
        outPath,
      });
      expect(result.bytes).toBe(Buffer.byteLength(written, "utf8"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining(outPath));
    } finally {
      log.mockRestore();
    }
  });

  it("fails when the template lacks the placeholder", async () => {
    const { templatePath } = await makeTemplate("<html>plain</html>");
    await expect(
      build({
        env: { LOG_FIND_LAMBDA_URL: "https://x" },
        templatePath,
        outPath: path.join(os.tmpdir(), "build-find-ui-never-written.html"),
      }),
    ).rejects.toThrow(`Template is missing placeholder ${PLACEHOLDER}`);
  });

  it("main exits when env is missing and succeeds otherwise", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { templatePath } = await makeTemplate(`<p>${PLACEHOLDER}</p>`);
      await withExit(() =>
        main({
          env: {},
          templatePath,
          outPath: path.join(os.tmpdir(), "build-find-ui-never-written.html"),
        }),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("LOG_FIND_LAMBDA_URL"),
      );
    } finally {
      error.mockRestore();
    }

    const { root, templatePath } = await makeTemplate(`<p>${PLACEHOLDER}</p>`);
    const outPath = path.join(root, "dist", "index.html");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main({
        env: { LOG_FIND_LAMBDA_URL: "https://lambda.example/find" },
        templatePath,
        outPath,
      });
      expect(await readFile(outPath, "utf8")).toContain(
        "https://lambda.example/find",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("main exits when the template file cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withExit(() =>
        main({
          env: { LOG_FIND_LAMBDA_URL: "https://x" },
          templatePath: path.join(
            os.tmpdir(),
            "build-find-ui-missing-template.html",
          ),
          outPath: path.join(os.tmpdir(), "build-find-ui-never-written.html"),
        }),
      );
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
