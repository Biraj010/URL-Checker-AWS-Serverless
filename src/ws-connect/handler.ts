import type { APIGatewayProxyHandler } from 'aws-lambda';

// TODO: no-op until 'subscribe' message arrives (ws-subscribe writes the
// connection item, since $connect doesn't know the batchId yet).
export const handler: APIGatewayProxyHandler = async () => {
  return { statusCode: 200, body: '' };
};
