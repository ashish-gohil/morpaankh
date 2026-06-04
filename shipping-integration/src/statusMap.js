'use strict';

/**
 * Map a free-text Shiprocket status into a Shopify fulfillment-event status
 * plus an RTO flag. Shiprocket status strings vary by courier, so we match on
 * substrings, checking the most specific cases first.
 */
function mapStatus(raw) {
  const s = String(raw || '').toLowerCase();

  // RTO is the priority signal — flag it wherever it appears.
  if (s.includes('rto')) return { event: 'failure', rto: true };

  if (s.includes('out for delivery') || s.includes('ofd')) {
    return { event: 'out_for_delivery', rto: false };
  }
  // Check failure/undelivered BEFORE "delivered": the substring "delivered"
  // lives inside "undelivered" / "non delivered", so this order matters.
  if (
    s.includes('undelivered') ||
    s.includes('non delivered') ||
    s.includes('not delivered') ||
    s.includes('ndr') ||
    s.includes('exception') ||
    s.includes('failed') ||
    s.includes('lost') ||
    s.includes('damaged')
  ) {
    return { event: 'failure', rto: false };
  }
  if (s.includes('delivered')) return { event: 'delivered', rto: false };
  if (
    s.includes('in transit') ||
    s.includes('in-transit') ||
    s.includes('picked') ||
    s.includes('pickup') ||
    s.includes('shipped') ||
    s.includes('dispatch')
  ) {
    return { event: 'in_transit', rto: false };
  }
  if (s.includes('cancel')) return { event: 'failure', rto: false };

  // Default: acknowledge without overstating progress.
  return { event: 'confirmed', rto: false };
}

module.exports = { mapStatus };
