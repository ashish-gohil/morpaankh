/* Fake WhatsApp client: records every send, returns a deterministic messageId. */
export function makeFakeWhatsApp({ failTemplateWith = null, skipWith = null, templates = {}, media = {} } = {}) {
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
    /*
     * Kept in step with the real client so the digest's health check has
     * something to call. Defaults to "everything approved", which is the quiet
     * case; a test that wants the unhappy path passes `templates`.
     */
    listTemplates: async () => templates,
    sendTemplate: async (a) => {
      maybeFail();
      return rec('template', a);
    },
    sendText: async (a) => rec('text', a),
    sendButtons: async (a) => rec('buttons', a),
    sendCtaUrl: async (a) => rec('cta_url', a),
    sendList: async (a) => rec('list', a),
    sendFlow: async (a) => rec('flow', a),
    /*
     * Media upload records itself like a send so a test can assert the file
     * that went up (name, mime, byte length) without holding the bytes. It
     * returns a deterministic id so a golden test stays stable.
     */
    uploadMedia: async ({ bytes, filename, mime }) => {
      sent.push({ type: 'media', filename, mime, bytes: bytes?.length ?? 0 });
      return { mediaId: `fake-media-${filename}` };
    },
    sendDocument: async (a) => rec('document', a),
    downloadMedia: async (id) => media[id] || { bytes: Buffer.from(''), mime: '', filename: '' },
  };
}
