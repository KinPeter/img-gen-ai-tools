import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findClipSourceLabel,
  createClipSkipNode,
  rewireClipsTo,
  applyClipSkipOverride,
} from "../../../comfyui/workflow-builder/clip.mjs";
import {
  findNodeLabel,
  findNode,
} from "../../../comfyui/workflow-builder/utils.mjs";
import { loadWorkflows } from "../../../comfyui/workflow-builder/workflow.mjs";

// Tracked non-standard fixture bases.
const FIXTURES_WORKFLOWS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "workflows",
);

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
});

describe("clip-skip integration", () => {
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
