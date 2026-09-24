/* Fake Razorpay client: records links + refunds. */
export function makeFakeRazorpay() {
  const links = [];
  const cancelled = [];
  const refunds = [];
  let n = 0;
  return {
    links,
    cancelled,
    refunds,
    async createLink(args) {
      n += 1;
      const link = { id: `plink_fake_${n}`, shortUrl: `https://rzp.fake/${n}`, args };
      links.push(link);
      return { id: link.id, shortUrl: link.shortUrl };
    },
    async cancelLink(id) {
      cancelled.push(id);
      return { ok: true };
    },
    // Razorpay's refund endpoint only accepts a pay_... id. The fake used to
    // accept anything, which is why a plink_... reaching it went unnoticed in
    // tests and only showed up as a failed refund in production.
    async refund(paymentId, amountPaise) {
      if (!/^pay_/.test(String(paymentId || ''))) {
        const e = new Error(`razorpay POST /payments/${paymentId}/refund failed: ${paymentId} is not a valid id`);
        /** @type {any} */ (e).status = 400;
        /** @type {any} */ (e).description = `${paymentId} is not a valid id`;
        throw e;
      }
      const r = { id: `rfnd_fake_${refunds.length + 1}`, paymentId, amountPaise };
      refunds.push(r);
      return { id: r.id };
    },
  };
}
