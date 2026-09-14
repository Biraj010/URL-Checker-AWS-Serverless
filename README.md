# URL Checker — Serverless (AWS)

Serverless AWS port of [URL-Checker-Backend](https://github.com/Biraj010/URL-Checker-Backend): submit a batch of URLs, check them in the background (status code, response time, page title), and watch progress update live.

Built to run inside the AWS free tier at low traffic and scale pay-as-you-go beyond that: API Gateway + Lambda + DynamoDB + SQS, no servers or containers to keep running.

## Status

Infrastructure is fully defined (`template.yaml`) but handler logic is still stubbed out — nothing fetches a URL or writes data yet. Not deployable as a working app yet.

## How it works

```
                 ┌────────────────────────┐
   HTTPS ───────▶│ API Gateway (HTTP API) │
                 └───────────┬────────────┘
                              │
                              ▼
                 ┌────────────────────────┐        writes batch/url items
                 │  api Lambda (Fastify)  │───────────────────┐
                 └───────────┬────────────┘                   ▼
                              │ 1 msg per URL           ┌─────────────┐
                              ▼                         │  DynamoDB   │
                     ┌────────────────┐                 │ (single     │
                     │  SQS: checks   │                 │  table)     │
                     └───────┬────────┘                 └──────┬──────┘
                              │ (max 5 concurrent)              │ Streams
                              ▼                                 ▼
                  ┌───────────────────────┐             ┌──────────────────┐
                  │ check-url Lambda      │             │ notify Lambda     │
                  │ fetch, 10s timeout,   │             │ (DynamoDB Stream  │
                  │ classify failure type │             │  trigger)         │
                  └───────────────────────┘             └────────┬──────────┘
                                                                  │ postToConnection
                                                                  ▼
   WSS ─────────────────────────────────────────────▶  API Gateway WebSocket
   (client subscribes to a batchId)                              │
                                                                  ▼
                                                        ws-connect / ws-disconnect /
                                                        ws-subscribe Lambdas
                                                        → connections table (DynamoDB)
```

**Submitting a batch**: `POST /batches` (api Lambda) validates the URLs, writes one batch item and one item per URL to DynamoDB, and enqueues one SQS message per URL.

**Checking a URL**: the `check-url` Lambda is triggered by SQS (max 5 concurrent executions across the whole system — this is the global concurrency cap, no Redis needed). It fetches the URL with a 10s timeout, classifies failures as transient (network error, 5xx, 429 — re-thrown so SQS retries it with backoff, eventually landing in a dead-letter queue) or permanent (404, 403 — written as `failed` immediately, never retried), and writes the result to DynamoDB.

**Live updates**: every write to DynamoDB is picked up by a DynamoDB Stream, which triggers the `notify` Lambda. It looks up which WebSocket connections are subscribed to that batch and pushes the update to each — this replaces the old SSE-based live view, since Lambda can't hold a long-lived HTTP connection open.

**WebSocket connections**: a client connects over WSS and sends `{"action": "subscribe", "batchId": "..."}`. The `ws-subscribe` Lambda records that connection against the batch; `ws-disconnect` cleans it up when the socket closes.

## Data model

Single DynamoDB table, on-demand billing:

| Item | PK | SK | Purpose |
|---|---|---|---|
| Batch | `BATCH#<batchId>` | `METADATA` | status, counts, createdAt |
| Url | `BATCH#<batchId>` | `URL#<urlId>` | per-URL status, response time, title |
| WS connection | `CONN#<connectionId>` | `METADATA` | which batch a live connection is watching |

`GSI1` lists all batches newest-first (for the batch list page). `GSI2` finds all connections subscribed to a given batch (for live-update fanout).

## Project structure

```
template.yaml           SAM template: all AWS resources (DynamoDB, SQS, Lambdas, HTTP + WebSocket APIs)
src/
  api/                   Fastify app (wrapped for Lambda) — the REST-ish endpoints
  check-url/             SQS-triggered worker that performs the actual URL check
  notify/                DynamoDB Stream-triggered fanout to WebSocket clients
  ws-connect/            $connect route (no-op)
  ws-disconnect/         $disconnect route — removes the connection record
  ws-subscribe/          subscribe route — links a connection to a batchId
  shared/                DynamoDB client + (upcoming) key builders and shared types
```

## Local development

```bash
npm install
npm run build       # sam build
npm run local:api   # sam local start-api
```

Requires [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) and Docker (SAM runs Lambdas in local containers).

## Deploy

```bash
npm run deploy       # sam deploy --guided, first time
```

Outputs the HTTP API base URL and the WebSocket (WSS) URL once deployed.

To get email alerts, deploy with an email address:

```bash
sam deploy --guided --parameter-overrides AlertEmail=you@example.com
```

(AWS will send a confirmation email to that address — the subscription is inactive until you click confirm.)

## Monitoring & alerts

- **CloudWatch**: every Lambda logs JSON to its own log group (`LoggingConfig` in `template.yaml`) — use these for debugging and metrics.
- **Dead-letter queue**: `check-url` retries a transient failure up to 5 times (SQS `maxReceiveCount`); after that the message moves to `CheckQueueDLQ` instead of retrying forever.
- **SNS alert on DLQ depth, not on every failed URL**: a `CloudWatch Alarm` watches `CheckQueueDLQ` and publishes to the `AlertsTopic` SNS topic as soon as any message lands there. This is deliberately *not* per-URL — a batch can have up to 500 URLs and normal 404/403 outcomes are expected, not incidents. A DLQ message means a check failed 5 times and the system gave up, which is the actual "something is wrong" signal (bad message, bug, or a site that's transiently down repeatedly). Subscribe via the `AlertEmail` deploy parameter above, or manually in the SNS console using the `AlertsTopicArn` stack output.
- **check-url timeout is 15s (Lambda) / 10s (fetch)**, not tighter, on purpose: Lambda bills for actual execution time, not the timeout ceiling, so this costs nothing extra unless a check genuinely takes that long — and a shorter fetch timeout would misreport slow-but-working sites as failures.

## Why this stack stays (mostly) free

- **Lambda, SQS**: free forever at this scale (1M requests/month each).
- **DynamoDB**: 25GB storage always free; on-demand billing means you only pay per request beyond that, which is fractions of a cent at low volume.
- **API Gateway (HTTP + WebSocket)**: free for the first 12 months (1M calls / 1M messages+750K connection-minutes per month), then pay-per-use.

No servers, containers, or Redis/Postgres instances running 24/7 — cost tracks actual traffic instead of uptime.
