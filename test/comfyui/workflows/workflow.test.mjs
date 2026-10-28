import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getFinalNegativePrompt,
  getFinalPositivePrompt,
  getFinalSeed,
  loadWorkflows,
  requireWorkflows,
} from "../../../comfyui/workflow-builder/workflow.mjs";
import {
  findClipSourceLabel,
  createClipSkipNode,
  rewireClipsTo,
  applyClipSkipOverride,
} from "../../../comfyui/workflow-builder/clip.mjs";
import {
  findNodeLabel,
  findNode,
  findNodeByClass,
  findNegativeClip,
} from "../../../comfyui/workflow-builder/utils.mjs";

// Tracked non-standard fixture bases (see .tmp/comfy-input-improvement/03).
// Never use gitignored files for testing; base JSONs are served through the
// `workflowsDir` injection point instead of comfyui/workflows/.
const FIXTURES_WORKFLOWS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "workflows",
);

// The tracked base the default loadWorkflows resolves inputs against.
const EXAMPLE_BASE_WORKFLOW_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "comfyui",
  "workflows",
  "example-base-workflow.json",
);

describe("workflow expansion", () => {
  // Every fixture gets its own throwaway temp "inputs" tree (injected into
  // loadWorkflows/requireWorkflows), so tests never touch real
  // comfyui/inputs data and work in a clean checkout.
  async function withInput(text, callback, subdir = "") {
    const root = await mkdtemp(path.join(tmpdir(), "comfy-inputs-"));
    const inputsDir = path.join(root, "inputs");
    const dir = subdir ? path.join(inputsDir, ...subdir.split("/")) : inputsDir;
    await mkdir(dir, { recursive: true });
    const name = `coverage-${randomUUID()}`;
    await writeFile(path.join(dir, `${name}.yaml`), text);
    try {
      return await callback(subdir ? `${subdir}/${name}` : name, inputsDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("rejects malformed YAML, missing prompts and invalid tries", async () => {
    for (const [text, message] of [
      ["prompts: [", "Invalid YAML"],
      ["base-workflow: example-base-workflow", '"prompts" list'],
      ["prompts: [{}]", 'missing "base-workflow"'],
      [
        "base-workflow: example-base-workflow\nprompts: [{tries: 0}]",
        'Invalid "tries"',
      ],
      [
        "base-workflow: example-base-workflow\nprompts: [{prompt: text}]",
        '"prompt" must be a list',
      ],
      [
        "base-workflow: example-base-workflow\nprompts: [{negative-prompt: text}]",
        '"negative-prompt" must be a list',
      ],
    ]) {
      await withInput(text, async (name, inputsDir) => {
        await expect(loadWorkflows(name, inputsDir)).rejects.toThrow(message);
      });
    }
  });

  it("expands brace groups, inherits overrides, and preserves a single fixed seed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await withInput(
      `base-workflow: example-base-workflow
steps: 4
cfg: 5
size: {width: 512, height: 768}
filename-prefix: test
seed: 123
prompts:
  - prompt: ["{red, blue} {hat, scarf}"]
  - prompt: ["literal {unbalanced"]
    tries: 1
    seed: 42
`,
      async (name, inputsDir) => {
        const jobs = await loadWorkflows(name, inputsDir);
        expect(jobs).toHaveLength(5);
        expect(
          jobs.slice(0, 4).map((job) => getFinalPositivePrompt(job.workflow)),
        ).toEqual(
          expect.arrayContaining([
            expect.stringContaining("red hat"),
            expect.stringContaining("blue scarf"),
          ]),
        );
        expect(jobs[0].input.seed).toBeUndefined();
        expect(getFinalSeed(jobs[4].workflow)).toBe(42);
        expect(
          Object.values(jobs[4].workflow).find(
            (node) => node.class_type === "KSampler",
          ).inputs.steps,
        ).toBe(4);
        expect(
          Object.values(jobs[4].workflow).find(
            (node) => node.class_type === "EmptyLatentImage",
          ).inputs.height,
        ).toBe(768);
      },
    );
  });
  it("expands alternatives and applies overrides", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const jobs = await loadWorkflows("input.example");
    expect(jobs.length).toBeGreaterThan(4);
    expect(getFinalPositivePrompt(jobs[0].workflow)).toContain("black hair");
    expect(getFinalSeed(jobs[0].workflow)).toBe(
      Math.floor(0.25 * Number.MAX_SAFE_INTEGER),
    );
    expect(jobs[0].workflow.EmptyLatentImage.inputs.width).toBe(832);
    const negativeJob = jobs.find((job) => job.input["negative-prompt"]);
    expect(getFinalNegativePrompt(negativeJob.workflow)).toContain("insects");
    // Block two exercises the `loras` + `clip-skip` keys end to end.
    const loraJob = jobs.find(
      (job) => Array.isArray(job.input.loras) && job.input.loras.length === 2,
    );
    expect(loraJob).toBeDefined();
    expect(loraJob.input.loras).toEqual([
      { name: "nice-lora.safetensors", strength: 1 },
      { name: "second-lora.safetensors", strength: 0.3 },
    ]);
    const loraWf = loraJob.workflow;
    expect(loraWf.Lora_1).toEqual({
      class_type: "LoraLoader",
      inputs: {
        model: ["CheckpointLoader_Base", 0],
        clip: ["CheckpointLoader_Base", 1],
        lora_name: "nice-lora.safetensors",
        strength_model: 1,
        strength_clip: 1,
      },
    });
    expect(loraWf.Lora_2.inputs).toEqual({
      model: ["Lora_1", 0],
      clip: ["Lora_1", 1],
      lora_name: "second-lora.safetensors",
      strength_model: 0.3,
      strength_clip: 0.3,
    });
    // Base workflow has ClipSkip_Base; LoRA rewires its clip, clip-skip sets value.
    expect(loraWf.ClipSkip_Base.inputs.clip).toEqual(["Lora_2", 1]);
    expect(loraWf.Sampler.inputs.model).toEqual(["Lora_2", 0]);
    expect(loraWf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
    expect(loraWf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    expect(loraWf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
  });

  it("loads inputs from a configurable base, including archive subfolders", async () => {
    await withInput(
      "base-workflow: example-base-workflow\nprompts: [{prompt: [moved]}]\n",
      async (name, inputsDir) => {
        const jobs = await loadWorkflows(name, inputsDir);
        expect(getFinalPositivePrompt(jobs[0].workflow)).toContain("moved");
      },
    );
    await withInput(
      "base-workflow: example-base-workflow\nprompts: [{prompt: [archived]}]\n",
      async (name, inputsDir) => {
        const jobs = await loadWorkflows(name, inputsDir);
        expect(getFinalPositivePrompt(jobs[0].workflow)).toContain("archived");
      },
      "archive",
    );
  });

  it("resolves the default input base from the project, not the cwd", async () => {
    // input.example.yaml ships only in comfyui/inputs/; reverting the default
    // base to the old root inputs/ makes this reject with ENOENT.
    const jobs = await loadWorkflows("input.example");
    expect(jobs.length).toBeGreaterThan(0);
  });

  it("rejects missing input files", async () => {
    await expect(loadWorkflows("does-not-exist")).rejects.toThrow();
  });

  it("reports missing and empty workflow input through the CLI helper", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(requireWorkflows("does-not-exist")).rejects.toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("comfyui/inputs/does-not-exist.yaml"),
    );
    await withInput("", async (name, inputsDir) => {
      await expect(requireWorkflows(name, inputsDir)).rejects.toThrow("exit 0");
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("leaves the base workflow untouched when loras and clip-skip are absent", async () => {
    // No-LoRA regression: a fixed seed equal to the base's own seed makes
    // every override a no-op, so the expanded workflow must be deep-equal
    // to a fresh clone of the base JSON — no nodes added, no references
    // rewired.
    const base = JSON.parse(await readFile(EXAMPLE_BASE_WORKFLOW_PATH, "utf8"));
    await withInput(
      `base-workflow: example-base-workflow\nseed: ${base.Sampler.inputs.seed}\nprompts: [{}]\n`,
      async (name, inputsDir) => {
        const [job] = await loadWorkflows(name, inputsDir);
        expect(job.workflow).toEqual(structuredClone(base));
      },
    );
  });

  it("injects a single LoraLoader and rewires model/clip but not vae", async () => {
    await withInput(
      [
        "base-workflow: example-base-workflow",
        "loras:",
        "  - name: nice-lora.safetensors",
        "    strength: 1",
        "prompts: [{}]",
      ].join("\n"),
      async (name, inputsDir) => {
        const wf = (await loadWorkflows(name, inputsDir))[0].workflow;
        expect(wf.Lora_1).toEqual({
          class_type: "LoraLoader",
          inputs: {
            model: ["CheckpointLoader_Base", 0],
            clip: ["CheckpointLoader_Base", 1],
            lora_name: "nice-lora.safetensors",
            strength_model: 1,
            strength_clip: 1,
          },
        });
        // ClipSkip_Base exists in the base; no clip-skip override means its
        // clip reference is rewired by LoRA, but stop_at_clip_layer is unchanged.
        expect(wf.ClipSkip_Base).toBeDefined();
        expect(wf.ClipSkip_Base.inputs.clip).toEqual(["Lora_1", 1]);
        expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
        expect(wf.Sampler.inputs.model).toEqual(["Lora_1", 0]);
        expect(wf.VAEDecode_1.inputs.vae).toEqual(["CheckpointLoader_Base", 2]);
        const keys = Object.keys(wf);
        expect(keys[keys.indexOf("CheckpointLoader_Base") + 1]).toBe("Lora_1");
      },
    );
  });

  it("chains three LoraLoaders and rewires consumers to the last one", async () => {
    await withInput(
      [
        "base-workflow: example-base-workflow",
        "loras:",
        "  - name: first-lora.safetensors",
        "    strength: 1",
        "  - name: second-lora.safetensors",
        "    strength: 0.3",
        "  - name: third-lora.safetensors",
        "    strength: 0.6",
        "prompts: [{}]",
      ].join("\n"),
      async (name, inputsDir) => {
        const wf = (await loadWorkflows(name, inputsDir))[0].workflow;
        expect(wf.Lora_1.inputs.model).toEqual(["CheckpointLoader_Base", 0]);
        expect(wf.Lora_1.inputs.clip).toEqual(["CheckpointLoader_Base", 1]);
        expect(wf.Lora_2.inputs.model).toEqual(["Lora_1", 0]);
        expect(wf.Lora_2.inputs.clip).toEqual(["Lora_1", 1]);
        expect(wf.Lora_3.inputs.model).toEqual(["Lora_2", 0]);
        expect(wf.Lora_3.inputs.clip).toEqual(["Lora_2", 1]);
        // ClipSkip_Base exists in the base; its clip reference is rewired by LoRA.
        expect(wf.ClipSkip_Base).toBeDefined();
        expect(wf.ClipSkip_Base.inputs.clip).toEqual(["Lora_3", 1]);
        expect(wf.Sampler.inputs.model).toEqual(["Lora_3", 0]);
        expect(wf.VAEDecode_1.inputs.vae).toEqual(["CheckpointLoader_Base", 2]);
        // Labels appear in input order, inserted right after the checkpoint.
        const keys = Object.keys(wf);
        const cp = keys.indexOf("CheckpointLoader_Base");
        expect(keys.slice(cp + 1, cp + 4)).toEqual([
          "Lora_1",
          "Lora_2",
          "Lora_3",
        ]);
      },
    );
  });

  it("rejects invalid loras", async () => {
    for (const [text, message] of [
      [
        "base-workflow: example-base-workflow\nloras: text\nprompts: [{}]",
        '"loras" must be a list',
      ],
      [
        "base-workflow: example-base-workflow\nloras: []\nprompts: [{}]",
        '"loras" must contain at least one',
      ],
      [
        "base-workflow: example-base-workflow\nloras: [42]\nprompts: [{}]",
        'Each "loras" entry must be a {name, strength} object',
      ],
      [
        "base-workflow: example-base-workflow\nloras: [{strength: 1}]\nprompts: [{}]",
        '"loras[].name" must be a non-empty string',
      ],
      [
        "base-workflow: example-base-workflow\nloras: [{name: 123, strength: 1}]\nprompts: [{}]",
        '"loras[].name" must be a non-empty string',
      ],
      [
        'base-workflow: example-base-workflow\nloras: [{name: a.safetensors, strength: "0.5"}]\nprompts: [{}]',
        '"loras[].strength" must be a finite number',
      ],
      [
        "base-workflow: example-base-workflow\nloras: [{name: a.safetensors, strength: .inf}]\nprompts: [{}]",
        '"loras[].strength" must be a finite number',
      ],
    ]) {
      await withInput(text, async (name, inputsDir) => {
        await expect(loadWorkflows(name, inputsDir)).rejects.toThrow(message);
      });
    }
  });

  it("rejects loras when the base workflow has no CheckpointLoaderSimple", async () => {
    await withInput(
      [
        "base-workflow: no-checkpoint",
        "loras:",
        "  - name: nice-lora.safetensors",
        "    strength: 1",
        "prompts: [{}]",
      ].join("\n"),
      async (name, inputsDir) => {
        await expect(
          loadWorkflows(name, inputsDir, FIXTURES_WORKFLOWS_DIR),
        ).rejects.toThrow("requires a CheckpointLoaderSimple node");
      },
    );
  });

  it("rejects loras when the base workflow already defines a Lora label", async () => {
    await withInput(
      [
        "base-workflow: has-lora-label",
        "loras:",
        "  - name: nice-lora.safetensors",
        "    strength: 1",
        "prompts: [{}]",
      ].join("\n"),
      async (name, inputsDir) => {
        await expect(
          loadWorkflows(name, inputsDir, FIXTURES_WORKFLOWS_DIR),
        ).rejects.toThrow('already defines a node labeled "Lora_1"');
      },
    );
  });

  it("ignores the legacy lora-strengths key", async () => {
    // Decision Q2: the removed legacy key is silently ignored — the input
    // loads and the resulting workflow is deep-equal to the same input
    // without the key (fixed seed keeps both runs deterministic).
    const withJobs = await withInput(
      "base-workflow: example-base-workflow\nseed: 123\nlora-strengths: [1]\nprompts: [{}]\n",
      async (name, inputsDir) => loadWorkflows(name, inputsDir),
    );
    const withoutJobs = await withInput(
      "base-workflow: example-base-workflow\nseed: 123\nprompts: [{}]\n",
      async (name, inputsDir) => loadWorkflows(name, inputsDir),
    );
    expect(withJobs[0].workflow).toEqual(withoutJobs[0].workflow);
    expect(withJobs[0].workflow.Lora_1).toBeUndefined();
  });

  it("applies a per-prompt loras override wholesale, without merging", async () => {
    await withInput(
      [
        "base-workflow: example-base-workflow",
        "loras:",
        "  - name: parent-a.safetensors",
        "    strength: 0.5",
        "  - name: parent-b.safetensors",
        "    strength: 0.6",
        "prompts:",
        "  - prompt: [a]",
        "    loras:",
        "      - name: entry.safetensors",
        "        strength: 0.7",
        "  - prompt: [b]",
      ].join("\n"),
      async (name, inputsDir) => {
        const jobs = await loadWorkflows(name, inputsDir);
        expect(jobs).toHaveLength(2);
        // The entry's loras replace the parent's wholesale (no entry-level
        // merging): a single-node chain with the entry's lora only.
        expect(jobs[0].workflow.Lora_1.inputs.lora_name).toBe(
          "entry.safetensors",
        );
        expect(jobs[0].workflow.Lora_1.inputs.strength_model).toBe(0.7);
        expect(jobs[0].workflow.Lora_2).toBeUndefined();
        expect(jobs[0].workflow.Sampler.inputs.model).toEqual(["Lora_1", 0]);
        // The other entry keeps the parent's two-lora chain untouched.
        expect(jobs[1].workflow.Lora_1.inputs.lora_name).toBe(
          "parent-a.safetensors",
        );
        expect(jobs[1].workflow.Lora_2.inputs.lora_name).toBe(
          "parent-b.safetensors",
        );
        expect(jobs[1].workflow.Sampler.inputs.model).toEqual(["Lora_2", 0]);
      },
    );
  });

  it("gives every tries clone its own identical, independently wired lora chain", async () => {
    await withInput(
      [
        "base-workflow: example-base-workflow",
        "tries: 2",
        "loras:",
        "  - name: nice-lora.safetensors",
        "    strength: 0.8",
        "prompts: [{}]",
      ].join("\n"),
      async (name, inputsDir) => {
        const jobs = await loadWorkflows(name, inputsDir);
        expect(jobs).toHaveLength(2);
        const [a, b] = jobs.map((job) => job.workflow);
        // Both clones carry the same, correctly wired chain...
        for (const wf of [a, b]) {
          expect(wf.Lora_1).toEqual({
            class_type: "LoraLoader",
            inputs: {
              model: ["CheckpointLoader_Base", 0],
              clip: ["CheckpointLoader_Base", 1],
              lora_name: "nice-lora.safetensors",
              strength_model: 0.8,
              strength_clip: 0.8,
            },
          });
          // ClipSkip_Base exists in the base; its clip is rewired by LoRA.
          expect(wf.ClipSkip_Base).toBeDefined();
          expect(wf.ClipSkip_Base.inputs.clip).toEqual(["Lora_1", 1]);
          expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
          expect(wf.Sampler.inputs.model).toEqual(["Lora_1", 0]);
          expect(wf.VAEDecode_1.inputs.vae).toEqual([
            "CheckpointLoader_Base",
            2,
          ]);
        }
        // ...but built independently: no node objects are shared between
        // the clones.
        for (const label of Object.keys(a)) {
          expect(a[label]).not.toBe(b[label]);
        }
      },
    );
  });

  it("overrides stop_at_clip_layer when clip-skip is set", async () => {
    await withInput(
      `base-workflow: clip-skip-base
clip-skip: -1
prompts: [{}]
`,
      async (name, inputsDir) => {
        const wf = (
          await loadWorkflows(name, inputsDir, FIXTURES_WORKFLOWS_DIR)
        )[0].workflow;
        // Override the existing ClipSkip_Base value
        expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-1);
        // Positive/negative clips should still point to ClipSkip_Base
        expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
        expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
      },
    );
  });

  it("keeps the base stop_at_clip_layer when clip-skip is absent", async () => {
    // Uses clip-skip-base fixture: ClipSkip_Base already exists with value -2,
    // and no clip-skip is set, so the value should be preserved.
    await withInput(
      `base-workflow: clip-skip-base
prompts: [{}]
`,
      async (name, inputsDir) => {
        const wf = (
          await loadWorkflows(name, inputsDir, FIXTURES_WORKFLOWS_DIR)
        )[0].workflow;
        expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
      },
    );
  });

  it("applies clip-skip: 0 as an override and treats an explicit null as absent", async () => {
    // clip-skip: 0 overrides the existing ClipSkip_Base node
    await withInput(
      `base-workflow: clip-skip-base
clip-skip: 0
prompts: [{}]
`,
      async (name, inputsDir) => {
        const wf = (
          await loadWorkflows(name, inputsDir, FIXTURES_WORKFLOWS_DIR)
        )[0].workflow;
        expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(0);
      },
    );
    // clip-skip: null is treated as absent; the existing ClipSkip_Base
    // in example-base-workflow should be left untouched.
    await withInput(
      `base-workflow: example-base-workflow
clip-skip: null
prompts: [{}]
`,
      async (name, inputsDir) => {
        const wf = (await loadWorkflows(name, inputsDir))[0].workflow;
        expect(wf.ClipSkip_Base).toBeDefined();
        expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
      },
    );
  });

  it("applies per-prompt clip-skip: the parent value is inherited, the entry wins", async () => {
    // example-base-workflow already has ClipSkip_Base, so the override path is used.
    await withInput(
      [
        "base-workflow: example-base-workflow",
        "clip-skip: -3",
        "prompts:",
        "  - prompt: [a]",
        "    clip-skip: -1",
        "  - prompt: [b]",
      ].join("\n"),
      async (name, inputsDir) => {
        const jobs = await loadWorkflows(name, inputsDir);
        expect(jobs).toHaveLength(2);
        // The entry-level clip-skip wins over the parent's.
        expect(jobs[0].workflow.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(
          -1,
        );
        // The other entry inherits the parent's clip-skip.
        expect(jobs[1].workflow.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(
          -3,
        );
      },
    );
  });

  it("rejects non-number clip-skip values", async () => {
    for (const text of [
      'base-workflow: example-base-workflow\nclip-skip: "abc"\nprompts: [{}]',
      "base-workflow: example-base-workflow\nclip-skip: {a: 1}\nprompts: [{}]",
      "base-workflow: example-base-workflow\nclip-skip: .inf\nprompts: [{}]",
    ]) {
      await withInput(text, async (name, inputsDir) => {
        await expect(loadWorkflows(name, inputsDir)).rejects.toThrow(
          '"clip-skip" must be a finite number',
        );
      });
    }
  });

  it("creates ClipSkip_Base when the base workflow has no CLIPSetLastLayer", async () => {
    await withInput(
      "base-workflow: no-clip-skip\nclip-skip: -1\nprompts: [{}]\n",
      async (name, inputsDir) => {
        const wf = (
          await loadWorkflows(name, inputsDir, FIXTURES_WORKFLOWS_DIR)
        )[0].workflow;
        // ClipSkip_Base should be created and inserted after the checkpoint.
        expect(wf.ClipSkip_Base).toBeDefined();
        expect(wf.ClipSkip_Base.class_type).toBe("CLIPSetLastLayer");
        expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-1);
        // clip source should be the checkpoint (no loras)
        expect(wf.ClipSkip_Base.inputs.clip).toEqual([
          "CheckpointLoader_Base",
          1,
        ]);
        // Positive/negative clips should be rewired to point to ClipSkip_Base
        expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
        expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
        // Sampler should still reference Positive/Negative CLIP nodes
        expect(wf.Sampler.inputs.positive).toEqual(["PositiveCLIP_Base", 0]);
        expect(wf.Sampler.inputs.negative).toEqual(["NegativeCLIP_Base", 0]);
        // Key order: ClipSkip_Base should be right after CheckpointLoader_Base
        const keys = Object.keys(wf);
        const cpIndex = keys.indexOf("CheckpointLoader_Base");
        expect(keys[cpIndex + 1]).toBe("ClipSkip_Base");
      },
    );
  });

  it("creates ClipSkip_Base and uses fallback clip lookup when sampler refs are broken", async () => {
    // Sampler positive/negative point to non-existent nodes, so rewireClipsTo
    // must fall back to findNodeByClass / PositiveCLIP_Base lookup.
    await withInput(
      `base-workflow: no-clip-ref
clip-skip: -1
prompts: [{}]
`,
      async (name, inputsDir) => {
        const wf = (
          await loadWorkflows(name, inputsDir, FIXTURES_WORKFLOWS_DIR)
        )[0].workflow;
        expect(wf.ClipSkip_Base).toBeDefined();
        expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-1);
        // Positive/NegativeCLIP_Base should be rewired via fallback
        expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
        expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
        // Sampler refs remain unchanged (broken targets not rewired)
        expect(wf.Sampler.inputs.positive).toEqual(["NonExistentClip", 0]);
        expect(wf.Sampler.inputs.negative).toEqual(["NonExistentClipNeg", 0]);
      },
    );
  });

  it("creates ClipSkip_Base with Lora_N clip source when loras + clip-skip are set on a base without ClipSkip_Base", async () => {
    // Tests the creation path (no existing ClipSkip_Base) with LoRAs:
    // the new ClipSkip_Base must read its clip from the last LoRA node.
    await withInput(
      `base-workflow: no-clip-skip
loras:
  - name: style-lora.safetensors
    strength: 0.8
  - name: detail-lora.safetensors
    strength: 0.4
clip-skip: -2
prompts: [{}]
`,
      async (name, inputsDir) => {
        const wf = (
          await loadWorkflows(name, inputsDir, FIXTURES_WORKFLOWS_DIR)
        )[0].workflow;
        // ClipSkip_Base should be created and inserted after the checkpoint.
        expect(wf.ClipSkip_Base).toBeDefined();
        expect(wf.ClipSkip_Base.class_type).toBe("CLIPSetLastLayer");
        expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
        // clip source must be the last LoRA (Lora_2) since we have 2 loras
        expect(wf.ClipSkip_Base.inputs.clip).toEqual(["Lora_2", 1]);
        // LoRA chain should be present
        expect(wf.Lora_1.inputs.lora_name).toBe("style-lora.safetensors");
        expect(wf.Lora_1.inputs.strength_model).toBe(0.8);
        expect(wf.Lora_2.inputs.lora_name).toBe("detail-lora.safetensors");
        expect(wf.Lora_2.inputs.strength_model).toBe(0.4);
        // Sampler model should reference the last LoRA
        expect(wf.Sampler.inputs.model).toEqual(["Lora_2", 0]);
        // Positive/negative clips should be rewired to point to ClipSkip_Base
        expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
        expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
        // Key order: ClipSkip_Base should be right after CheckpointLoader_Base
        const keys = Object.keys(wf);
        const cpIndex = keys.indexOf("CheckpointLoader_Base");
        expect(keys[cpIndex + 1]).toBe("ClipSkip_Base");
      },
    );
  });
});

describe("clip.mjs unit tests", () => {
  it("findClipSourceLabel returns checkpoint when no loras", () => {
    const wf = {
      CheckpointLoader_Base: {
        class_type: "CheckpointLoaderSimple",
        inputs: {},
      },
      Sampler: { class_type: "KSampler", inputs: {} },
    };
    expect(findClipSourceLabel(wf, [], "CheckpointLoader_Base")).toBe(
      "CheckpointLoader_Base",
    );
    expect(findClipSourceLabel(wf, undefined, "CheckpointLoader_Base")).toBe(
      "CheckpointLoader_Base",
    );
    expect(findClipSourceLabel(wf, null, "CheckpointLoader_Base")).toBe(
      "CheckpointLoader_Base",
    );
  });

  it("findClipSourceLabel returns Lora_N when loras exist", () => {
    const wf = {};
    const loras1 = [{ name: "a.safetensors", strength: 0.5 }];
    expect(findClipSourceLabel(wf, loras1, "CheckpointLoader_Base")).toBe(
      "Lora_1",
    );
    const loras2 = [
      { name: "a.safetensors", strength: 0.5 },
      { name: "b.safetensors", strength: 0.3 },
    ];
    expect(findClipSourceLabel(wf, loras2, "CheckpointLoader_Base")).toBe(
      "Lora_2",
    );
    const loras3 = [
      { name: "a.safetensors", strength: 0.5 },
      { name: "b.safetensors", strength: 0.3 },
      { name: "c.safetensors", strength: 0.7 },
    ];
    expect(findClipSourceLabel(wf, loras3, "CheckpointLoader_Base")).toBe(
      "Lora_3",
    );
  });

  it("applyClipSkipOverride creates ClipSkip_Base and rewires clips when no CLIPSetLastLayer", async () => {
    const wf = JSON.parse(
      await readFile(
        path.join(FIXTURES_WORKFLOWS_DIR, "no-clip-skip.json"),
        "utf8",
      ),
    );
    const checkpointLabel = findNodeLabel(wf, "CheckpointLoaderSimple");
    const sampler = findNode(wf, "KSampler") ?? wf.Sampler;
    applyClipSkipOverride(wf, -1, undefined, checkpointLabel, sampler);
    expect(wf.ClipSkip_Base).toBeDefined();
    expect(wf.ClipSkip_Base.class_type).toBe("CLIPSetLastLayer");
    expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-1);
    expect(wf.ClipSkip_Base.inputs.clip).toEqual(["CheckpointLoader_Base", 1]);
    expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    // Key order: ClipSkip_Base right after CheckpointLoader_Base
    const keys = Object.keys(wf);
    const cpIndex = keys.indexOf("CheckpointLoader_Base");
    expect(keys[cpIndex + 1]).toBe("ClipSkip_Base");
  });

  it("applyClipSkipOverride overrides existing ClipSkip_Base value", async () => {
    const wf = JSON.parse(
      await readFile(
        path.join(FIXTURES_WORKFLOWS_DIR, "clip-skip-base.json"),
        "utf8",
      ),
    );
    const checkpointLabel = findNodeLabel(wf, "CheckpointLoaderSimple");
    const sampler = findNode(wf, "KSampler") ?? wf.Sampler;
    // Before override, value is -2
    expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
    applyClipSkipOverride(wf, -1, undefined, checkpointLabel, sampler);
    expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-1);
    // Clips still point to ClipSkip_Base
    expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
  });

  it("applyClipSkipOverride uses Lora_N as clip source when loras are present", async () => {
    const wf = JSON.parse(
      await readFile(
        path.join(FIXTURES_WORKFLOWS_DIR, "no-clip-skip.json"),
        "utf8",
      ),
    );
    // Simulate LoRAs already applied by adding Lora_1 and Lora_2
    wf.Lora_1 = {
      class_type: "LoraLoader",
      inputs: {
        model: ["CheckpointLoader_Base", 0],
        clip: ["CheckpointLoader_Base", 1],
        lora_name: "a.safetensors",
        strength_model: 1,
        strength_clip: 1,
      },
    };
    wf.Lora_2 = {
      class_type: "LoraLoader",
      inputs: {
        model: ["Lora_1", 0],
        clip: ["Lora_1", 1],
        lora_name: "b.safetensors",
        strength_model: 0.5,
        strength_clip: 0.5,
      },
    };
    // Rewire Sampler to use Lora_2 (simulating what applyLoras does)
    wf.Sampler.inputs.model = ["Lora_2", 0];
    // Add a fake key order with Lora nodes in correct positions
    const keys = Object.keys(wf);
    const values = {};
    for (const k of keys) values[k] = wf[k];
    for (const k of keys) delete wf[k];
    for (let i = 0; i < keys.length; i++) {
      wf[keys[i]] = values[keys[i]];
      if (keys[i] === "CheckpointLoader_Base") {
        wf.Lora_1 = values.Lora_1;
        wf.Lora_2 = values.Lora_2;
      }
    }
    const checkpointLabel = findNodeLabel(wf, "CheckpointLoaderSimple");
    const sampler = findNode(wf, "KSampler") ?? wf.Sampler;
    const loras = [
      { name: "a.safetensors", strength: 1 },
      { name: "b.safetensors", strength: 0.5 },
    ];
    applyClipSkipOverride(wf, -2, loras, checkpointLabel, sampler);
    expect(wf.ClipSkip_Base).toBeDefined();
    expect(wf.ClipSkip_Base.inputs.clip).toEqual(["Lora_2", 1]);
    expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
    // Positive/negative clips rewired to ClipSkip_Base
    expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
  });

  it("rewireClipsTo uses sampler refs when valid", () => {
    const wf = {
      Sampler: {
        class_type: "KSampler",
        inputs: {
          positive: ["PositiveCLIP_Base", 0],
          negative: ["NegativeCLIP_Base", 0],
        },
      },
      PositiveCLIP_Base: {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["Original", 0], text: "hello" },
      },
      NegativeCLIP_Base: {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["Original", 0], text: "bye" },
      },
    };
    rewireClipsTo(wf, "ClipSkip_Base", wf.Sampler);
    expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
  });

  it("rewireClipsTo falls back to CLIPTextEncode lookup when sampler refs are broken", () => {
    const wf = {
      Sampler: {
        class_type: "KSampler",
        inputs: {
          positive: ["NonExistent", 0],
          negative: ["AlsoNonExistent", 0],
        },
      },
      PositiveCLIP_Base: {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["CheckpointLoader_Base", 1], text: "hello" },
      },
      NegativeCLIP_Base: {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["CheckpointLoader_Base", 1], text: "bye" },
      },
    };
    rewireClipsTo(wf, "ClipSkip_Base", wf.Sampler);
    expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
  });

  it("rewireClipsTo uses NegativeCLIP_Base fallback when sampler negative ref is broken", () => {
    const wf = {
      Sampler: {
        class_type: "KSampler",
        inputs: {
          positive: ["PositiveCLIP_Base", 0],
          negative: ["NonExistentNeg", 0],
        },
      },
      PositiveCLIP_Base: {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["CheckpointLoader_Base", 1], text: "hello" },
      },
      NegativeCLIP_Base: {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["CheckpointLoader_Base", 1], text: "bye" },
      },
    };
    rewireClipsTo(wf, "ClipSkip_Base", wf.Sampler);
    expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
  });

  it("createClipSkipNode inserts after checkpoint and sets clip input correctly", () => {
    const wf = {
      CheckpointLoader_Base: {
        class_type: "CheckpointLoaderSimple",
        inputs: {},
      },
      EmptyLatentImage: { class_type: "EmptyLatentImage", inputs: {} },
      Sampler: { class_type: "KSampler", inputs: {} },
    };
    createClipSkipNode(
      wf,
      -2,
      "CheckpointLoader_Base",
      "CheckpointLoader_Base",
    );
    expect(wf.ClipSkip_Base).toBeDefined();
    expect(wf.ClipSkip_Base.class_type).toBe("CLIPSetLastLayer");
    expect(wf.ClipSkip_Base.inputs.clip).toEqual(["CheckpointLoader_Base", 1]);
    expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
    // Check key order
    const keys = Object.keys(wf);
    expect(keys[1]).toBe("ClipSkip_Base");
  });

  it("rewireClipsTo deep-fallback: no NegativeCLIP_Base, finds neg clip via for-loop", () => {
    // No NegativeCLIP_Base present, sampler neg ref broken → for-loop fallback (clip.mjs lines 75-79)
    const wf = {
      Sampler: {
        class_type: "KSampler",
        inputs: {
          positive: ["NonExistentPos", 0],
          negative: ["NonExistentNeg", 0],
        },
      },
      PositiveCLIP_Base: {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["CheckpointLoader_Base", 1], text: "hello" },
      },
      // No NegativeCLIP_Base — the for-loop must find the negative clip
      NegCLIP: {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["CheckpointLoader_Base", 1], text: "bye" },
      },
    };
    rewireClipsTo(wf, "ClipSkip_Base", wf.Sampler);
    expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    expect(wf.NegCLIP.inputs.clip).toEqual(["ClipSkip_Base", 0]);
  });

  it("findNodeByClass returns undefined when class not found", () => {
    expect(
      findNodeByClass(
        { Sampler: { class_type: "KSampler", inputs: {} } },
        "CLIPTextEncode",
      ),
    ).toBeUndefined();
  });

  it("findNegativeClip falls back to for-loop when no NegativeCLIP_Base", () => {
    const wf = {
      Sampler: {
        class_type: "KSampler",
        inputs: {
          positive: ["PosClip", 0],
          negative: ["NonExistentNeg", 0],
        },
      },
      PosClip: {
        class_type: "CLIPTextEncode",
        inputs: { clip: [], text: "" },
      },
      NegCLIP: {
        class_type: "CLIPTextEncode",
        inputs: { clip: [], text: "" },
      },
    };
    expect(findNegativeClip(wf, wf.Sampler)).toBe(wf.NegCLIP);
  });
});
