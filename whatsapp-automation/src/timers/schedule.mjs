/*
 * schedule.mjs — one-time EventBridge Scheduler timers that enqueue a {kind:
 * 'timer'} message onto the FIFO queue when they fire.
 *
 *   memory : record timers in-process (tests fire them with _dueTimers()).
 *   aws    : CreateSchedule (timezone Asia/Kolkata, flexible window OFF,
 *            ActionAfterCompletion DELETE) targeting the queue with a
 *            MessageGroupId. Deterministic names so a timer can be replaced/deleted.
 */
import { config } from '../config.mjs';
import { timerName } from '../lib/ids.mjs';
import { istParts } from '../lib/time.mjs';
import { log } from '../log.mjs';

const isAws = () => config.queueBackend === 'aws';
const timers = new Map(); // name -> { at, message, groupId }

/**
 * A one-time EventBridge schedule whose at() has already passed is accepted and
 * then never invoked, so the timer is lost with no error anywhere.
 *
 * This is reachable on real data: onDelivered schedules at deliveredAt + 48h,
 * and a delivery event that arrives late (a backfilled webhook, the nightly
 * reconciliation noticing an old delivery, a DLQ redrive) puts that moment in
 * the past, which silently means no review ask for that customer, ever. Same
 * for the assumed-delivery date on an old fulfillment. Floor it instead.
 */
function notInThePast(at, now = new Date()) {
  const floor = new Date(now.getTime() + 60 * 1000);
  return at instanceof Date && at.getTime() > floor.getTime() ? at : floor;
}

function messageFor(flow, orderId, step, extra) {
  return { kind: 'timer', flow, orderId: String(orderId), step, ...(extra || {}) };
}

// at(...) expression in the scheduler's own timezone (no trailing Z).
function atExpression(date) {
  const p = istParts(date);
  const pad = (x) => String(x).padStart(2, '0');
  return `at(${p.y}-${pad(p.mon + 1)}-${pad(p.day)}T${pad(p.h)}:${pad(p.m)}:00)`;
}

let sched = null;
async function aws() {
  if (sched) return sched;
  const c = await import('@aws-sdk/client-scheduler');
  sched = {
    client: new c.SchedulerClient({ region: config.region }),
    CreateScheduleCommand: c.CreateScheduleCommand,
    DeleteScheduleCommand: c.DeleteScheduleCommand,
  };
  return sched;
}

/** Create or replace a one-time timer. @param {{flow,orderId,step,at:Date,extra?}} */
export async function scheduleTimer({ flow, orderId, step, at, extra }) {
  const name = timerName(flow, orderId, step);
  at = notInThePast(at);
  const message = messageFor(flow, orderId, step, extra);
  const groupId = `order:${orderId}`;
  if (!isAws()) {
    timers.set(name, { at, message, groupId });
    return name;
  }
  const a = await aws();
  // Replace: delete any existing, then create.
  await cancelTimer({ flow, orderId, step });
  await a.client.send(
    new a.CreateScheduleCommand({
      Name: name,
      ScheduleExpression: atExpression(at),
      ScheduleExpressionTimezone: 'Asia/Kolkata',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: {
        Arn: process.env.SCHEDULER_TARGET_ARN,
        RoleArn: process.env.SCHEDULER_ROLE_ARN,
        Input: JSON.stringify(message),
        SqsParameters: { MessageGroupId: groupId },
      },
    }),
  );
  return name;
}

export async function cancelTimer({ flow, orderId, step }) {
  const name = timerName(flow, orderId, step);
  if (!isAws()) {
    timers.delete(name);
    return;
  }
  try {
    const a = await aws();
    await a.client.send(new a.DeleteScheduleCommand({ Name: name }));
  } catch (e) {
    if (e?.name !== 'ResourceNotFoundException') log.warn('cancelTimer failed', { name, err: e.message });
  }
}

// ---- memory-backend test helpers -------------------------------------------
export function _peekTimers() {
  return [...timers.entries()].map(([name, t]) => ({ name, ...t }));
}
/** Return + remove timers due at/before `now` (simulates them firing). */
export function _dueTimers(now = new Date()) {
  const due = [];
  for (const [name, t] of timers) {
    if (t.at.getTime() <= now.getTime()) {
      due.push({ name, ...t });
      timers.delete(name);
    }
  }
  return due;
}
export function _resetTimers() {
  timers.clear();
}
