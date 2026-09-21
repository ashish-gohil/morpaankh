#!/usr/bin/env node
/*
 * replay-dlq — move messages from the FIFO DLQ back onto the main queue.
 * Dry-run (count only) unless --confirm is passed. Requires DLQ_URL + QUEUE_URL.
 *
 *   node scripts/replay-dlq.mjs             # report DLQ depth
 *   node scripts/replay-dlq.mjs --confirm   # redrive all
 */
import { config } from '../src/config.mjs';

const confirm = process.argv.includes('--confirm');
if (!config.dlqUrl || !config.queueUrl) {
  console.error('DLQ_URL and QUEUE_URL are required.');
  process.exit(1);
}
const c = await import('@aws-sdk/client-sqs');
const sqs = new c.SQSClient({ region: config.region });

let moved = 0;
for (;;) {
  const r = await sqs.send(
    new c.ReceiveMessageCommand({
      QueueUrl: config.dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
      AttributeNames: ['MessageGroupId'],
    }),
  );
  const msgs = r.Messages || [];
  if (!msgs.length) break;
  for (const m of msgs) {
    if (!confirm) {
      moved += 1;
      continue;
    }
    const groupId = m.Attributes?.MessageGroupId || 'replay';
    await sqs.send(
      new c.SendMessageCommand({
        QueueUrl: config.queueUrl,
        MessageBody: m.Body,
        MessageGroupId: groupId,
        MessageDeduplicationId: `replay-${m.MessageId}`,
      }),
    );
    await sqs.send(new c.DeleteMessageCommand({ QueueUrl: config.dlqUrl, ReceiptHandle: m.ReceiptHandle }));
    moved += 1;
  }
}
console.log(confirm ? `redrove ${moved} messages to the main queue` : `${moved} messages in the DLQ (run with --confirm to redrive)`);
