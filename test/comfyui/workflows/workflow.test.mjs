import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
} from "../../../comfyui/workflows/workflow.mjs";

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
        expect(wf.ClipSkip_Base.inputs.clip).toEqual(["Lora_1", 1]);
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
        "base-workflow: lora-collision",
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

  it("overrides stop_at_clip_layer when clip-skip is set", async () => {
    await withInput(
      "base-workflow: example-base-workflow\nclip-skip: -1\nprompts: [{}]\n",
      async (name, inputsDir) => {
        const wf = (await loadWorkflows(name, inputsDir))[0].workflow;
        expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-1);
      },
    );
  });

  it("keeps the base stop_at_clip_layer when clip-skip is absent", async () => {
    await withInput(
      "base-workflow: example-base-workflow\nprompts: [{}]\n",
      async (name, inputsDir) => {
        const wf = (await loadWorkflows(name, inputsDir))[0].workflow;
        expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-2);
      },
    );
  });

  it("applies clip-skip: 0 as an override and treats an explicit null as absent", async () => {
    for (const [clipSkipYaml, expected] of [
      ["0", 0],
      ["null", -2],
    ]) {
      await withInput(
        `base-workflow: example-base-workflow\nclip-skip: ${clipSkipYaml}\nprompts: [{}]\n`,
        async (name, inputsDir) => {
          const wf = (await loadWorkflows(name, inputsDir))[0].workflow;
          expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(expected);
        },
      );
    }
  });

  it("applies per-prompt clip-skip: the parent value is inherited, the entry wins", async () => {
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

  it("rejects clip-skip when the base workflow has no CLIPSetLastLayer", async () => {
    await withInput(
      "base-workflow: no-clip-skip\nclip-skip: -1\nprompts: [{}]\n",
      async (name, inputsDir) => {
        await expect(
          loadWorkflows(name, inputsDir, FIXTURES_WORKFLOWS_DIR),
        ).rejects.toThrow("requires a CLIPSetLastLayer node");
      },
    );
  });
});
