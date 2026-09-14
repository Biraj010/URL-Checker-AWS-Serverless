import type { DynamoDBStreamHandler } from 'aws-lambda';

// TODO: for each changed batch/url item, look up subscribed WebSocket
// connections via GSI2 and postToConnection with the update. Delete stale
// (410 Gone) connection items as they're found.
export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    void record;
  }
};
