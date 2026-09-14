import awsLambdaFastify from '@fastify/aws-lambda';
import type { Handler } from 'aws-lambda';
import { buildApp } from './app';

// TODO: port routes from URL-Checker-Backend/apps/api/src/routes into ./app.ts
const app = buildApp();
const proxy = awsLambdaFastify(app);

export const handler: Handler = async (event, context) => proxy(event, context);
