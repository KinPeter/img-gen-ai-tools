import { describe, expect, it } from "vitest";
import { applyOverrides } from "../../../comfyui/workflow-builder/overrides.mjs";

describe("overrides.mjs", () => {
  function makeBaseWorkflow() {
    return {
      CheckpointLoader_Base: {
        class_type: "CheckpointLoaderSimple",
        inputs: {},
      },
      Sampler: {
        class_type: "KSampler",
        inputs: {
          seed: 0,
          steps: 20,
          cfg: 8,
          model: ["CheckpointLoader_Base", 0],
        },
      },
      EmptyLatentImage: {
        class_type: "EmptyLatentImage",
        inputs: { width: 512, height: 512 },
      },
      PositiveCLIP_Base: {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["CheckpointLoader_Base", 1], text: "base prompt" },
      },
      NegativeCLIP_Base: {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["CheckpointLoader_Base", 1], text: "bad" },
      },
      VAEDecode_1: {
        class_type: "VAEDecode",
        inputs: { vae: ["CheckpointLoader_Base", 2] },
      },
      SaveImage: {
        class_type: "SaveImage",
        inputs: { filename_prefix: "output" },
      },
    };
  }

  it("overrides sampler steps", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { steps: 50 }, false);
    expect(wf.Sampler.inputs.steps).toBe(50);
  });

  it("overrides sampler cfg", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { cfg: 15 }, false);
    expect(wf.Sampler.inputs.cfg).toBe(15);
  });

  it("sets fixed seed when forceRandomSeed is false", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { seed: 42 }, false);
    expect(wf.Sampler.inputs.seed).toBe(42);
  });

  it("sets random seed when forceRandomSeed is true", () => {
    const wf = makeBaseWorkflow();
    const before = wf.Sampler.inputs.seed;
    applyOverrides(wf, { seed: 42 }, true);
    expect(wf.Sampler.inputs.seed).not.toBe(42);
    expect(wf.Sampler.inputs.seed).not.toBe(before);
    expect(Number.isInteger(wf.Sampler.inputs.seed)).toBe(true);
  });

  it("overrides latent image dimensions", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { size: { width: 768, height: 1024 } }, false);
    expect(wf.EmptyLatentImage.inputs.width).toBe(768);
    expect(wf.EmptyLatentImage.inputs.height).toBe(1024);
  });

  it("overrides only width when height is absent", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { size: { width: 768 } }, false);
    expect(wf.EmptyLatentImage.inputs.width).toBe(768);
    expect(wf.EmptyLatentImage.inputs.height).toBe(512);
  });

  it("overrides SaveImage filename prefix", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { "filename-prefix": "custom" }, false);
    expect(wf.SaveImage.inputs.filename_prefix).toBe("custom");
  });

  it("appends positive prompt text", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { prompt: ["added text"] }, false);
    expect(wf.PositiveCLIP_Base.inputs.text).toBe("base prompt, added text");
  });

  it("appends negative prompt text", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { "negative-prompt": ["ugly"] }, false);
    expect(wf.NegativeCLIP_Base.inputs.text).toBe("bad, ugly");
  });

  it("appends multiple prompt parts with commas", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { prompt: ["part one", "part two"] }, false);
    expect(wf.PositiveCLIP_Base.inputs.text).toBe(
      "base prompt, part one, part two",
    );
  });

  it("skips empty prompt parts", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { prompt: ["  ", "real", ""] }, false);
    expect(wf.PositiveCLIP_Base.inputs.text).toBe("base prompt, real");
  });

  it("applies loras when provided", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(
      wf,
      {
        loras: [{ name: "test.safetensors", strength: 0.8 }],
      },
      false,
    );
    expect(wf.Lora_1).toBeDefined();
    expect(wf.Lora_1.class_type).toBe("LoraLoader");
    expect(wf.Lora_1.inputs.lora_name).toBe("test.safetensors");
    expect(wf.Lora_1.inputs.strength_model).toBe(0.8);
    expect(wf.Lora_1.inputs.strength_clip).toBe(0.8);
    expect(wf.Sampler.inputs.model).toEqual(["Lora_1", 0]);
  });

  it("sets clip-skip override", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, { "clip-skip": -1 }, false);
    expect(wf.ClipSkip_Base).toBeDefined();
    expect(wf.ClipSkip_Base.class_type).toBe("CLIPSetLastLayer");
    expect(wf.ClipSkip_Base.inputs.stop_at_clip_layer).toBe(-1);
    // Clips rewired to ClipSkip_Base
    expect(wf.PositiveCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
    expect(wf.NegativeCLIP_Base.inputs.clip).toEqual(["ClipSkip_Base", 0]);
  });

  it("handles workflow without EmptyLatentImage gracefully", () => {
    const wf = {
      CheckpointLoader_Base: {
        class_type: "CheckpointLoaderSimple",
        inputs: {},
      },
      Sampler: { class_type: "KSampler", inputs: {} },
    };
    // Should not throw even though there's no EmptyLatentImage
    expect(() =>
      applyOverrides(
        wf,
        { steps: 50, size: { width: 640, height: 480 } },
        false,
      ),
    ).not.toThrow();
    expect(wf.Sampler.inputs.steps).toBe(50);
    expect(wf.EmptyLatentImage).toBeUndefined();
  });

  it("handles workflow without SaveImage gracefully", () => {
    const wf = {
      CheckpointLoader_Base: {
        class_type: "CheckpointLoaderSimple",
        inputs: {},
      },
      Sampler: { class_type: "KSampler", inputs: {} },
    };
    // Should not throw even though there's no SaveImage
    expect(() =>
      applyOverrides(wf, { "filename-prefix": "custom" }, false),
    ).not.toThrow();
  });

  it("does not modify workflow when no overrides are provided", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, {}, false);
    // Seed should be random (no seed override), but no error
    expect(wf.Sampler.inputs.steps).toBe(20);
    expect(wf.Sampler.inputs.cfg).toBe(8);
  });

  it("sets random seed when no seed is provided but forceRandomSeed is true", () => {
    const wf = makeBaseWorkflow();
    applyOverrides(wf, {}, true);
    expect(wf.Sampler.inputs.seed).not.toBe(0);
  });
});
