import type { APIGatewayProxyHandler } from 'aws-lambda';

// TODO: parse { action: 'subscribe', batchId } from event.body and write
// a CONN#<connectionId> item keyed with GSI2PK=batchId for fanout lookup.
export const handler: APIGatewayProxyHandler = async () => {
  return { statusCode: 200, body: '' };
};
