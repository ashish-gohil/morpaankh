/* Fake client bundle for tests + the DRY_RUN fixture replay (Phase 16). */
import { makeFakeWhatsApp } from './whatsapp.mjs';
import { makeFakeShopify } from './shopify.mjs';
import { makeFakeRazorpay } from './razorpay.mjs';
import { makeFakeCourier } from './courier.mjs';
import { makeFakeLogistics } from './logistics.mjs';

export function makeFakeClients(opts = {}) {
  return {
    whatsapp: makeFakeWhatsApp(opts.whatsapp || {}),
    shopify: makeFakeShopify(opts.shopify || {}),
    razorpay: makeFakeRazorpay(),
    courier: makeFakeCourier(opts.courier || {}),
    logistics: makeFakeLogistics(opts.logistics || {}),
  };
}

export { makeFakeWhatsApp, makeFakeShopify, makeFakeRazorpay, makeFakeCourier, makeFakeLogistics };
