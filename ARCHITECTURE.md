# URL Checker — Serverless AWS Architecture

High-level design for porting `URL-Checker-Backend` (Fastify API + BullMQ worker + Postgres + Redis) to a serverless AWS stack that stays inside the free tier at low/zero traffic and scales pay-as-you-go past that.

## Decisions locked in

- **Datastore**: DynamoDB (single table), replacing Postgres.
- **Live updates**: API Gateway WebSockets, replacing SSE.
- **IaC**: AWS SAM.

## Diagram

```
                 ┌────────────────────────┐
   HTTPS ───────▶│ API Gateway (HTTP API) │
                 └───────────┬────────────┘
                              │ invokes
                              ▼
                 ┌────────────────────────┐        writes batch/url items
                 │  api Lambda (Fastify   │───────────────────┐
                 │  via aws-lambda-fastify)│                   │
                 └───────────┬────────────┘                   ▼
                              │ 1 msg per URL           ┌─────────────┐
                              ▼                         │  DynamoDB   │
                     ┌────────────────┐                 │ (single     │
                     │  SQS: checks   │                 │  table)     │
                     └───────┬────────┘                 └──────┬──────┘
                              │ event source mapping            │ Streams
                              │ (Maximum Concurrency = 5)        ▼
                              ▼                         ┌─────────────────┐
                  ┌───────────────────────┐             │ notify Lambda    │
                  │ check-url Lambda      │────────────▶│ (DynamoDB Stream │
                  │ (fetch, 10s timeout,  │   updates   │  trigger)        │
                  │  classify transient/  │             └────────┬─────────┘
                  │  permanent failure)   │                      │ postToConnection
                  └───────────────────────┘                      ▼
                                                        ┌──────────────────────┐
   WSS ─────────────────────────────────────────────▶  │ API Gateway WebSocket │
   (client subscribes to a batchId)                     └──────────┬───────────┘
                                                                    │ $connect/$disconnect/subscribe
                                                                    ▼
                                                        ┌─────────────────────┐
                                                        │ ws Lambda(s)        │
                                                        │ → connections table │
                                                        │   in DynamoDB       │
                                                        └─────────────────────┘
```

## Component mapping

| Current (Backend) | Serverless replacement | Notes |
|---|---|---|
| `apps/api` (Fastify, :4000) | API Gateway (HTTP API) + one Lambda | Wrap the existing Fastify instance with `aws-lambda-fastify` / `@fastify/aws-lambda` so routes in `src/routes/*` need minimal rewrite. |
| `apps/worker` (BullMQ consumer) | SQS queue + `check-url` Lambda (SQS event source) | BullMQ's job model → SQS messages. Each message = one URL check. |
| Postgres (`prisma/schema.prisma`) | DynamoDB single table | See table design below. Source of truth stays "one durable store", same principle as today. |
| Redis: BullMQ queue | SQS | Standard queue is enough; FIFO not needed since checks are independent. |
| Redis: rate limit (10/s) + semaphore (5 in-flight) | SQS→Lambda event source mapping **Maximum Concurrency** setting | Set to 5. This caps concurrent executions cluster-wide, same guarantee as the Redis semaphore, with less machinery. The precise 10/s throttle is dropped as a simplification — concurrency cap + Lambda cold-start pacing keeps you well under any external-site abuse threshold; add a token-bucket item in DynamoDB later only if this proves insufficient. |
| Redis: pub/sub (SSE fanout) | DynamoDB Streams → `notify` Lambda → API Gateway Management API `postToConnection` | Replaces the "any instance can forward an update" property: the stream reacts to the write itself, not to which instance wrote it. |
| Redis: 30s batch-list cache | Dropped initially | DynamoDB reads are cheap at this scale (single-digit cents/month). Re-introduce with DAX or a DynamoDB-based cache item only if read volume grows enough to matter. |
| SSE endpoint (`batch-events.ts`) | API Gateway WebSocket API (`$connect`, `$disconnect`, `subscribe` route) + connections table | Client opens a WSS connection, sends `{action:"subscribe", batchId}`, gets pushed status updates as URLs resolve. |
| BullMQ retries (attempts/backoff, transient only) | SQS redrive policy (`maxReceiveCount`) + DLQ | `check-url` Lambda re-throws on transient failure (network error, 5xx, 429) → message becomes visible again after backoff-ish visibility timeout; permanent failures (404/403) are caught and written as `failed` without throwing, so the message is deleted immediately — same policy as today. |
| Cancel (remove queued jobs) | Status-check inside `check-url` Lambda | SQS can't selectively delete in-flight messages. Instead: before processing, `check-url` reads the batch status; if `cancelled`, it writes the url as `cancelled` and exits. Slight behavior shift from today's "delete queued job outright," but same end state. |
| Retry-failed (reset `failed`→`pending`, new job id) | Same logic, writes to DynamoDB + re-enqueues to SQS | No job-id dedup concern with SQS (unlike BullMQ), so this gets simpler. |
| `apps/web` (Next.js, :3000) | Out of scope for this pass | Can move to S3 + CloudFront (static export) or stay on Vercel/Amplify. Revisit once the API is live — it only needs `NEXT_PUBLIC_API_URL` and a WSS URL. |

## DynamoDB table design

Single table `UrlChecker`, on-demand billing to start (simplest; switch to provisioned + auto-scaling later if you want to land inside the *always-free* 25 RCU/WCU tier once traffic is predictable).

| Item type | PK | SK | Attributes |
|---|---|---|---|
| Batch | `BATCH#<batchId>` | `METADATA` | `status`, `totalUrls`, `completedCount`, `failedCount`, `createdAt` |
| URL | `BATCH#<batchId>` | `URL#<urlId>` | `url`, `status`, `statusCode`, `responseTimeMs`, `title`, `attemptCount`, `lastError` |
| WS connection | `CONN#<connectionId>` | `METADATA` | `batchId`, `connectedAt` (TTL attribute for auto-expiry of stale connections) |

GSIs:
- `GSI1` (PK=`BATCHES`, SK=`createdAt`) — lists all batches newest-first, for the batch list page (Query instead of Scan).
- `GSI2` (PK=`batchId`, SK=`connectionId`) on the connection item — finds all WebSocket connections subscribed to a batch, for fanout.

Enable **DynamoDB Streams** (NEW_IMAGE) on the table to drive the `notify` Lambda.

## Free tier reality check

| Service | Always-free | 12-month free | Notes |
|---|---|---|---|
| Lambda | 1M requests + 400,000 GB-s compute / month | — | Forever, not just first year. |
| DynamoDB | 25 GB storage + 25 RCU/25 WCU (provisioned mode only) | — | On-demand mode has no throughput free tier, only the 25GB storage — fine at low traffic (pennies), switch to provisioned later to hit true $0. |
| SQS | 1M requests / month | — | Forever. |
| API Gateway HTTP API | — | 1M calls / month | First 12 months only, then ~$1/million. |
| API Gateway WebSocket | — | 1M messages + 750K connection-minutes / month | First 12 months only, then pay-per-message/minute — cheap at low volume. |
| CloudWatch Logs | 5 GB ingestion / month | — | Set short retention (7d) on all log groups to avoid storage creep. |
| S3 + CloudFront (if web is hosted here later) | — | 5GB S3 + 1TB CloudFront egress | First 12 months only. |

Realistic outcome: **$0/month** for the API+worker+DB stack at low/dev traffic within the first year (DynamoDB on-demand may show a few cents). After 12 months, API Gateway becomes the first line item to actually cost money, and only proportional to real usage.

## Open items for the build phase

1. Confirm auth stance — current backend has none ("anyone with the URL can submit/view/cancel"); decide whether to carry that forward or add API keys / Cognito before going further than local dev.
2. Decide custom domain now or later (Route 53 hosted zone ≈ $0.50/mo, ACM cert is free).
3. Frontend hosting plan (S3+CloudFront vs Amplify vs keep on Vercel) — separate decision, not blocking the backend port.

## Next step

Scaffold the SAM project (`template.yaml`, Lambda handlers for api / check-url / notify / ws-connect / ws-disconnect / ws-subscribe) porting logic from `apps/api/src` and `apps/worker/src`.
