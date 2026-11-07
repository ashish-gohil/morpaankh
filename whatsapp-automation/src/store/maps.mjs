/*
 * maps.mjs — AWB#/PAYLINK#/PAYTOKEN#/WAMID# lookup rows -> orderId (+ small
 * payloads).
 *
 * EVERY ROW HERE EXPIRES, and none of them did before. One order writes an
 * AWB#, a PAYLINK#, a PAYTOKEN# and one WAMID# per message, and all of them
 * sat in the table forever: storage, point-in-time-recovery size and every
 * remaining scan grew with how long the shop had been open rather than with
 * the work it was doing.
 *
 * 180 days, matching stateRetentionDays, because these are all lookups FROM a
 * provider's id back to an order and nothing asks about a parcel, a payment
 * link or a six-month-old message id. The exception is PAYTOKEN#, which is
 * given its own deadline by the caller: it carries the link's expiry, and
 * /p/{token} shows the expired page when the row has gone.
 *
 * NEVER derived from a business deadline. A code's life, a lock's lease and a
 * link's expiry are promises; `expiresAt` is DynamoDB's eviction, and letting
 * one stand in for the other is how a row disappears while it still matters.
 */
import { table } from './table.mjs';
import { RULES } from '../../messages/rules.mjs';

const ttl = (days, now = new Date()) => Math.floor(now.getTime() / 1000) + days * 86400;

/*
 * `at` as well as `expiresAt`, and it is not decoration: a backfill dry run on
 * 2026-11-07 found 424 rows it could not stamp honestly because these rows had
 * never recorded WHEN they were written, so there was nothing to compute an
 * expiry from. One field means the next migration has an answer.
 */
const put = (pk, data, days = RULES.stateRetentionDays) =>
  table.put({ PK: pk, SK: 'MAP', at: new Date().toISOString(), expiresAt: ttl(days), ...data });
const get = (pk) => table.get(pk, 'MAP');

export const setAwbMap = (awb, orderId) => put(`AWB#${awb}`, { orderId, activeShipment: awb });
export const getAwbMap = (awb) => get(`AWB#${awb}`);

export const setPaylinkMap = (linkId, orderId) => put(`PAYLINK#${linkId}`, { orderId });
export const getPaylinkMap = (linkId) => get(`PAYLINK#${linkId}`);

/*
 * `data` carries its own `expiresAt` (the Razorpay link's expiry, in epoch
 * seconds) and the spread puts it AFTER the default, so the link's deadline
 * wins. That is the one place where the two coincide honestly: the row is
 * worthless the moment the link it points at is dead, and /p/{token} already
 * shows the expired page when the row is missing.
 */
export const setPayTokenMap = (token, data) => put(`PAYTOKEN#${token}`, data); // { orderId, url, expiresAt }
export const getPayTokenMap = (token) => get(`PAYTOKEN#${token}`);

// A delivery status webhook carries only the wamid. Without this row there is
// no way back to the order, so a message Meta accepted and then failed to
// deliver was invisible per-order: the log said a phone number and a code.
export const setWamidMap = (wamid, data) => put(`WAMID#${wamid}`, data); // { orderId, key }
export const getWamidMap = (wamid) => get(`WAMID#${wamid}`);
