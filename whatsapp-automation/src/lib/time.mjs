/*
 * time.mjs — all scheduling is Asia/Kolkata (IST = UTC+5:30, no DST).
 *
 * We read/write IST wall-clock via a fixed 330-minute offset, which is exact for
 * India. Functions take an explicit `now` (a Date) so they are pure and testable.
 */
const IST_OFFSET_MIN = 330;
const MIN = 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IST wall-clock parts of a Date. */
export function istParts(date) {
  const d = new Date(date.getTime() + IST_OFFSET_MIN * MIN);
  return {
    y: d.getUTCFullYear(),
    mon: d.getUTCMonth(),
    day: d.getUTCDate(),
    h: d.getUTCHours(),
    m: d.getUTCMinutes(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** A UTC Date for a given IST wall time. */
export function fromISTWall(y, mon, day, h, m) {
  return new Date(Date.UTC(y, mon, day, h, m) - IST_OFFSET_MIN * MIN);
}

const hhmmToMin = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
};

export const addMinutes = (date, mins) => new Date(date.getTime() + mins * MIN);
export const addHours = (date, hours) => new Date(date.getTime() + hours * 60 * MIN);
export const addDays = (date, days) => new Date(date.getTime() + days * 24 * 60 * MIN);

/** Quiet hours wrap midnight (e.g. 21:30 -> 09:30). */
export function inQuietHours(date, quiet) {
  const cur = istParts(date).minutes;
  const start = hhmmToMin(quiet.start);
  const end = hhmmToMin(quiet.end);
  return start > end ? cur >= start || cur < end : cur >= start && cur < end;
}

/** If `date` is in quiet hours, the next 09:30 IST; otherwise `date` unchanged. */
export function deferPastQuietHours(date, quiet) {
  if (!inQuietHours(date, quiet)) return date;
  const p = istParts(date);
  const endMin = hhmmToMin(quiet.end);
  // If we're in the late-evening part of quiet hours, 09:30 is tomorrow.
  const rollToNextDay = p.minutes >= hhmmToMin(quiet.start);
  const base = fromISTWall(p.y, p.mon, p.day, Math.floor(endMin / 60), endMin % 60);
  return rollToNextDay ? addDays(base, 1) : base;
}

/** True if `date` (IST) falls inside a same-day window like {start:'11:00',end:'20:00'}. */
export function withinWindow(date, window) {
  const cur = istParts(date).minutes;
  return cur >= hhmmToMin(window.start) && cur < hhmmToMin(window.end);
}

/** The next time `date` lands inside `window` (today's start, now, or tomorrow's start). */
export function nextWindowTime(date, window) {
  const p = istParts(date);
  const startMin = hhmmToMin(window.start);
  const endMin = hhmmToMin(window.end);
  const start = fromISTWall(p.y, p.mon, p.day, Math.floor(startMin / 60), startMin % 60);
  if (p.minutes < startMin) return start;
  if (p.minutes >= endMin) return addDays(start, 1);
  return date;
}

/**
 * The fixed daily `hhmm` IST slot, `minDays` whole days after `from`.
 *
 * Review asks used to be scheduled as "delivery + 48h, nudged into an
 * 11:00-20:00 window", which put every order's ask at its own arbitrary hour:
 * one at 11:27, the next at 16:29, the next at 12:20. The owner wants one
 * predictable time a day, so the slot is derived from the IST CALENDAR DATE of
 * `from` rather than from an offset, which is what makes "the day after it was
 * delivered, at 9pm" mean the same thing for a 6am delivery and a 10pm one.
 *
 * Rolled forward past `now` because a delivery signal can arrive late (a
 * backfilled webhook, a DLQ redrive, the nightly sweep noticing an old
 * delivery). Its slot is then already gone, and EventBridge accepts an at()
 * expression in the past and then never invokes it, so the ask would be lost
 * with no error anywhere.
 */
export function nextDailySlot(from, hhmm, { minDays = 1, now = new Date() } = {}) {
  const mins = hhmmToMin(hhmm);
  const p = istParts(from);
  let at = addDays(fromISTWall(p.y, p.mon, p.day, Math.floor(mins / 60), mins % 60), minDays);
  while (at.getTime() <= now.getTime()) at = addDays(at, 1);
  return at;
}

/** True if `lastISO` is within `days` before `now` (used for caps). */
export function withinDays(lastISO, now, days) {
  if (!lastISO) return false;
  return now.getTime() - new Date(lastISO).getTime() < days * 24 * 60 * MIN;
}

/** "20 Sep, 8:00 PM" in IST. */
export function formatIST(date) {
  const p = istParts(date);
  const ampm = p.h >= 12 ? 'PM' : 'AM';
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const mm = String(p.m).padStart(2, '0');
  return `${p.day} ${MONTHS[p.mon]}, ${h12}:${mm} ${ampm}`;
}

/**
 * "2026-11-06": the IST calendar day, as a key.
 *
 * Not a display format and not derived from toISOString(), which is UTC and so
 * files everything after 18:30 IST under the previous day. Used wherever
 * something must happen once per IST day: the cart capture caps, Flow C's one
 * prompt per failed delivery attempt.
 */
export function istDayKey(date) {
  const p = istParts(date);
  return `${p.y}-${String(p.mon + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** "20 Sep" in IST (date only). */
export function formatISTDate(date) {
  const p = istParts(date);
  return `${p.day} ${MONTHS[p.mon]}`;
}

/** End of the IST day (23:59) for `date`, as a UTC Date. */
export function endOfDayIST(date) {
  const p = istParts(date);
  return fromISTWall(p.y, p.mon, p.day, 23, 59);
}
