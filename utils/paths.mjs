import path from "node:path";

export function resolveDestDir(baseDir, outputFolder) {
  const base = path.normalize(baseDir);
  if (outputFolder == null || String(outputFolder).trim() === "") {
    return base;
  }
  const resolved = path.normalize(
    path.join(base, String(outputFolder).trim()),
  );
  if (resolved === base || resolved.startsWith(base + path.sep)) {
    return resolved;
  }
  console.warn(`Ignoring unsafe output-folder: ${JSON.stringify(outputFolder)}`);
  return base;
}
