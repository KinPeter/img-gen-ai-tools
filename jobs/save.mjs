import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchImage } from "./comfy.mjs";
import { resolveDestDir } from "../utils/paths.mjs";
import { resolvePrefix, timestamp, destFileName } from "../utils/naming.mjs";
import { collectOutputImages } from "../utils/outputs.mjs";

export async function saveOutputs({
  server,
  destBaseDir,
  input,
  historyEntry,
}) {
  const destDir = resolveDestDir(destBaseDir, input?.["output-folder"]);
  await mkdir(destDir, { recursive: true });

  const ts = timestamp();
  const prefix = resolvePrefix(input?.["filename-prefix"]);

  const saved = [];
  let n = 0;
  for (const img of collectOutputImages(historyEntry.outputs)) {
    const filename = destFileName({
      prefix,
      ts,
      index: n,
      ext: path.extname(img.filename) || ".png",
    });
    n++;
    const dest = path.join(destDir, filename);
    try {
      await writeFile(dest, await fetchImage(server, img));
      console.log(`Saved: ${dest}`);
      saved.push({ filename, destDir });
    } catch (err) {
      console.error(`Could not save ${img.filename}: ${err.message}`);
    }
  }
  return saved;
}
