/**
 * AWS Lambda entry point.
 *
 * The app context is created once per execution environment (cold start) and
 * reused across invocations. Stateless mode is forced: Lambda shares no
 * memory between invocations, so sessions are ephemeral by construction.
 *
 * Works behind API Gateway (HTTP API, payload v2) and Lambda Function URLs.
 */
import { createLambdaHandler } from './adapters/lambda.js';
import { loadConfig } from './config/index.js';
import { createAppContext } from './core/container.js';

const baseConfig = loadConfig();
const app = createAppContext({
  config: {
    ...baseConfig,
    session: { ...baseConfig.session, stateless: true },
  },
});

export const handler = createLambdaHandler(app);
