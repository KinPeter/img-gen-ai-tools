import "dotenv/config";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "basic-ftp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export const defaultPaths = {
  distFile: path.join(scriptDirectory, "dist", "index.html"),
};

export const REQUIRED_ENV_VARS = [
  "FTP_HOST",
  "FTP_USER",
  "FTP_PASS",
  "LOG_FIND_UI_FTP_FOLDER",
];

export function requireEnv(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter(
    (name) => env[name] == null || String(env[name]).trim() === "",
  );
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  const host = String(env.FTP_HOST).trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(host)) {
    throw new Error(
      `FTP_HOST should be a bare hostname, not a URL (got "${host}").`,
    );
  }
  return {
    host,
    user: String(env.FTP_USER).trim(),
    password: String(env.FTP_PASS).trim(),
    remoteFolder: String(env.LOG_FIND_UI_FTP_FOLDER).trim(),
  };
}

export function createFtpClient() {
  return new Client();
}

export async function requireDistFile(distFile = defaultPaths.distFile) {
  try {
    await access(distFile);
  } catch {
    throw new Error(
      `Dist file not found: ${distFile} — run "npm run deploy-find-ui" (or "npm run build-find-ui") first.`,
    );
  }
  return distFile;
}

export async function deploy({
  client,
  host,
  user,
  password,
  remoteFolder,
  localFile = defaultPaths.distFile,
}) {
  try {
    await client.access({ host, user, password, secure: false });
    await client.cd(remoteFolder);
    await client.uploadFrom(localFile, "index.html");
    console.log(
      `Uploaded ${localFile} to "${remoteFolder}/index.html" (overwritten if present).`,
    );
  } finally {
    try {
      client.close();
    } catch {
      // Ignore close errors so the original deploy error stays actionable.
    }
  }
}

export async function main({
  env = process.env,
  distFile = defaultPaths.distFile,
  connect = createFtpClient,
  deployFn = deploy,
} = {}) {
  let config;
  try {
    config = requireEnv(env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
    return;
  }

  try {
    await requireDistFile(distFile);
    const client = connect();
    console.log(`Connecting to ${config.host} via FTP (insecure, plain)...`);
    await deployFn({ client, ...config, localFile: distFile });
    console.log("Deploy complete.");
  } catch (error) {
    console.error(`Deploy failed: ${error.message}`);
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
