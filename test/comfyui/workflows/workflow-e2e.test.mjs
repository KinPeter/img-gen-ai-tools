/**
 * End-to-end tests for workflow building: YAML input → workflow JSON output.
 *
 * These tests read input YAML files from `inputs/`, run them through
 * `loadWorkflows()` using the fixture base workflows from `base-workflows/`,
 * and compare the result against pre-generated golden JSON files in `golden/`.
 *
 * Each test verifies that the workflow structure (node graph, inputs, overrides)
 * matches the expected golden file exactly.
 *
 * NOTE: These are happy-path tests only. Error/validation paths for invalid
 * inputs (bad YAML, missing fields, invalid tries/loras values) are covered
 * by the unit tests in `test/comfyui/workflow-builder/workflow.test.mjs`.
 *
 * See AGENTS.md → "ComfyUI workflow building tests" for guidance on keeping
 * these tests updated when workflow-building logic changes.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { loadWorkflows } from "../../../comfyui/workflow-builder/workflow.mjs";

const FIXTURES_BASE = path.join(import.meta.dirname, "base-workflows");
const INPUTS_DIR = path.join(import.meta.dirname, "inputs");
const GOLDEN_DIR = path.join(import.meta.dirname, "golden");

/**
 * Helper that reads all YAML files from the inputs directory and returns
 * their basenames sorted alphabetically (matching golden file names).
 */
async function getInputFiles() {
  const allFiles = await readdir(INPUTS_DIR);
  return allFiles.filter((f) => f.endsWith(".yaml")).sort();
}

let inputFiles = [];
let goldenBasenames = new Set();

beforeAll(async () => {
  inputFiles = await getInputFiles();

  // Also populate golden basenames for the "golden files exist" test
  const goldenFiles = await readdir(GOLDEN_DIR);
  goldenBasenames = new Set(
    goldenFiles
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, "")),
  );
});

// Patch Math.random for deterministic seeds across all tests.
//
// IMPORTANT: beforeEach resets Math.random._callCount to 0 before each test,
// so every test starts from index 0 of this array. The seeds below are
// allocated per-test, not cumulatively across the suite. Each test that
// needs deterministic seeds calls loadWorkflows(), which internally invokes
// getRandomSeed() — that's where the Math.random calls happen.
//
// Per-test seed allocation:
//   test-12 (3 tries): indices 0..2
//   test-18 (2 brace variants): indices 0..1
//   test-19 (4 brace cartesian): indices 0..3
//   test-20 (3 brace variants): indices 0..2
//   test-22 (seed=random, tries=1): index 0
//   test-29 (entry0 tries=2 + entry1 tries=1): indices 0..2
//
// If workflow.mjs changes the order of getRandomSeed() calls, regenerate
// the golden files (see AGENTS.md → "ComfyUI workflow building tests").
const DETERMINISTIC_SEEDS = [
  // test 12: tries=3
  1000000001, 1000000002, 1000000003,
  // test 18: brace 2 variants
  2000000001, 2000000002,
  // test 19: brace 4 variants
  3000000001, 3000000002, 3000000003, 3000000004,
  // test 20: brace 3 variants
  4000000001, 4000000002, 4000000003,
  // test 22: seed=random, tries=1
  5000000001,
  // test 29: entry0 tries=2 + entry1 tries=1
  6000000001, 6000000002, 6000000003,
  // test 31: clip-skip create
  7000000001,
];

const _origRandom = Math.random;
Math.random = () => {
  const seqIdx = Math.random._callCount ?? 0;
  Math.random._callCount = seqIdx + 1;
  if (seqIdx < DETERMINISTIC_SEEDS.length) {
    return DETERMINISTIC_SEEDS[seqIdx] / Number.MAX_SAFE_INTEGER;
  }
  return _origRandom();
};

// Reset counter before each test
beforeEach(() => {
  Math.random._callCount = 0;
});

describe("e2e workflow building: YAML input → workflow JSON", () => {
  // --- Golden file existence check ---
  test("has a golden file for every input YAML", () => {
    for (const inputFile of inputFiles) {
      const baseName = inputFile.replace(/\.yaml$/, "");
      expect(goldenBasenames.has(baseName)).toBe(true);
    }
  });

  // --- Golden file comparisons (one test per input) ---
  for (const inputFile of inputFiles) {
    const baseName = inputFile.replace(/\.yaml$/, "");

    test(`golden: ${baseName}`, async () => {
      const workflows = await loadWorkflows(
        baseName,
        INPUTS_DIR,
        FIXTURES_BASE,
      );
      const goldenPath = path.join(GOLDEN_DIR, `${baseName}.json`);
      const goldenText = await readFile(goldenPath, "utf8");
      const golden = JSON.parse(goldenText);
      expect(workflows).toEqual(golden);
    });
  }

  // --- Structural invariants ---
  for (const inputFile of inputFiles) {
    const baseName = inputFile.replace(/\.yaml$/, "");

    test(`${baseName}: required node structure`, async () => {
      const workflows = await loadWorkflows(
        baseName,
        INPUTS_DIR,
        FIXTURES_BASE,
      );
      const goldenPath = path.join(GOLDEN_DIR, `${baseName}.json`);
      const golden = JSON.parse(await readFile(goldenPath, "utf8"));

      expect(workflows.length).toBe(golden.length);

      for (let i = 0; i < workflows.length; i++) {
        const wf = workflows[i].workflow;

        // Must have a Sampler (KSampler) with required inputs
        const sampler = Object.values(wf).find(
          (node) => node?.class_type === "KSampler",
        );
        expect(sampler).toBeDefined();
        expect(sampler.inputs).toHaveProperty("seed");
        expect(sampler.inputs).toHaveProperty("steps");
        expect(sampler.inputs).toHaveProperty("cfg");

        // Must have SaveImage output node — skip this check for minimal-base
        // workflows (26-minimal-base, 27-minimal-steps-cfg) which intentionally
        // omit SaveImage, CLIP, and other nodes. The invariant is: every
        // workflow that *can* have a SaveImage must have one.
        const isMinimalBase =
          baseName === "26-minimal-base" || baseName === "27-minimal-steps-cfg";
        if (!isMinimalBase) {
          const saveImage = Object.values(wf).find(
            (node) => node?.class_type === "SaveImage",
          );
          expect(saveImage).toBeDefined();
        }
      }
    });
  }

  // --- Feature-by-feature verification ---
  test("01 no-modifications: structure matches base (except deterministic seed)", async () => {
    const workflows = await loadWorkflows(
      "01-no-modifications",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "01-no-modifications.json"), "utf8"),
    );

    expect(workflows).toHaveLength(1);
    expect(workflows).toEqual(golden);
    const wf = workflows[0].workflow;
    expect(Object.keys(wf)).toEqual(Object.keys(golden[0].workflow));
    expect(wf.PositiveCLIP_Base.inputs.text).toBe(
      "masterpiece, best quality, highres",
    );
    expect(wf.NegativeCLIP_Base.inputs.text).toBe(
      "lowres, bad anatomy, extra limbs",
    );
    expect(wf.Sampler.inputs.steps).toBe(20);
    expect(wf.Sampler.inputs.cfg).toBe(8);
    expect(wf.EmptyLatentImage.inputs.width).toBe(832);
    expect(wf.EmptyLatentImage.inputs.height).toBe(1216);
    expect(wf.Lora_1).toBeUndefined();
    expect(wf.SaveImage.inputs.filename_prefix).toBe("output");
  });

  test("04 multiple-prompts: three separate workflows with distinct prompts", async () => {
    const workflows = await loadWorkflows(
      "04-multiple-prompts",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "04-multiple-prompts.json"), "utf8"),
    );

    expect(workflows).toHaveLength(3);
    expect(workflows).toEqual(golden);
    const prompts = workflows.map(
      (w) => w.workflow.PositiveCLIP_Base.inputs.text,
    );
    expect(prompts).toContain(
      "masterpiece, best quality, highres, prompt A text",
    );
    expect(prompts).toContain(
      "masterpiece, best quality, highres, prompt B text",
    );
    expect(prompts).toContain(
      "masterpiece, best quality, highres, prompt C text",
    );
  });

  test("05 multi-part-prompt: multiple strings concatenated with commas", async () => {
    const workflows = await loadWorkflows(
      "05-multi-part-prompt",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "05-multi-part-prompt.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    const text = workflows[0].workflow.PositiveCLIP_Base.inputs.text;
    expect(text).toContain("part one");
    expect(text).toContain("part two");
    expect(text).toContain("part three");
  });

  test("06 negative-prompt: negative prompt appended", async () => {
    const workflows = await loadWorkflows(
      "06-negative-prompt",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "06-negative-prompt.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    const neg = workflows[0].workflow.NegativeCLIP_Base.inputs.text;
    expect(neg).toContain("lowres, bad anatomy, extra limbs");
    expect(neg).toContain("ugly artifacts");
    expect(neg).toContain("bad lighting");
  });

  test("07 steps-cfg-override: sampler inputs updated", async () => {
    const workflows = await loadWorkflows(
      "07-steps-cfg-override",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "07-steps-cfg-override.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    expect(workflows[0].workflow.Sampler.inputs.steps).toBe(50);
    expect(workflows[0].workflow.Sampler.inputs.cfg).toBe(12.5);
  });

  test("08 size-override: both dimensions updated", async () => {
    const workflows = await loadWorkflows(
      "08-size-override",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "08-size-override.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    expect(workflows[0].workflow.EmptyLatentImage.inputs.width).toBe(1024);
    expect(workflows[0].workflow.EmptyLatentImage.inputs.height).toBe(1024);
  });

  test("09 width-only-size: only width changed, height preserved", async () => {
    const workflows = await loadWorkflows(
      "09-width-only-size",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "09-width-only-size.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    expect(workflows[0].workflow.EmptyLatentImage.inputs.width).toBe(768);
    expect(workflows[0].workflow.EmptyLatentImage.inputs.height).toBe(1216);
  });

  test("10 filename-prefix: SaveImage prefix updated", async () => {
    const workflows = await loadWorkflows(
      "10-filename-prefix",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "10-filename-prefix.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    expect(workflows[0].workflow.SaveImage.inputs.filename_prefix).toBe(
      "my-custom-prefix",
    );
  });

  test("11 fixed-seed-tries1: seed is the specified value, not random", async () => {
    const workflows = await loadWorkflows(
      "11-fixed-seed-tries1",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "11-fixed-seed-tries1.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    expect(workflows[0].workflow.Sampler.inputs.seed).toBe(999999999);
  });

  test("12 tries-random-seed: each clone gets random seed, total tries=3", async () => {
    const workflows = await loadWorkflows(
      "12-tries-random-seed",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "12-tries-random-seed.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(3);
    const seeds = workflows.map((w) => w.workflow.Sampler.inputs.seed);
    expect(seeds[0]).not.toBe(695823221);
    expect(seeds[1]).not.toBe(695823221);
    expect(seeds[2]).not.toBe(695823221);
    expect(seeds[0]).not.toBe(seeds[1]);
    expect(seeds[1]).not.toBe(seeds[2]);
  });

  test("13 single-lora: chain inserted after checkpoint, rewired", async () => {
    const workflows = await loadWorkflows(
      "13-single-lora",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "13-single-lora.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    const wf = workflows[0].workflow;
    expect(wf.Lora_1.inputs.lora_name).toBe("my-lora.safetensors");
    expect(wf.Lora_1.inputs.strength_model).toBe(0.7);
    expect(wf.Lora_1.inputs.strength_clip).toBe(0.7);
    expect(wf.ClipSkip_Base.inputs.clip).toEqual(["Lora_1", 1]);
    expect(wf.Sampler.inputs.model).toEqual(["Lora_1", 0]);
  });

  test("14 multi-lora: three-node chain, all rewired", async () => {
    const workflows = await loadWorkflows(
      "14-multi-lora",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "14-multi-lora.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    const wf = workflows[0].workflow;
    expect(wf.Lora_1.inputs.model).toEqual(["CheckpointLoader_Base", 0]);
    expect(wf.Lora_2.inputs.model).toEqual(["Lora_1", 0]);
    expect(wf.Lora_3.inputs.model).toEqual(["Lora_2", 0]);
    expect(wf.ClipSkip_Base.inputs.clip).toEqual(["Lora_3", 1]);
    expect(wf.Sampler.inputs.model).toEqual(["Lora_3", 0]);
  });

  test("15 lora-per-prompt-override: entry loras replace parent", async () => {
    const workflows = await loadWorkflows(
      "15-lora-per-prompt-override",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "15-lora-per-prompt-override.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(2);
    expect(workflows[0].workflow.Lora_1.inputs.lora_name).toBe(
      "entry-lora.safetensors",
    );
    expect(workflows[0].workflow.Lora_2).toBeUndefined();
    // Second entry inherits the parent's single lora (no entry-level loras override)
    expect(workflows[1].workflow.Lora_1.inputs.lora_name).toBe(
      "parent-lora.safetensors",
    );
    expect(workflows[1].workflow.Lora_2).toBeUndefined();
  });

  test("16 clip-skip: stop_at_clip_layer updated to -1", async () => {
    const workflows = await loadWorkflows(
      "16-clip-skip",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "16-clip-skip.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    expect(workflows[0].workflow.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(
      -1,
    );
  });

  test("17 clip-skip-zero: clip-skip=0 works", async () => {
    const workflows = await loadWorkflows(
      "17-clip-skip-zero",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "17-clip-skip-zero.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    expect(workflows[0].workflow.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(
      0,
    );
  });

  test("18 brace-single-group: 2 variants from {red, blue}", async () => {
    const workflows = await loadWorkflows(
      "18-brace-single-group",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "18-brace-single-group.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(2);
    const texts = workflows.map(
      (w) => w.workflow.PositiveCLIP_Base.inputs.text,
    );
    expect(texts).toContain("masterpiece, best quality, highres, a red ball");
    expect(texts).toContain("masterpiece, best quality, highres, a blue ball");
  });

  test("19 brace-multi-group: 4 cartesian product variants", async () => {
    const workflows = await loadWorkflows(
      "19-brace-multi-group",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "19-brace-multi-group.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(4);
    const texts = workflows.map(
      (w) => w.workflow.PositiveCLIP_Base.inputs.text,
    );
    expect(texts).toContain("masterpiece, best quality, highres, a red ball");
    expect(texts).toContain("masterpiece, best quality, highres, a red cube");
    expect(texts).toContain("masterpiece, best quality, highres, a blue ball");
    expect(texts).toContain("masterpiece, best quality, highres, a blue cube");
  });

  test("20 brace-multi-entries: brace expansion + multiple prompt entries", async () => {
    const workflows = await loadWorkflows(
      "20-brace-multi-entries",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "20-brace-multi-entries.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(3); // 2 from brace + 1 plain
    const texts = workflows.map(
      (w) => w.workflow.PositiveCLIP_Base.inputs.text,
    );
    expect(texts).toContain("masterpiece, best quality, highres, red thing");
    expect(texts).toContain("masterpiece, best quality, highres, green thing");
    expect(texts).toContain("masterpiece, best quality, highres, blue thing");
  });

  test("21 per-prompt-seed: each prompt uses its own seed", async () => {
    const workflows = await loadWorkflows(
      "21-per-prompt-seed",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "21-per-prompt-seed.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(2);
    expect(workflows[0].workflow.Sampler.inputs.seed).toBe(12345678);
    expect(workflows[1].workflow.Sampler.inputs.seed).toBe(87654321);
  });

  test("22 seed-random-tries1: explicit seed=random produces a random seed", async () => {
    const workflows = await loadWorkflows(
      "22-seed-random-tries1",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "22-seed-random-tries1.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    expect(workflows[0].workflow.Sampler.inputs.seed).not.toBe(695823221);
  });

  test("23 combined-lora-clip-skip-size: all features together", async () => {
    const workflows = await loadWorkflows(
      "23-combined-lora-clip-skip-size",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "23-combined-lora-clip-skip-size.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    const wf = workflows[0].workflow;
    expect(wf.Lora_1.inputs.lora_name).toBe("style-lora.safetensors");
    expect(wf.Lora_1.inputs.strength_model).toBe(0.6);
    expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
    expect(wf.EmptyLatentImage.inputs.width).toBe(768);
    expect(wf.EmptyLatentImage.inputs.height).toBe(1024);
  });

  test("24 combined-prompt-negative: prompt + negative + steps + cfg + size", async () => {
    const workflows = await loadWorkflows(
      "24-combined-prompt-negative",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "24-combined-prompt-negative.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    const wf = workflows[0].workflow;
    expect(wf.Sampler.inputs.steps).toBe(30);
    expect(wf.Sampler.inputs.cfg).toBe(10);
    expect(wf.EmptyLatentImage.inputs.width).toBe(640);
    expect(wf.EmptyLatentImage.inputs.height).toBe(960);
    expect(wf.PositiveCLIP_Base.inputs.text).toContain("positive text");
    expect(wf.NegativeCLIP_Base.inputs.text).toContain("negative text");
  });

  test("25 multi-item: multiple top-level items produce multiple workflows", async () => {
    const workflows = await loadWorkflows(
      "25-multi-item",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "25-multi-item.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(2);
    expect(workflows[0].workflow.PositiveCLIP_Base.inputs.text).toContain(
      "item one",
    );
    expect(workflows[1].workflow.PositiveCLIP_Base.inputs.text).toContain(
      "item two",
    );
  });

  test("26 minimal-base: workflow without CLIP nodes and SaveImage", async () => {
    const workflows = await loadWorkflows(
      "26-minimal-base",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "26-minimal-base.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    const wf = workflows[0].workflow;
    expect(wf.ClipSkip_Base).toBeUndefined();
    expect(wf.PositiveCLIP_Base).toBeUndefined();
    expect(wf.NegativeCLIP_Base).toBeUndefined();
    expect(wf.SaveImage).toBeUndefined();
    expect(wf.Lora_1).toBeUndefined();
    expect(wf.Sampler.inputs.model).toEqual(["CheckpointLoader_Base", 0]);
  });

  test("27 minimal-steps-cfg: overrides work on minimal base", async () => {
    const workflows = await loadWorkflows(
      "27-minimal-steps-cfg",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "27-minimal-steps-cfg.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    expect(workflows[0].workflow.Sampler.inputs.steps).toBe(25);
    expect(workflows[0].workflow.Sampler.inputs.cfg).toBe(9);
  });

  test("28 per-prompt-clip-skip: entry-level overrides parent", async () => {
    const workflows = await loadWorkflows(
      "28-per-prompt-clip-skip",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(
        path.join(GOLDEN_DIR, "28-per-prompt-clip-skip.json"),
        "utf8",
      ),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(2);
    expect(workflows[0].workflow.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(
      -1,
    );
    expect(workflows[1].workflow.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(
      -3,
    );
  });

  test("29 per-prompt-tries: different tries per prompt", async () => {
    const workflows = await loadWorkflows(
      "29-per-prompt-tries",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "29-per-prompt-tries.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(3); // 2 from first entry (tries=2) + 1 from second (tries=1)
    expect(workflows[0].input.tries).toBe(2);
    expect(workflows[1].input.tries).toBe(2);
    expect(workflows[2].input.tries).toBe(1);
    // All have random seeds (tries > 1 triggers randomization)
    expect(workflows[0].workflow.Sampler.inputs.seed).not.toBe(695823221);
    expect(workflows[1].workflow.Sampler.inputs.seed).not.toBe(695823221);
    expect(workflows[2].workflow.Sampler.inputs.seed).not.toBe(695823221);
  });

  test("30 all-overrides: comprehensive single workflow with every feature", async () => {
    const workflows = await loadWorkflows(
      "30-all-overrides",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "30-all-overrides.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(1);
    const wf = workflows[0].workflow;
    expect(wf.Sampler.inputs.steps).toBe(40);
    expect(wf.Sampler.inputs.cfg).toBe(15);
    expect(wf.Sampler.inputs.seed).toBe(111222333);
    expect(wf.EmptyLatentImage.inputs.width).toBe(1152);
    expect(wf.EmptyLatentImage.inputs.height).toBe(896);
    expect(wf.SaveImage.inputs.filename_prefix).toBe("comprehensive-test");
    expect(wf.Lora_1.inputs.lora_name).toBe("style.safetensors");
    expect(wf.Lora_1.inputs.strength_model).toBe(0.9);
    expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-1);
    expect(wf.PositiveCLIP_Base.inputs.text).toContain("masterful work");
    expect(wf.PositiveCLIP_Base.inputs.text).toContain("stunning detail");
    expect(wf.NegativeCLIP_Base.inputs.text).toContain("blurry");
    expect(wf.NegativeCLIP_Base.inputs.text).toContain("low quality");
  });

  test("31 clip-skip-create: ClipSkip_Base created on workflow that lacks it", async () => {
    const workflows = await loadWorkflows(
      "31-clip-skip-create",
      INPUTS_DIR,
      FIXTURES_BASE,
    );
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "31-clip-skip-create.json"), "utf8"),
    );

    expect(workflows).toEqual(golden);
    expect(workflows).toHaveLength(1);
    const wf = workflows[0].workflow;
    // ClipSkip_Base should be created and inserted after the checkpoint
    expect(wf.ClipSkip_Base).toBeDefined();
    expect(wf.ClipSkip_Base.class_type).toBe("CLIPSetLastLayer");
    expect(wf.ClipSkip_Base.inputs.clip).toEqual(["CheckpointLoader_Base", 1]);
    expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
    // Positive/negative clips should be rewired to point to ClipSkip_Base
    expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    // PositiveCLIP_Base should have the prompt appended
    expect(wf.PositiveCLIP_Base.inputs.text).toContain(
      "masterpiece, best quality",
    );
    expect(wf.PositiveCLIP_Base.inputs.text).toContain("clip skip created");
  });
});
