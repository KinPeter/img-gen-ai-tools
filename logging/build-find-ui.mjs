import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export const PLACEHOLDER = "__LOG_FIND_LAMBDA_URL__";

export const defaultPaths = {
  templateFile: path.join(scriptDirectory, "log-find-ui.html"),
  outFile: path.join(scriptDirectory, "dist", "index.html"),
};

export function requireLambdaUrl(env = process.env) {
  const url = env.LOG_FIND_LAMBDA_URL;
  if (url == null || String(url).trim() === "") {
    throw new Error("Missing required env var: LOG_FIND_LAMBDA_URL");
  }
  return String(url).trim();
}

export function injectUrl(template, url) {
  if (!String(template).includes(PLACEHOLDER)) {
    throw new Error(
      `Template is missing placeholder ${PLACEHOLDER} — refusing to write an unconfigured artifact.`,
    );
  }
  return String(template).split(PLACEHOLDER).join(String(url));
}

export async function build({
  env = process.env,
  templatePath = defaultPaths.templateFile,
  outPath = defaultPaths.outFile,
} = {}) {
  const url = requireLambdaUrl(env);
  const template = await readFile(templatePath, "utf8");
  const html = injectUrl(template, url);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html);
  const bytes = Buffer.byteLength(html, "utf8");
  console.log(`Wrote ${bytes} bytes to ${outPath} (from ${templatePath}).`);
  return { url, templatePath, outPath, bytes };
}

export async function main({
  env = process.env,
  templatePath = defaultPaths.templateFile,
  outPath = defaultPaths.outFile,
} = {}) {
  try {
    await build({ env, templatePath, outPath });
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(1);
    return;
  }
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
