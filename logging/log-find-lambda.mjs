import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;

function tableName() {
  return process.env.TABLE_NAME ?? process.env.AWS_LOGS_TABLE_NAME;
}

const client = new DynamoDBClient(REGION ? { region: REGION } : {});
const docClient = DynamoDBDocumentClient.from(client);

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(payload),
  };
}

function normalizeFilename(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") return "";
  const base = trimmed.replace(/\\/g, "/").split("/").pop();
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0) return base;
  return base.slice(0, dotIndex);
}

export const handler = async (event) => {
  const filenameParam = event?.queryStringParameters?.filename;

  if (filenameParam == null || String(filenameParam).trim() === "") {
    return jsonResponse(400, {
      error: "Missing required query parameter: filename",
    });
  }

  const configuredTable = tableName();
  if (configuredTable == null || String(configuredTable).trim() === "") {
    return jsonResponse(500, {
      error:
        "Server misconfigured: set the TABLE_NAME environment variable to the DynamoDB table name.",
    });
  }

  const key = normalizeFilename(filenameParam);
  if (key === "") {
    return jsonResponse(400, {
      error: "Missing required query parameter: filename",
    });
  }

  let result;
  try {
    result = await docClient.send(
      new GetCommand({
        TableName: String(configuredTable).trim(),
        Key: { filename: key },
        ProjectionExpression: "#data",
        ExpressionAttributeNames: { "#data": "data" },
      }),
    );
  } catch (error) {
    console.error("DynamoDB GetItem failed:", error);
    return jsonResponse(500, { error: "Failed to read from DynamoDB." });
  }

  const stored = result?.Item?.data;
  if (stored == null) {
    return jsonResponse(404, {
      error: `No log entry found for filename "${key}".`,
    });
  }

  try {
    return jsonResponse(200, JSON.parse(stored));
  } catch {
    return jsonResponse(200, { data: stored });
  }
};
