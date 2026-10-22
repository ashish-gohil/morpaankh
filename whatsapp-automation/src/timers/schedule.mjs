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

/**
 * Create or replace a one-time timer.
 *
 * `groupId` defaults to the per-order group every existing caller relies on.
 * Flow R passes `phone:<e164>` instead, because its unit of serialization is
 * the PERSON, not an order: a checkout has no order id, and two messages to one
 * customer must never overtake each other. Nothing downstream parses the group
 * id; it is handed straight to SQS as the MessageGroupId.
 *
 * `now` is the caller's clock, and it is what the past-floor above is measured
 * against. Every flow already takes an injected `now` (`deps.now`) so that its
 * behaviour is a function of time rather than of when the test ran, but this
 * floor read `new Date()` directly, which quietly broke that contract: with a
 * clock set anywhere in the past, EVERY timer collapsed onto real-now+60s, so
 * two touches deliberately spaced hours apart landed on the same instant. In
 * production the two clocks are the same value (`deps()` builds `now: new
 * Date()` per invocation), so this changes nothing there; it only stops a fake
 * clock being overruled by the wall clock. Callers without a clock still get
 * the wall clock, which is what EventBridge needs.
 *
 * @param {{flow:string,orderId:string|number,step:string,at:Date,extra?:object,groupId?:string,now?:Date}} args
 */
export async function scheduleTimer({ flow, orderId, step, at, extra, groupId: group, now }) {
  const name = timerName(flow, orderId, step);
  at = notInThePast(at, now || new Date());
  const message = messageFor(flow, orderId, step, extra);
  const groupId = group || `order:${orderId}`;
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
