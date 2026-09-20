import { describe, it, expect } from 'vitest';
import {
  istParts,
  fromISTWall,
  inQuietHours,
  deferPastQuietHours,
  withinWindow,
  nextWindowTime,
  withinDays,
  formatIST,
  formatISTDate,
} from './time.mjs';

const quiet = { start: '21:30', end: '09:30' };
const reviewWin = { start: '11:00', end: '20:00' };

describe('IST wall clock', () => {
  it('round-trips fromISTWall <-> istParts', () => {
    const d = fromISTWall(2026, 8, 20, 22, 0); // 20 Sep 2026, 22:00 IST
    const p = istParts(d);
    expect([p.y, p.mon, p.day, p.h, p.m]).toEqual([2026, 8, 20, 22, 0]);
  });
});

describe('quiet hours (21:30 -> 09:30, wraps midnight)', () => {
  it('detects inside and outside', () => {
    expect(inQuietHours(fromISTWall(2026, 8, 20, 22, 0), quiet)).toBe(true);
    expect(inQuietHours(fromISTWall(2026, 8, 20, 9, 0), quiet)).toBe(true); // before 09:30
    expect(inQuietHours(fromISTWall(2026, 8, 20, 12, 0), quiet)).toBe(false);
    expect(inQuietHours(fromISTWall(2026, 8, 20, 21, 45), quiet)).toBe(true);
  });
  it('defers a late-evening time to next day 09:30', () => {
    const out = deferPastQuietHours(fromISTWall(2026, 8, 20, 22, 0), quiet);
    expect(out.getTime()).toBe(fromISTWall(2026, 8, 21, 9, 30).getTime());
  });
  it('defers an early-morning time to same day 09:30', () => {
    const out = deferPastQuietHours(fromISTWall(2026, 8, 20, 8, 0), quiet);
    expect(out.getTime()).toBe(fromISTWall(2026, 8, 20, 9, 30).getTime());
  });
  it('leaves a daytime time unchanged', () => {
    const d = fromISTWall(2026, 8, 20, 12, 0);
    expect(deferPastQuietHours(d, quiet).getTime()).toBe(d.getTime());
  });
});

describe('send windows', () => {
  it('withinWindow', () => {
    expect(withinWindow(fromISTWall(2026, 8, 20, 12, 0), reviewWin)).toBe(true);
    expect(withinWindow(fromISTWall(2026, 8, 20, 21, 0), reviewWin)).toBe(false);
  });
  it('nextWindowTime pushes before-start to today start and after-end to tomorrow start', () => {
    expect(nextWindowTime(fromISTWall(2026, 8, 20, 9, 0), reviewWin).getTime()).toBe(fromISTWall(2026, 8, 20, 11, 0).getTime());
    expect(nextWindowTime(fromISTWall(2026, 8, 20, 21, 0), reviewWin).getTime()).toBe(fromISTWall(2026, 8, 21, 11, 0).getTime());
    const mid = fromISTWall(2026, 8, 20, 12, 0);
    expect(nextWindowTime(mid, reviewWin).getTime()).toBe(mid.getTime());
  });
});

describe('caps + formatting', () => {
  it('withinDays', () => {
    const now = fromISTWall(2026, 8, 20, 12, 0);
    expect(withinDays(fromISTWall(2026, 8, 18, 12, 0).toISOString(), now, 7)).toBe(true);
    expect(withinDays(fromISTWall(2026, 8, 1, 12, 0).toISOString(), now, 7)).toBe(false);
    expect(withinDays(null, now, 7)).toBe(false);
  });
  it('formatIST / formatISTDate', () => {
    const d = fromISTWall(2026, 8, 20, 20, 0);
    expect(formatIST(d)).toBe('20 Sep, 8:00 PM');
    expect(formatISTDate(d)).toBe('20 Sep');
  });
});
