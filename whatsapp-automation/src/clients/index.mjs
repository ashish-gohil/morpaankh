/* Real client bundle. Flow handlers take `clients` as a param so tests can pass
 * fakes (see fakes/index.mjs); the worker passes these. */
import { whatsapp } from './whatsapp.mjs';
import { email } from './email.mjs';
import { shopify } from './shopify.mjs';
import { razorpay } from './razorpay.mjs';
import { courier } from './courier.mjs';
import { getLogistics } from './logistics/index.mjs';

/* `courier` and `logistics` are both Delhivery and that is on purpose: courier
 * is the shipment the customer bought (track, edit, NDR) and logistics is the
 * provider-neutral booking interface /replace books replacements through. They
 * are separate because /replace must be able to change courier without
 * touching a single flow. */
export const realClients = {
  whatsapp,
  /*
   * Flow W only, and only for somebody WhatsApp cannot reach. It is listed
   * here rather than imported where it is used so that a test can hand the
   * flows a fake SES the same way it hands them a fake WhatsApp.
   */
  email,
  shopify,
  razorpay,
  courier,
  /*
   * A getter, so an unknown LOGISTICS_PROVIDER cannot throw while this module
   * is being imported and kill every flow in the service on cold start. See
   * the comment in logistics/index.mjs.
   */
  get logistics() {
    return getLogistics();
  },
};
export function getClients() {
  return realClients;
}
