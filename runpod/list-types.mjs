import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function listGpuTypes({
  cudaVersion = "12.8",
  maxPrice = 1,
} = {}) {
  const res = await fetch(
    "https://api.runpod.io/v2/catalog/gpus?count=1&product=POD&include=AVAILABILITY",
    {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` },
    },
  );
  if (!res.ok) {
    throw new Error(`RunPod API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  return data.gpus
    .filter(
      (i) =>
        i.secure &&
        ["LOW", "MEDIUM", "HIGH"].includes(i.availability) &&
        !!(i.cudaVersions ?? []).find((v) => v.version === cudaVersion) &&
        (i.price?.secure ?? 1000) < maxPrice,
    )
    .map((i) => ({
      name: i.name,
      id: i.id,
      price: i.price.secure,
      availability: i.availability,
    }))
    .sort((a, b) => a.price - b.price);
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  listGpuTypes().then(
    (data) => console.log(JSON.stringify(data, null, 2)),
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}
