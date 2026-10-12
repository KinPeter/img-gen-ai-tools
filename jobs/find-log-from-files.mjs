import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export function normalizeToPngFilename(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const forward = raw.replace(/\\/g, "/");
  const base = path.posix.basename(forward);
  if (!base) return null;
  const name = path.parse(base).name;
  if (!name) return null;
  return `${name}.png`;
}

async function collectJsonFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return found;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectJsonFiles(full)));
    } else if (
      entry.isFile() &&
      path.extname(entry.name).toLowerCase() === ".json"
    ) {
      found.push(full);
    }
  }
  return found.sort();
}

export async function findLogEntry({ logsDir, targetFilename }) {
  const files = await collectJsonFiles(logsDir);
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch {
      console.warn(`Skipping unreadable log file: ${file}`);
      continue;
    }
    const entries = Array.isArray(data) ? data : [data];
    for (const entry of entries) {
      if (
        entry &&
        typeof entry === "object" &&
        entry.filename === targetFilename
      ) {
        return { entry, sourceFile: file };
      }
    }
  }
  return null;
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function lookupAndPrint(logsDir, rawInput) {
  const target = normalizeToPngFilename(rawInput);
  if (!target) {
    console.error(
      `Could not parse a filename from: ${JSON.stringify(rawInput.trim())}`,
    );
    return;
  }
  const found = await findLogEntry({ logsDir, targetFilename: target });
  if (!found) {
    console.error(`No log entry found for filename: ${target}`);
    return;
  }
  console.log(JSON.stringify(found.entry, null, 2));
}

if (isMain) {
  const logsDir = path.join(import.meta.dirname, "..", "output", "logs");
  const first = process.argv[2];
  if (first) await lookupAndPrint(logsDir, first);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => rl.close());
  process.stdout.write("> ");
  for await (const line of rl) {
    if (line.trim() !== "") await lookupAndPrint(logsDir, line);
    process.stdout.write("> ");
  }
}
