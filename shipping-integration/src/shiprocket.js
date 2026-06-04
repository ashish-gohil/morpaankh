'use strict';

/**
 * Shiprocket Admin API client.
 * Handles token auth (cached ~9 days), order creation, AWB assignment,
 * pickup generation, and tracking lookups. Uses native fetch (Node >= 18).
 */
const config = require('./config');

const BASE = 'https://apiv2.shiprocket.in/v1/external';

let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;

  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: config.shiprocket.email,
      password: config.shiprocket.password,
    }),
  });
  if (!res.ok) {
    throw new Error(`Shiprocket auth failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  // Tokens are valid ~10 days; refresh a day early.
  tokenCache = { token: data.token, expiresAt: now + 9 * 24 * 60 * 60 * 1000 };
  return data.token;
}

async function sr(path, { method = 'GET', body } = {}) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_e) {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Shiprocket ${method} ${path} -> ${res.status}: ${text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** Create an ad-hoc (custom) order. Returns { order_id, shipment_id, status, ... } */
function createOrder(payload) {
  return sr('/orders/create/adhoc', { method: 'POST', body: payload });
}

/** Assign an AWB to a shipment. Optionally force a specific courier_id. */
function assignAwb(shipmentId, courierId) {
  const body = { shipment_id: shipmentId };
  if (courierId) body.courier_id = courierId;
  return sr('/courier/assign/awb', { method: 'POST', body });
}

/** Schedule pickup for a shipment. */
function generatePickup(shipmentId) {
  return sr('/courier/generate/pickup', {
    method: 'POST',
    body: { shipment_id: [shipmentId] },
  });
}

/** Live tracking for an AWB. */
function track(awb) {
  return sr(`/courier/track/awb/${encodeURIComponent(awb)}`);
}

module.exports = { getToken, createOrder, assignAwb, generatePickup, track };
