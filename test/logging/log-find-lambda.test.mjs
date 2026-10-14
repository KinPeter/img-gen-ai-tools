import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({
  send: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    constructor(config) {
      this.config = config;
    }
  },
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: (...args) => ddb.from(...args) },
  GetCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));

ddb.from.mockReturnValue({ send: (...args) => ddb.send(...args) });

const { handler } = await import("../../logging/log-find-lambda.mjs");
const eventFor = (filename) => ({
  queryStringParameters: filename === undefined ? null : { filename },
});

beforeEach(() => {
  ddb.send.mockReset();
  vi.stubEnv("TABLE_NAME", "logs-table");
  vi.stubEnv("AWS_LOGS_TABLE_NAME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("log-find lambda", () => {
  it("requires a filename query parameter", async () => {
    for (const event of [
      {},
      eventFor(undefined),
      eventFor(""),
      eventFor("   "),
      eventFor("/"),
      eventFor("///"),
    ]) {
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "Missing required query parameter: filename",
      });
      expect(response.headers["Content-Type"]).toBe("application/json");
    }
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it("reports a missing table configuration", async () => {
    vi.stubEnv("TABLE_NAME", "");
    vi.stubEnv("AWS_LOGS_TABLE_NAME", "");
    const response = await handler(eventFor("image.png"));
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error:
        "Server misconfigured: set the TABLE_NAME environment variable to the DynamoDB table name.",
    });
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it("falls back to AWS_LOGS_TABLE_NAME", async () => {
    vi.unstubAllEnvs();
    delete process.env.TABLE_NAME;
    vi.stubEnv("AWS_LOGS_TABLE_NAME", " alt-table ");
    ddb.send.mockResolvedValueOnce({ Item: { data: "{}" } });
    const response = await handler(eventFor("image.png"));
    expect(response.statusCode).toBe(200);
    expect(ddb.send.mock.calls[0][0].input.TableName).toBe("alt-table");
  });

  it("returns the stored log entry parsed as JSON", async () => {
    const stored = { filename: "image.png", prompt: "a cat" };
    ddb.send.mockResolvedValueOnce({ Item: { data: JSON.stringify(stored) } });
    const response = await handler(eventFor("image.png"));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(stored);
    expect(ddb.send).toHaveBeenCalledTimes(1);
    const command = ddb.send.mock.calls[0][0];
    expect(command.input).toMatchObject({
      TableName: "logs-table",
      Key: { filename: "image" },
      ProjectionExpression: "#data",
      ExpressionAttributeNames: { "#data": "data" },
    });
  });

  it("normalizes filenames to the key without extension", async () => {
    const cases = [
      ["dist/nested/photo.jpg", "photo"],
      ["C:\\output\\shot.jpeg", "shot"],
      ["  spaced.png  ", "spaced"],
      ["archive.tar.gz", "archive.tar"],
      ["noext", "noext"],
      [".hidden", ".hidden"],
    ];
    for (const [input, key] of cases) {
      ddb.send.mockResolvedValueOnce({ Item: { data: "{}" } });
      const response = await handler(eventFor(input));
      expect(response.statusCode).toBe(200);
      expect(ddb.send.mock.calls.at(-1)[0].input.Key).toEqual({
        filename: key,
      });
    }
    expect(ddb.send).toHaveBeenCalledTimes(cases.length);
  });

  it("wraps non-JSON payloads instead of failing", async () => {
    ddb.send.mockResolvedValueOnce({ Item: { data: "plain text" } });
    const response = await handler(eventFor("note.png"));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ data: "plain text" });
  });

  it("returns 404 when no log entry exists", async () => {
    for (const result of [{}, { Item: {} }, { Item: { data: null } }]) {
      ddb.send.mockResolvedValueOnce(result);
      const response = await handler(eventFor("missing.png"));
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        error: 'No log entry found for filename "missing".',
      });
    }
  });

  it("returns 500 when DynamoDB read fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ddb.send.mockRejectedValueOnce(new Error("boom"));
      const response = await handler(eventFor("image.png"));
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual({
        error: "Failed to read from DynamoDB.",
      });
      expect(error).toHaveBeenCalledWith(
        "DynamoDB GetItem failed:",
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }
  });
});
