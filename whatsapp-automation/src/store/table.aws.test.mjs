/*
 * The AWS backend's own condition expressions.
 *
 * Every other store test runs the memory backend, which is a separate
 * implementation. That is fine for behaviour, but the LEASE is different: the
 * memory version compares two strings in JS, while production sends a
 * ConditionExpression to DynamoDB, and nothing was asserting what that
 * expression says. Replacing it with `attribute_not_exists(PK)` alone would
 * have left the whole suite green and silently blocked every customer who
 * abandoned more than cooldownDays ago until DynamoDB's TTL sweeper caught up,
 * which routinely runs days late.
 *
 * The client is stubbed, so this reaches no AWS account.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config.mjs';
import { lockPhone } from './cartRecovery.mjs';

const PHONE = '+919637361371';
const NOW = new Date('2026-10-12T06:30:00Z');

describe('the AWS lease condition', () => {
  let sent;
  let spy;
  let backend;

  beforeEach(async () => {
    sent = [];
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    spy = vi.spyOn(DynamoDBClient.prototype, 'send').mockImplementation(async (c) => {
      sent.push(c.input);
      return {};
    });
    backend = config.dynamoBackend;
    config.dynamoBackend = 'aws';
  });

  afterEach(() => {
    config.dynamoBackend = backend;
    spy.mockRestore();
  });

  it('honours an expired lockUntil rather than waiting for the TTL', async () => {
    const taken = await lockPhone(PHONE, {
      checkoutId: '66743166239092',
      until: new Date('2026-11-11T06:30:00Z'),
      now: NOW,
    });
    expect(taken).toBe(true);

    const put = sent.at(-1);
    expect(put.ConditionExpression).toBe('attribute_not_exists(PK) OR #f <= :now');
    // lockUntil, NOT expiresAt: the TTL attribute is 180-day retention and
    // says nothing about whether the lease is still held.
    expect(put.ExpressionAttributeNames).toEqual({ '#f': 'lockUntil' });
    expect(put.ExpressionAttributeValues[':now'].S).toBe(NOW.toISOString());
    expect(put.Item.lockUntil.S).toBe('2026-11-11T06:30:00.000Z');
    expect(put.Item.SK.S).toBe('LOCK');
  });

  it('reports a live lease as taken instead of throwing', async () => {
    spy.mockImplementation(async () => {
      const e = new Error('The conditional request failed');
      e.name = 'ConditionalCheckFailedException';
      throw e;
    });
    await expect(
      lockPhone(PHONE, { checkoutId: '1', until: new Date('2026-11-11T06:30:00Z'), now: NOW }),
    ).resolves.toBe(false);
  });
});
