import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflows } from "../../../comfyui/workflow-builder/workflow.mjs";

const FIXTURES_WORKFLOWS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "workflows",
);

describe("loras.mjs", () => {
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
});
