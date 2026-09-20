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
    async ndrAction(awb, action, opts) {
      calls.push({ op: 'ndrAction', awb, action, opts });
      return { requestId: `fake-req-${calls.length}` };
    },
  };
}
