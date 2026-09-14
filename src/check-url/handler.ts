import type { SQSBatchResponse, SQSHandler } from 'aws-lambda';

// TODO: port URL-fetch + classify logic from
// URL-Checker-Backend/apps/worker/src (10s timeout, transient vs permanent
// failure classification, write result to DynamoDB).
export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      // const message = JSON.parse(record.body);
      // ... fetch URL, write status to DynamoDB ...
    } catch (err) {
      // transient failure -> let SQS retry this message
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
