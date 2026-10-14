import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, "../..");

export const defaultPaths = {
  inputFile: path.join(
    repositoryDirectory,
    ".tmp",
    "matching-log-entries.json",
  ),
};

export const REQUIRED_ENV_VARS = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_LOGS_TABLE_NAME",
];

// ASSUMPTION: the DynamoDB table uses a String partition key holding the
// image base filename WITHOUT extension. The attribute names default to
// `filename` (key) and `data` (JSON-stringified log entry) but are
// configurable via AWS_LOGS_KEY_ATTRIBUTE / AWS_LOGS_DATA_ATTRIBUTE because
// the real key schema is unknown. If the table key has a different name or
// type, set AWS_LOGS_KEY_ATTRIBUTE accordingly.
export const DEFAULT_KEY_ATTRIBUTE = "filename";
export const DEFAULT_DATA_ATTRIBUTE = "data";

export function requireEnv(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter(
    (name) => env[name] == null || String(env[name]).trim() === "",
  );
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  const keyAttribute =
    env.AWS_LOGS_KEY_ATTRIBUTE == null ||
    String(env.AWS_LOGS_KEY_ATTRIBUTE).trim() === ""
      ? DEFAULT_KEY_ATTRIBUTE
      : String(env.AWS_LOGS_KEY_ATTRIBUTE).trim();
  const dataAttribute =
    env.AWS_LOGS_DATA_ATTRIBUTE == null ||
    String(env.AWS_LOGS_DATA_ATTRIBUTE).trim() === ""
      ? DEFAULT_DATA_ATTRIBUTE
      : String(env.AWS_LOGS_DATA_ATTRIBUTE).trim();
  if (keyAttribute === dataAttribute) {
    throw new Error(
      "AWS_LOGS_KEY_ATTRIBUTE and AWS_LOGS_DATA_ATTRIBUTE must differ",
    );
  }
  return {
    region: String(env.AWS_REGION).trim(),
    accessKeyId: String(env.AWS_ACCESS_KEY_ID).trim(),
    secretAccessKey: String(env.AWS_SECRET_ACCESS_KEY).trim(),
    tableName: String(env.AWS_LOGS_TABLE_NAME).trim(),
    keyAttribute,
    dataAttribute,
  };
}

// Strips only the last extension ("a.b.c" -> "a.b"). Extensionless names,
// leading-dot dotfiles (".gitignore"), and bare "." pass through
// unchanged; ".." collapses to "." via basename/dot-stripping and a
// trailing dot ("file.") is stripped to ("file"). Applies
// path.basename first (after normalizing backslashes so a stray Windows
// path like "C:\dir\file.png" still yields the base stem) so a stray
// directory component ("dir/file.png") still yields the base stem
// instead of breaking.
export function stripExtension(filename) {
  const base = path.basename(String(filename ?? "").replace(/\\/g, "/"));
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0) {
    return base;
  }
  return base.slice(0, dotIndex);
}

// ASSUMPTION about .tmp/matching-log-entries.json: the top level must be an
// array of single-key objects `{ "<stem>": logEntry }`, where each logEntry
// has a `filename` field (e.g. "bp-cp_20261005233501.png"). The DynamoDB key
// is the base filename WITHOUT extension (e.g. "bp-cp_20261005233501"),
// stripped from the `filename` field value and likewise stripped when
// falling back to the outer wrapper key. Bare (unwrapped) log-entry objects
// are accepted too. Non-array input is wrapped as a single element and will
// usually yield zero valid entries.
export function flattenLogEntries(raw) {
  const elements = Array.isArray(raw) ? raw : [raw];
  const items = [];
  const skipped = [];
  for (const element of elements) {
    if (!element || typeof element !== "object" || Array.isArray(element)) {
      skipped.push(element);
      continue;
    }
    let filename = null;
    let logEntry = null;
    if (typeof element.filename === "string" && element.filename !== "") {
      filename = stripExtension(element.filename);
      logEntry = element;
    } else {
      const keys = Object.keys(element);
      if (keys.length === 1) {
        const inner = element[keys[0]];
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          filename =
            typeof inner.filename === "string" && inner.filename !== ""
              ? stripExtension(inner.filename)
              : stripExtension(keys[0]);
          logEntry = inner;
        }
      }
    }
    if (filename == null || logEntry == null) {
      skipped.push(element);
      continue;
    }
    items.push({ filename, logEntry });
  }
  return { items, skipped };
}

export function buildPutItem({
  tableName,
  keyAttribute,
  dataAttribute,
  filename,
  logEntry,
}) {
  if (keyAttribute === dataAttribute) {
    throw new Error(
      "AWS_LOGS_KEY_ATTRIBUTE and AWS_LOGS_DATA_ATTRIBUTE must differ",
    );
  }
  return {
    TableName: tableName,
    Item: {
      [keyAttribute]: filename,
      [dataAttribute]: JSON.stringify(logEntry),
    },
  };
}

export async function uploadLogEntries({
  docClient,
  tableName,
  keyAttribute,
  dataAttribute,
  items,
  onProgress,
}) {
  let uploaded = 0;
  const failures = [];
  for (const [index, { filename, logEntry }] of items.entries()) {
    try {
      await docClient.send(
        new PutCommand(
          buildPutItem({
            tableName,
            keyAttribute,
            dataAttribute,
            filename,
            logEntry,
          }),
        ),
      );
      uploaded += 1;
    } catch (error) {
      failures.push({ filename, error });
    }
    if (onProgress) {
      onProgress({ done: index + 1, total: items.length, filename });
    }
  }
  return { uploaded, failures };
}

export function createDocClient({ region, accessKeyId, secretAccessKey }) {
  const client = new DynamoDBClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  return DynamoDBDocumentClient.from(client);
}

export function parseCliArgs(
  argv = process.argv.slice(2),
  defaultInputFile = defaultPaths.inputFile,
) {
  const dryRun = argv.includes("--dry-run");
  const positional = argv.find(
    (arg) => arg !== "--dry-run" && arg !== "--yes" && arg !== "",
  );
  return {
    inputFile: positional == null ? defaultInputFile : path.resolve(positional),
    dryRun,
  };
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let config;
  try {
    config = requireEnv();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const { inputFile, dryRun } = parseCliArgs(
    process.argv.slice(2),
    defaultPaths.inputFile,
  );

  let raw;
  try {
    raw = JSON.parse(await readFile(inputFile, "utf8"));
  } catch (error) {
    console.error(
      `Could not read log entries from ${inputFile}: ${error.message}`,
    );
    process.exit(1);
  }

  const { items, skipped } = flattenLogEntries(raw);
  if (skipped.length > 0) {
    console.warn(`Skipping ${skipped.length} malformed entries.`);
  }
  if (items.length === 0) {
    console.error("No valid log entries to upload.");
    process.exit(1);
  }
  if (new Set(items.map((item) => item.filename)).size !== items.length) {
    console.warn(
      "Duplicate keys (base filenames) detected; later entries overwrite earlier ones.",
    );
  }

  if (dryRun) {
    console.log(
      `Dry run: would upload ${items.length} log entries to DynamoDB table "${config.tableName}" ` +
        `in region "${config.region}" ` +
        `(key="${config.keyAttribute}", value="${config.dataAttribute}"). Sending nothing.`,
    );
    for (const { filename, logEntry } of items.slice(0, 5)) {
      console.log(
        JSON.stringify(
          buildPutItem({
            tableName: config.tableName,
            keyAttribute: config.keyAttribute,
            dataAttribute: config.dataAttribute,
            filename,
            logEntry,
          }),
        ),
      );
    }
    process.exit(0);
  }

  console.log(
    `Uploading ${items.length} log entries to DynamoDB table "${config.tableName}" ` +
      `(key="${config.keyAttribute}", value="${config.dataAttribute}")...`,
  );
  const docClient = createDocClient(config);
  const { uploaded, failures } = await uploadLogEntries({
    docClient,
    tableName: config.tableName,
    keyAttribute: config.keyAttribute,
    dataAttribute: config.dataAttribute,
    items,
    onProgress: ({ done, total, filename }) => {
      if (done % 25 === 0 || done === total) {
        console.log(`Progress: ${done}/${total} (last: ${filename})`);
      }
    },
  });

  console.log(`Uploaded ${uploaded}/${items.length} entries.`);
  if (failures.length > 0) {
    for (const { filename, error } of failures.slice(0, 10)) {
      console.error(`Failed ${filename}: ${error?.message ?? error}`);
    }
    if (failures.length > 10) {
      console.error(`... and ${failures.length - 10} more failures.`);
    }
    process.exit(1);
  }
}
