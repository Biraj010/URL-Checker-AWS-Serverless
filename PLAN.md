# Implementation Plan

Scope: port `URL-Checker-Backend` (Fastify API + BullMQ worker + Postgres + Redis) to the serverless stack described in [ARCHITECTURE.md](./ARCHITECTURE.md) (DynamoDB, SQS, Lambda, API Gateway HTTP + WebSocket, SAM). This is the plan to review before any real handler logic is written — folder structure, `template.yaml`, and stub handlers are already scaffolded and pushed.

## What's already in the repo (scaffold only, no real logic)

- `template.yaml` — full SAM template: DynamoDB table (+2 GSIs +streams), SQS queue+DLQ, 5 Lambda functions, HTTP API, WebSocket API + routes/integrations/permissions.
- `src/api/{handler,app}.ts` — Fastify app wrapped for Lambda via `@fastify/aws-lambda`, just a `/health` route so far.
- `src/check-url/handler.ts` — SQS handler stub with the `ReportBatchItemFailures` shape wired up, no fetch logic yet.
- `src/notify/handler.ts` — DynamoDB Stream handler stub.
- `src/ws-connect/ws-disconnect/ws-subscribe/handler.ts` — WebSocket route stubs.
- `src/shared/dynamo.ts` — DynamoDB Document Client singleton.
- `package.json`, `tsconfig.json`, `.gitignore`.

Nothing here talks to a real URL, DynamoDB item, or WebSocket connection yet — every handler is a `TODO`-annotated no-op with the correct AWS event/response shape.

## Data model (single table `url-checker-<stage>`)

| Item | PK | SK | GSI1PK / GSI1SK (batch list) | GSI2PK / GSI2SK (ws fanout) |
|---|---|---|---|---|
| Batch | `BATCH#<batchId>` | `METADATA` | `BATCHES` / `<createdAt>#<batchId>` | — |
| Url | `BATCH#<batchId>` | `URL#<urlId>` | — | — |
| Connection | `CONN#<connectionId>` | `METADATA` | — | `<batchId>` / `<connectionId>` |

Fields carried over 1:1 from the current Prisma schema: batch `status`/`totalUrls`/`completedCount`/`failedCount`/`createdAt`; url `url`/`status`/`statusCode`/`responseTimeMs`/`title`/`attemptCount`/`lastError`.

## Build order

Each phase should be independently testable with `sam local invoke` / `sam local start-api` before moving on.

1. **Shared layer** — `src/shared/`: key builders (`batchKey`, `urlKey`, `connectionKey`), Zod schemas ported from `packages/shared-types`, URL validation ported from `apps/api/src/lib/validate-urls.ts`.
2. **Create + list + get batch** (`POST /batches`, `GET /batches`, `GET /batches/:id`) — writes batch + url items in a `TransactWrite`/`BatchWrite`, enqueues one SQS message per URL, reads back via Query (not Scan).
3. **check-url worker** — fetch with 10s timeout (AbortController), classify transient (network error/5xx/429 → throw, goes back on the queue) vs permanent (404/403 → write `failed`, swallow), update the url item + increment the batch's `completedCount`/`failedCount` conditionally, check batch `status !== 'cancelled'` before doing the fetch at all.
4. **notify (stream → WebSocket)** — read NEW_IMAGE off the stream record, Query GSI2 for connections subscribed to that batchId, `postToConnection` to each, delete the connection item on a 410.
5. **WebSocket routes** — `ws-connect` (no-op), `ws-subscribe` (write connection item with the batchId from the message body), `ws-disconnect` (delete connection item).
6. **Cancel + retry-failed** (`POST /batches/:id/cancel`, `POST /batches/:id/retry-failed`) — cancel flips batch `status`; retry-failed queries urls with `status = failed`, resets to `pending`, re-enqueues.
7. **End-to-end local test** — `sam local start-api` + a local DynamoDB (`amazon/dynamodb-local` in Docker) + `sam local invoke` for the queue/stream consumers, or a `sam local start-lambda` + real dev-account SQS/DynamoDB if local stream emulation proves too fiddly (DynamoDB Streams don't emulate well locally — likely worth just testing this part against a real `dev` stack).
8. **Deploy `dev` stack** — `sam deploy --guided`, capture `HttpApiUrl`/`WebSocketUrl` outputs, smoke-test with `curl` + a WS client (e.g. `wscat`).
9. **Point `apps/web` at it** — swap `NEXT_PUBLIC_API_URL` and add a WSS URL env var, replace the SSE `EventSource` client code with a WebSocket client subscribing on connect.

## Known behavior deltas from the current backend (called out in ARCHITECTURE.md, repeating here since they affect implementation)

- No fine-grained 10/s rate limit — only the concurrency cap (`MaximumConcurrency: 5` on the SQS event source). Flag if this actually matters for the target sites being checked.
- Cancel no longer removes queued messages outright; `check-url` checks batch status before fetching and writes `cancelled` itself.
- No 30s list cache initially.
- No auth, same as today.

## Explicitly not started yet (waiting on your feedback first)

- Any real business logic inside the handler stubs.
- `apps/web` changes.
- Actual `sam deploy` to an AWS account.

## Questions for you before implementation starts

1. Any objection to the data model / key design above, or the phase order?
2. Should `check-url` update `completedCount`/`failedCount` via a conditional `UpdateItem` on the batch row (simple, small race window) or via a separate aggregation step (e.g. recompute count on read) — the current Postgres version does a DB-level count; DynamoDB doesn't have that for free.
3. OK to test phases 1-6 against a real `dev` AWS stack rather than fighting local DynamoDB Streams emulation?
