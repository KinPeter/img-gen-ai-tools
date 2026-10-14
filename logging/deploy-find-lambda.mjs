import "dotenv/config";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  GetFunctionCommand,
  LambdaClient,
  UpdateFunctionCodeCommand,
} from "@aws-sdk/client-lambda";

const execFileAsync = promisify(execFile);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export const defaultPaths = {
  lambdaFile: path.join(scriptDirectory, "log-find-lambda.mjs"),
};

export const REQUIRED_ENV_VARS = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_LOGS_FIND_LAMBDA_NAME",
];

export function requireEnv(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter(
    (name) => env[name] == null || String(env[name]).trim() === "",
  );
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  return {
    region: String(env.AWS_REGION).trim(),
    accessKeyId: String(env.AWS_ACCESS_KEY_ID).trim(),
    secretAccessKey: String(env.AWS_SECRET_ACCESS_KEY).trim(),
    functionName: String(env.AWS_LOGS_FIND_LAMBDA_NAME).trim(),
  };
}

export function createLambdaClient({ region, accessKeyId, secretAccessKey }) {
  return new LambdaClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
}

// Zips only the lambda file (SDK imports resolve from the Lambda runtime)
// keeping its basename so the console Handler stays `<basename>.handler`.
export async function createZipBuffer(lambdaFile = defaultPaths.lambdaFile) {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "deploy-find-lambda-"));
  const zipPath = path.join(workdir, "function.zip");
  try {
    const staged = path.join(workdir, path.basename(lambdaFile));
    await copyFile(lambdaFile, staged);
    await execFileAsync("zip", ["-j", "-q", zipPath, staged]);
    return await readFile(zipPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "The `zip` binary is required to package the lambda (or the lambda file is missing).",
        { cause: error },
      );
    }
    throw error;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForSuccessfulUpdate(
  lambdaClient,
  functionName,
  { maxAttempts = 40, intervalMs = 3000 } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { Configuration } = await lambdaClient.send(
      new GetFunctionCommand({ FunctionName: functionName }),
    );
    const status = Configuration?.LastUpdateStatus;
    if (status === "Successful") return Configuration;
    if (status === "Failed") {
      throw new Error(
        `Lambda update failed: ${Configuration?.LastUpdateStatusReason ?? "unknown reason"}`,
      );
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for the Lambda update to succeed.");
}

export async function deploy({ lambdaClient, functionName, zipBuffer }) {
  const update = await lambdaClient.send(
    new UpdateFunctionCodeCommand({
      FunctionName: functionName,
      ZipFile: zipBuffer,
    }),
  );
  console.log(`Code update sent (version ${update.Version}). Waiting...`);
  const configuration = await waitForSuccessfulUpdate(
    lambdaClient,
    functionName,
  );
  return { update, configuration };
}

export async function main({
  env = process.env,
  zipLambdaFile = defaultPaths.lambdaFile,
  createZip = createZipBuffer,
  connect = createLambdaClient,
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
    const zipBuffer = await createZip(zipLambdaFile);
    console.log(
      `Deploying ${path.basename(defaultPaths.lambdaFile)} (${zipBuffer.length} bytes zipped) to "${config.functionName}" in ${config.region}...`,
    );
    const lambdaClient = connect(config);
    const { update } = await deployFn({
      lambdaClient,
      functionName: config.functionName,
      zipBuffer,
    });
    console.log(
      `Deployed version ${update.Version}. Ensure the Lambda Handler is "${path.parse(defaultPaths.lambdaFile).name}.handler".`,
    );
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
