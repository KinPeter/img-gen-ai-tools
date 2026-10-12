export function collectOutputImages(outputs) {
  return Object.values(outputs ?? {})
    .flatMap((node) => node.images ?? [])
    .filter((img) => img?.type === "output");
}
