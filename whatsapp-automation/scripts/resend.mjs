#!/usr/bin/env node
/*
 * resend — re-enqueue a timer step for an order (e.g. re-run the COD ask or the
 * review ask). Serialized per order via the FIFO group. Requires QUEUE_URL and
 * QUEUE_BACKEND=aws.
 *
 *   node scripts/resend.mjs <orderId> <flow A|B|C> <step>
 *   e.g. node scripts/resend.mjs 5551234567 A cod
 */
import { enqueue } from '../src/queue.mjs';

const [orderId, flow, step] = process.argv.slice(2);
if (!orderId || !flow || !step) {
  console.error('usage: resend.mjs <orderId> <flow> <step>');
  process.exit(1);
}
await enqueue({ kind: 'timer', flow: flow.toUpperCase(), orderId, step }, { groupId: `order:${orderId}`, dedupId: `resend-${flow}-${orderId}-${step}-${Date.now()}` });
console.log(`re-enqueued ${flow}/${step} for order ${orderId}`);
