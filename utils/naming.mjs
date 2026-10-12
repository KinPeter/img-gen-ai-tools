import path from "node:path";

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function resolvePrefix(filenamePrefix) {
  if (filenamePrefix != null && String(filenamePrefix).trim() !== "") {
    return path.basename(String(filenamePrefix).trim());
  }
  return "output";
}

export function destFileName({ prefix, ts, index, ext }) {
  return index === 0 ? `${prefix}_${ts}${ext}` : `${prefix}_${ts}_${index}${ext}`;
}
