# Log lookup tools

Look up a batch run-log entry by image filename — locally from `output/logs/`, or remotely via an AWS Lambda backed by DynamoDB. Remote lookup / deploy needs AWS credentials in `.env` (see `.env.example`); local lookup needs none.

| Script / command                   | What it does                                                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run find-log-from-files`      | searches `output/logs/*.json` for the entry whose `filename` matches the given image file (normalizes to `<basename>.png`), prints it as JSON. Interactive when no filename is passed.                                                       |
| `node logging/log-find-lambda.mjs` | not run directly — deployed as an AWS Lambda behind `LOG_FIND_LAMBDA_URL`: `GET ?filename=<image-file>` returns the stored log entry (key: basename without extension, e.g. `rover_20261003212855.png` → `rover_20261003212855`).            |
| `npm run deploy-find-lambda`       | zips `logging/log-find-lambda.mjs` (needs the `zip` binary) and publishes it to the existing Lambda via `UpdateFunctionCodeCommand`, then waits for `LastUpdateStatus === "Successful"`. The Lambda Handler stays `log-find-lambda.handler`. |

The Lambda reads `TABLE_NAME` (falls back to `AWS_LOGS_TABLE_NAME`) from its own environment; each item uses the image basename without extension as the String partition key (`filename`) and the JSON-stringified log entry as `data`. Responses: `400` for a missing/unparseable `filename`, `404` when no entry exists, `500` for misconfiguration or DynamoDB failure. Deploy needs `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_LOGS_FIND_LAMBDA_NAME`.

`logging/temp-scripts/` holds one-off migration helpers (documented in their own README) and is excluded from vitest coverage; `logging/*.mjs` is covered like the rest of the repo (`npm run test:coverage`, per-file 90% line threshold).
