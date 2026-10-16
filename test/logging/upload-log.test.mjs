import { afterEach, describe, expect, it, vi } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildPutItem,
  stripExtension,
  uploadLog,
} from "../../logging/upload-log.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubTable(tableName = "logs-table") {
  delete process.env.TABLE_NAME;
  vi.stubEnv("AWS_LOGS_TABLE_NAME", tableName);
}

function fakeDocClient() {
  const sent = [];
  const docClient = {
    send: vi.fn(async (command) => {
      sent.push(command);
      return {};
    }),
  };
  return { sent, docClient };
}

const sampleEntry = (filename) => ({
  prompt: { prompt: "a cat" },
  filename,
  outputPath: "output",
  generatedIn: "0:24",
  comfyJobId: "job-1",
});

describe("upload-log", () => {
  it("strips filenames to the key without extension", () => {
    expect(stripExtension("bp-cp_20261005233501.png")).toBe(
      "bp-cp_20261005233501",
    );
    expect(stripExtension("dist/nested/photo.jpg")).toBe("photo");
    expect(stripExtension("C:\\output\\shot.jpeg")).toBe("shot");
    expect(stripExtension("archive.tar.gz")).toBe("archive.tar");
    expect(stripExtension("noext")).toBe("noext");
    expect(stripExtension(".hidden")).toBe(".hidden");
    expect(stripExtension("  spaced.png  ")).toBe("spaced");
  });

  it("builds PutItem payloads matching the log-find schema", () => {
    const logEntry = sampleEntry("bp-cp_20261005233501.png");
    expect(
      buildPutItem({
        table: "logs-table",
        filename: "bp-cp_20261005233501",
        logEntry,
      }),
    ).toEqual({
      TableName: "logs-table",
      Item: {
        filename: "bp-cp_20261005233501",
        data: JSON.stringify(logEntry),
      },
    });
  });

  it("uploads each entry keyed by basename without extension", async () => {
    stubTable();
    const { sent, docClient } = fakeDocClient();
    const entries = [
      sampleEntry("bp-cp_20261005233501.png"),
      sampleEntry("C:\\output\\bp-cyberpunk\\bp-cp_20261005233502.png"),
    ];
    await expect(uploadLog(entries, { docClient })).resolves.toEqual({
      uploaded: 2,
    });
    expect(docClient.send).toHaveBeenCalledTimes(2);
    for (const command of sent) {
      expect(command).toBeInstanceOf(PutCommand);
    }
    expect(sent[0].input).toMatchObject({
      TableName: "logs-table",
      Item: {
        filename: "bp-cp_20261005233501",
        data: JSON.stringify(entries[0]),
      },
    });
    expect(sent[1].input.Item.filename).toBe("bp-cp_20261005233502");
  });

  it("prefers TABLE_NAME over AWS_LOGS_TABLE_NAME", async () => {
    vi.stubEnv("TABLE_NAME", " primary-table ");
    vi.stubEnv("AWS_LOGS_TABLE_NAME", "fallback-table");
    const { sent, docClient } = fakeDocClient();
    await uploadLog([sampleEntry("a.png")], { docClient });
    expect(sent[0].input.TableName).toBe("primary-table");
  });

  it("skips entries without a usable filename", async () => {
    stubTable();
    const { docClient } = fakeDocClient();
    await expect(
      uploadLog(
        [null, {}, { filename: "" }, { filename: "/" }, sampleEntry("ok.png")],
        { docClient },
      ),
    ).resolves.toEqual({ uploaded: 1 });
    expect(docClient.send).toHaveBeenCalledTimes(1);
  });

  it("uploads nothing for an empty batch", async () => {
    stubTable();
    const { docClient } = fakeDocClient();
    await expect(uploadLog([], { docClient })).resolves.toEqual({
      uploaded: 0,
    });
    expect(docClient.send).not.toHaveBeenCalled();
  });

  it("builds the default client lazily without sending for empty batches", async () => {
    stubTable();
    await expect(uploadLog([])).resolves.toEqual({ uploaded: 0 });
  });

  it("rejects non-array input", async () => {
    stubTable();
    const { docClient } = fakeDocClient();
    await expect(uploadLog(null, { docClient })).rejects.toThrow(TypeError);
    await expect(uploadLog("a.png", { docClient })).rejects.toThrow(TypeError);
    expect(docClient.send).not.toHaveBeenCalled();
  });

  it("throws when no table is configured", async () => {
    vi.stubEnv("TABLE_NAME", "");
    vi.stubEnv("AWS_LOGS_TABLE_NAME", "  ");
    const { docClient } = fakeDocClient();
    await expect(
      uploadLog([sampleEntry("a.png")], { docClient }),
    ).rejects.toThrow(/TABLE_NAME/);
    expect(docClient.send).not.toHaveBeenCalled();
  });

  it("propagates DynamoDB failures to the caller", async () => {
    stubTable();
    const docClient = {
      send: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    await expect(
      uploadLog([sampleEntry("a.png")], { docClient }),
    ).rejects.toThrow("boom");
  });
});
