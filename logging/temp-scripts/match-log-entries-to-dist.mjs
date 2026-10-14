import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, "../..");

export const defaultPaths = {
  logsDirectory: path.join(repositoryDirectory, "output", "logs"),
  distDirectory: path.join(repositoryDirectory, "dist"),
  outputFile: path.join(scriptDirectory, "matching-log-entries.json"),
};

async function collectFiles(directory, predicate) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(file, predicate)));
    } else if (entry.isFile() && predicate(entry.name)) {
      files.push(file);
    }
  }
  return files.sort();
}

function filenameStem(filename) {
  const normalized = String(filename ?? "").replace(/\\/g, "/");
  const basename = path.posix.basename(normalized);
  return basename ? path.parse(basename).name : null;
}

export async function collectMatchingLogEntries({
  logsDirectory = defaultPaths.logsDirectory,
  distDirectory = defaultPaths.distDirectory,
} = {}) {
  const distFiles = await collectFiles(
    distDirectory,
    (filename) => path.extname(filename).toLowerCase() === ".jpg",
  );
  const distStems = new Set(
    distFiles.map((file) => filenameStem(path.basename(file))).filter(Boolean),
  );
  const logFiles = await collectFiles(
    logsDirectory,
    (filename) => path.extname(filename).toLowerCase() === ".json",
  );
  const matches = [];

  for (const logFile of logFiles) {
    let data;
    try {
      data = JSON.parse(await readFile(logFile, "utf8"));
    } catch {
      console.warn(`Skipping unreadable log file: ${logFile}`);
      continue;
    }

    const entries = Array.isArray(data) ? data : [data];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const stem = filenameStem(entry.filename);
      if (stem && distStems.has(stem)) {
        matches.push({ [stem]: entry });
      }
    }
  }

  return matches;
}

export async function writeMatchingLogEntries({
  logsDirectory = defaultPaths.logsDirectory,
  distDirectory = defaultPaths.distDirectory,
  outputFile = defaultPaths.outputFile,
} = {}) {
  const matches = await collectMatchingLogEntries({
    logsDirectory,
    distDirectory,
  });
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(matches, null, 2)}\n`);
  return matches;
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const matches = await writeMatchingLogEntries();
  console.log(
    `Wrote ${matches.length} matching log entries to ${defaultPaths.outputFile}`,
  );
}
