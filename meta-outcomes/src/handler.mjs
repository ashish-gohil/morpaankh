/*
 * handler.mjs — AWS Lambda entry point.
 *
 * EventBridge Scheduler invokes this on a timer (twice a day). It just runs one
 * poll. Configure the Lambda with STATE_BACKEND=s3 + STATE_S3_BUCKET, and the
 * Shopify/Meta env vars. Set reserved concurrency = 1 so two runs can never
 * overlap the shared state object.
 */
import { runPoll } from './poll.mjs';

export const handler = async (event) => {
  const summary = await runPoll();
  return { ok: true, ...summary };
};
