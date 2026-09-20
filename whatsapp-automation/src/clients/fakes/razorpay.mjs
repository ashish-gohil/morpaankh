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
    async refund(paymentId, amountPaise) {
      const r = { id: `rfnd_fake_${refunds.length + 1}`, paymentId, amountPaise };
      refunds.push(r);
      return { id: r.id };
    },
  };
}
