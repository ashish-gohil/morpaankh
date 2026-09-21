#!/usr/bin/env node
/*
 * send-test — send a plain text message to an allowlisted number, to verify the
 * WhatsApp pipeline end to end. Only sends when DRY_RUN=false AND the number is
 * in SEND_ALLOWLIST (the client enforces both).
 *
 *   DRY_RUN=false SEND_ALLOWLIST=+9198... node scripts/send-test.mjs +9198... "hello from Morpaankh"
 */
import { whatsapp } from '../src/clients/whatsapp.mjs';

const [to, ...rest] = process.argv.slice(2);
const body = rest.join(' ') || 'Test message from the Morpaankh WhatsApp automation.';
if (!to) {
  console.error('usage: send-test.mjs <+phone> [message]');
  process.exit(1);
}
const res = await whatsapp.sendText({ to, body });
console.log(res.skipped ? `skipped (${res.skipped}) — set DRY_RUN=false and add ${to} to SEND_ALLOWLIST` : `sent: ${res.messageId}`);
