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
        await enqueue(
          { kind: 'delhivery', awb: r.awb, status: r.status, at: r.statusDateTime },
          { groupId: `order:${map.orderId}`, dedupId: `poll-${r.awb}-${state}` },
        );
      }
      if (TERMINAL.includes(state)) await table.put({ PK: map.PK, SK: 'MAP', orderId: map.orderId }); // drop from GSI
      changed += 1;
    }
  }
  return { active: awbs.length, changed };
}
