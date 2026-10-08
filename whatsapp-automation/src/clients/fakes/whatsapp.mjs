/* Fake WhatsApp client: records every send, returns a deterministic messageId. */
export function makeFakeWhatsApp() {
  const sent = [];
  let n = 0;
  const rec = (type, args) => {
    n += 1;
    sent.push({ type, ...args });
    return { messageId: `fake-wamid-${n}` };
  };
  return {
    sent,
    sendTemplate: async (a) => rec('template', a),
    sendText: async (a) => rec('text', a),
    sendButtons: async (a) => rec('buttons', a),
    sendCtaUrl: async (a) => rec('cta_url', a),
    sendList: async (a) => rec('list', a),
    sendFlow: async (a) => rec('flow', a),
  };
}
