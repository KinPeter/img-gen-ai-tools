/**
 * Regenerate golden JSON files for e2e workflow building tests.
 *
 * This script mimics the exact seed sequence that the test suite uses:
 * each test runs in isolation (isolate: true), so Math.random._callCount
 * is reset to 0 before each test. Therefore every test starts from
 * DETERMINISTIC_SEEDS[0].
 */

import { readdir, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadWorkflows } from "../../../../comfyui/workflows/workflow.mjs";

const FIXTURES_BASE = path.join(import.meta.dirname, "base-workflows");
const INPUTS_DIR = path.join(import.meta.dirname, "inputs");
const GOLDEN_DIR = path.join(import.meta.dirname, "golden");

// These are the deterministic seeds, indexed per test (each test starts at 0).
const DETERMINISTIC_SEEDS = [
  1000000001, 1000000002, 1000000003, 2000000001, 2000000002, 3000000001,
  3000000002, 3000000003, 3000000004, 4000000001, 4000000002, 4000000003,
  5000000001, 6000000001, 6000000002, 6000000003,
];

const _origRandom = Math.random;

async function generateGoldenForInput(inputName, callCountRef) {
  const _origRand = Math.random;
  Math.random = () => {
    const seqIdx = callCountRef.current++;
    if (seqIdx < DETERMINISTIC_SEEDS.length) {
      return DETERMINISTIC_SEEDS[seqIdx] / Number.MAX_SAFE_INTEGER;
    }
    return _origRandom();
  };

  try {
    const workflows = await loadWorkflows(inputName, INPUTS_DIR, FIXTURES_BASE);
    return { ok: true, count: workflows.length, workflows };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    Math.random = _origRand;
  }
}

async function main() {
  try {
    await rm(GOLDEN_DIR, { recursive: true, force: true });
  } catch {
    // Golden dir may not exist yet — ignore
  }
  await mkdir(GOLDEN_DIR, { recursive: true });

  const inputs = (await readdir(INPUTS_DIR)).sort();

  console.log(`\n=== Golden file regeneration (per-test isolation) ===`);
  console.log(`Inputs dir:  ${INPUTS_DIR}`);
  console.log(`Golden dir:  ${GOLDEN_DIR}\n`);

  let success = 0;
  let failed = 0;

  for (const inputFile of inputs) {
    const baseName = inputFile.replace(/\.yaml$/, "");
    const callCountRef = { current: 0 };
    const result = await generateGoldenForInput(baseName, callCountRef);

    if (result.ok) {
      const outputs = result.workflows.map((w) => ({
        workflow: w.workflow,
        input: w.input,
      }));
      const goldenPath = path.join(GOLDEN_DIR, `${baseName}.json`);
      await writeFile(
        goldenPath,
        JSON.stringify(outputs, null, 2) + "\n",
        "utf8",
      );
      console.log(
        `✓ ${inputFile} → ${result.count} workflow(s) → ${goldenPath}`,
      );
      success++;
    } else {
      console.log(`✗ ${inputFile} → ${result.error}`);
      failed++;
    }
  }

  console.log(`\n${success} succeeded, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
