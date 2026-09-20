/*
 * queue.mjs — enqueue work onto the SQS FIFO queue.
 *
 *   memory : pushes onto an in-process array (tests + DRY_RUN replay read it).
 *   aws    : SendMessageCommand with MessageGroupId (ordering per order/phone)
 *            and MessageDeduplicationId (source event id).
 *
 * A message is { kind, ...payload }. groupId serializes work for one order
 * (or one phone when the event is not order-scoped); dedupId lets SQS drop a
 * duplicate within its 5-minute window as a second line of defence.
 */
import { config } from './config.mjs';

const isAws = () => config.queueBackend === 'aws';
const sent = []; // memory backend buffer

let sqs = null;
async function aws() {
  if (sqs) return sqs;
  const c = await import('@aws-sdk/client-sqs');
  sqs = { client: new c.SQSClient({ region: config.region }), SendMessageCommand: c.SendMessageCommand };
  return sqs;
}

/**
 * @param {object} message  must include a `kind`
 * @param {{groupId:string, dedupId:string}} opts
 */
export async function enqueue(message, { groupId, dedupId }) {
  if (!groupId) throw new Error('enqueue requires a groupId (FIFO MessageGroupId)');
  if (isAws()) {
    const a = await aws();
    await a.client.send(
      new a.SendMessageCommand({
        QueueUrl: config.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: groupId,
        MessageDeduplicationId: dedupId || undefined,
      }),
    );
    return;
  }
  sent.push({ message, groupId, dedupId });
}

/** Test/DRY_RUN helpers for the memory backend. */
export function _drainQueue() {
  return sent.splice(0, sent.length);
}
export function _peekQueue() {
  return sent.slice();
}
