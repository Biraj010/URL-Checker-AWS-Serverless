import type { APIGatewayProxyHandler } from 'aws-lambda';

// TODO: delete the CONN#<connectionId> item from DynamoDB.
export const handler: APIGatewayProxyHandler = async () => {
  return { statusCode: 200, body: '' };
};
