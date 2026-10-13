/* Fake WhatsApp client: records every send, returns a deterministic messageId. */
export function makeFakeWhatsApp({ failTemplateWith = null, skipWith = null } = {}) {
  const sent = [];
  let n = 0;
  const rec = (type, args) => {
    n += 1;
    sent.push({ type, ...args });
    return { messageId: `fake-wamid-${n}` };
  };
  /*
   * A Meta send failure, shaped the way the real client throws it: an Error
   * carrying `waCode`. Needed because the interesting Flow R paths are the
   * ones where Meta refuses (131026, 131049) or the template is unusable, and
   * each of those must leave the phone lock alone.
   */
  const maybeFail = () => {
    if (!failTemplateWith) return;
    const e = new Error(`fake Meta failure ${failTemplateWith}`);
    /** @type {any} */ (e).waCode = failTemplateWith;
    throw e;
  };
  return {
    sent,
    /*
     * The service-wide gate (DRY_RUN / SEND_ALLOWLIST), which the real client
     * also exposes. A caller that spends something before it sends asks this
     * first, so `skipWith` is how a test reaches that branch.
     */
    sendSkipReason: () => skipWith,
    sendTemplate: async (a) => {
      maybeFail();
      return rec('template', a);
    },
    sendText: async (a) => rec('text', a),
    sendButtons: async (a) => rec('buttons', a),
    sendCtaUrl: async (a) => rec('cta_url', a),
    sendList: async (a) => rec('list', a),
    sendFlow: async (a) => rec('flow', a),
  };
}
