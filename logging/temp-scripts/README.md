# Log matching script

Run `node logging/temp-scripts/match-log-entries-to-dist.mjs` from the
repository root to scan `output/logs` and recursively scan `dist`. The script
writes matching entries to `logging/temp-scripts/matching-log-entries.json` as
an array of single-property objects whose property is the image filename
without its extension. Original logs are read-only.

## Upload matching logs to DynamoDB

Run `node logging/temp-scripts/upload-matching-logs-to-dynamodb.mjs [input-file] [--dry-run]`
from the repository root to upload `.tmp/matching-log-entries.json` (default input)
to DynamoDB. Each item uses the log entry's base filename without extension
as the key (e.g. `bp-cp_20261005233501.png` -> `bp-cp_20261005233501`) and the
JSON-stringified log entry as the value.

- Required env vars: `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_LOGS_TABLE_NAME`.
- Optional env vars: `AWS_LOGS_KEY_ATTRIBUTE` (default `filename`),
  `AWS_LOGS_DATA_ATTRIBUTE` (default `data`). The table is assumed to have a
  String partition key named by the key attribute; the two attributes must differ.
- `input-file` (optional positional arg) overrides the default input path.
- `--dry-run` parses the input and prints the first 5 `PutItem` payloads
  without sending anything.
- Blast radius: `PutCommand` is an upsert, so re-runs overwrite existing items
  with the same base filename. Verify the table name and region before running.
- Uploads are sequential one-by-one `PutCommand`s with no batching, concurrency,
  or retry; suitable for tens of entries but slow past ~100.
