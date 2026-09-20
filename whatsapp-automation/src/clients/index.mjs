/* Real client bundle. Flow handlers take `clients` as a param so tests can pass
 * fakes (see fakes/index.mjs); the worker passes these. */
import { whatsapp } from './whatsapp.mjs';
import { shopify } from './shopify.mjs';
import { razorpay } from './razorpay.mjs';
import { courier } from './courier.mjs';

export const realClients = { whatsapp, shopify, razorpay, courier };
export function getClients() {
  return realClients;
}
