import { describe, expect, it } from "vitest";
import {
  findNodeByClass,
  findNegativeClip,
} from "../../../comfyui/workflow-builder/utils.mjs";

describe("utils.mjs", () => {
  it("findNodeByClass returns undefined when class not found", () => {
    expect(
      findNodeByClass(
        { Sampler: { class_type: "KSampler", inputs: {} } },
        "CLIPTextEncode",
      ),
    ).toBeUndefined();
  });

  it("findNodeByClass returns { label, node } when class is found", () => {
    const wf = {
      Sampler: { class_type: "KSampler", inputs: {} },
      ClipA: { class_type: "CLIPTextEncode", inputs: { text: "hello" } },
    };
    const result = findNodeByClass(wf, "CLIPTextEncode");
    expect(result).toEqual({ label: "ClipA", node: wf.ClipA });
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
