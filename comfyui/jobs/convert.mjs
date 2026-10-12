import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const LOCAL_OUTPUT_PATH = path.join(import.meta.dirname, "..", "..", "output");
const LOCAL_DIST_PATH = path.join(import.meta.dirname, "..", "..", "dist");

export function distPathFor({ distBaseDir, filename, relativeDir = "" }) {
  return path.join(
    distBaseDir,
    relativeDir,
    `${path.parse(filename).name}.jpg`,
  );
}

export async function convertToJpg(srcPath, destPath) {
  await mkdir(path.dirname(destPath), { recursive: true });
  await sharp(srcPath).jpeg({ quality: 90 }).toFile(destPath);
  return destPath;
}

export async function collectPngFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectPngFiles(full)));
    } else if (
      entry.isFile() &&
      path.extname(entry.name).toLowerCase() === ".png"
    ) {
      found.push(full);
    }
  }
  return found.sort();
}

function safeRelativeDir(baseDir, targetDir) {
  const rel = path.relative(baseDir, targetDir);
  if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    return "";
  }
  return rel;
}

export async function convertOutputs(
  saved,
  { outputBaseDir = LOCAL_OUTPUT_PATH, distBaseDir = LOCAL_DIST_PATH } = {},
) {
  for (const file of saved) {
    const src = path.join(file.destDir, file.filename);
    const dest = distPathFor({
      distBaseDir,
      filename: file.filename,
      relativeDir: safeRelativeDir(outputBaseDir, file.destDir),
    });
    try {
      await convertToJpg(src, dest);
      console.log(`Converted: ${dest}`);
    } catch (err) {
      console.error(`Could not convert ${src}: ${err.message}`);
    }
  }
}

export async function convertAll({ outputDir, distDir }) {
  const files = await collectPngFiles(outputDir);
  let done = 0;
  for (const src of files) {
    const dest = distPathFor({
      distBaseDir: distDir,
      filename: path.basename(src),
      relativeDir: safeRelativeDir(outputDir, path.dirname(src)),
    });
    try {
      await convertToJpg(src, dest);
      console.log(`Converted: ${dest}`);
      done++;
    } catch (err) {
      console.error(`Could not convert ${src}: ${err.message}`);
    }
  }
  console.log(`Done: ${done}/${files.length} converted.`);
  return { done, total: files.length };
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const root = path.join(import.meta.dirname, "..", "..");
  await convertAll({
    outputDir: path.join(root, "output"),
    distDir: path.join(root, "dist"),
  });
}
