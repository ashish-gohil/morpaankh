/* Fake courier: seedable per-AWB status, records edits/cancels/NDR actions. */
export function makeFakeCourier({ statuses = {} } = {}) {
  const state = new Map(Object.entries(statuses)); // awb -> { status, statusType, ... }
  const calls = [];
  return {
    state,
    calls,
    setStatus(awb, s) {
      state.set(awb, s);
    },
    async track(awbs) {
      return (Array.isArray(awbs) ? awbs : [awbs]).map((awb) => ({ awb, ...(state.get(awb) || { status: 'UNKNOWN' }) }));
    },
    async editToPrepaid(awb) {
      calls.push({ op: 'editToPrepaid', awb });
      return { ok: true };
    },
    async cancel(awb) {
      calls.push({ op: 'cancel', awb });
      return { ok: true };
    },
    /*
     * The real client does not return until the status API has confirmed the
     * waybill, and throws otherwise, so the happy-path fake has to claim the
     * confirmation too. A test that wants the refusal replaces this method and
     * throws; see flowC.test.mjs.
     */
    async ndrAction(awb, action, opts) {
      calls.push({ op: 'ndrAction', awb, action, opts });
      return { requestId: `fake-req-${calls.length}`, confirmed: true };
    },
    async ndrStatus(requestId) {
      calls.push({ op: 'ndrStatus', requestId });
      return { status: 'Success', remark: '', requestId, failed: [], success: [] };
    },
  };
}
