/*
 * track-active.mjs — re-track every active AWB (shared by the hourly poller and
 * nightly reconciliation). On a status change, enqueue a delhivery message so the
 * worker handles it with per-order serialization; terminal states drop the AWB
 * from the sparse GSI so we stop tracking it.
 */
import { realClients } from '../clients/index.mjs';
import { table } from '../store/table.mjs';
import { getState, patchState } from '../store/orderState.mjs';
import { mapCourierStatus } from '../domain/courier-status.mjs';
import { enqueue } from '../queue.mjs';
import { log } from '../log.mjs';

const TERMINAL = ['DELIVERED', 'RTO_INITIATED', 'RTO_DELIVERED', 'LOST', 'CANCELLED'];
const ACTIONABLE = ['DELIVERED', 'NDR', 'RTO_INITIATED'];

export async function trackActiveShipments(clients = realClients) {
  const active = await table.scanGsi1(); // AWB# MAP items: { PK, orderId, activeShipment }
  const awbs = active.map((a) => a.activeShipment).filter(Boolean);
  let changed = 0;
  for (let i = 0; i < awbs.length; i += 25) {
    const batch = awbs.slice(i, i + 25);
    let results = [];
    try {
      results = await clients.courier.track(batch);
    } catch (e) {
      log.error('track batch failed', { err: e.message });
      continue;
    }
    for (const r of results) {
      const map = active.find((a) => a.activeShipment === r.awb);
      if (!map) continue;
      const state = mapCourierStatus(r);
      const st = await getState(map.orderId);
      if (st?.courierStatus === state) continue; // unchanged
      /*
       * WHEN the status changed, recorded next to the status itself.
       *
       * `updatedAt` cannot answer this: every write to the row bumps it, so a
       * delivery followed by any other state change looks as recent as that
       * change. The nightly review sweep needs a date it can bound itself by,
       * and the courier's own timestamp is truer than our clock anyway.
       */
      await patchState(map.orderId, {
        courierStatus: state,
        courierStatusAt: new Date(r.statusDateTime || Date.now()).toISOString(),
      });
      if (ACTIONABLE.includes(state)) {
        /*
         * EVERY field mapCourierStatus reads, not just `status`. The worker
         * re-derives the state from this message, and it used to receive only
         * `status`, so whatever the mapping depended on `statusType` for was
         * lost in transit between the two calls.
         *
         * That silently killed RTO. Delhivery reports a return as Status
         * 'In Transit' or 'Pending' with StatusType 'RT': the RT is the ONLY
         * signal, there is no 'rto' substring to fall back on. So this function
         * stored courierStatus RTO_INITIATED (it had the full object) while the
         * worker read 'In Transit' with no type and routed it to IN_TRANSIT,
         * which onDelhivery has no branch for. Orders #1154, #1158, #1165 and
         * #1170 all sat at RTO_INITIATED with an empty flowC and nobody was
         * ever asked why their parcel came back.
         */
        await enqueue(
          {
            kind: 'delhivery',
            awb: r.awb,
            status: r.status,
            statusType: r.statusType,
            instructions: r.instructions,
            nsl: r.nsl,
            at: r.statusDateTime,
          },
          { groupId: `order:${map.orderId}`, dedupId: `poll-${r.awb}-${state}` },
        );
      }
      if (TERMINAL.includes(state)) await table.put({ PK: map.PK, SK: 'MAP', orderId: map.orderId }); // drop from GSI
      changed += 1;
    }
  }
  return { active: awbs.length, changed };
}
