/*
 * log.mjs — structured, masked logging + CloudWatch EMF metrics.
 *
 * Hard rule: never log a full phone number, address, or token. maskPhone keeps
 * only the last 4 digits. Everything goes through JSON.stringify so CloudWatch
 * Logs Insights can query fields.
 */

/** "+9198xxxx4567" -> "+91xxxxxx4567"; keeps country hint + last 4 only. */
export function maskPhone(p) {
  if (!p) return '(none)';
  const s = String(p);
  const last4 = s.slice(-4);
  return `${s.slice(0, 3)}${'x'.repeat(Math.max(0, s.length - 7))}${last4}`;
}

/** "priya.test@example.com" -> "p***@example.com"; keeps the DOMAIN only. */
export const maskEmail = (e) => String(e).replace(/^(.)[^@]*@/, '$1***@');

/*
 * THE HOLE THE `phone` NET ABOVE DOES NOT COVER: a PROVIDER'S error message.
 *
 * Callers are disciplined about their own fields, but every error path logs
 * `err.message` (and soft() logs four frames of stack with it), and those
 * strings are written by SES, Meta and Shopify. SES in SANDBOX answers an
 * unverified recipient with "The following identities failed the check in
 * region ap-south-1: <the customer's address>", so the single most likely
 * error on the email channel's first day carries a real customer's address.
 *
 * Redacting the SERIALISED line rather than named fields is deliberate: the
 * address can be nested in `err`, in `stack`, or in a field nobody has
 * written yet, and a net that only covers today's field names is the net that
 * already failed once. The domain is kept because it is what distinguishes a
 * sandbox rejection from a typo'd address, and it identifies nobody.
 */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function emit(level, msg, fields = {}) {
  /** @type {Record<string, any>} */
  const line = { level, msg, t: new Date().toISOString(), ...fields };
  // Defensive: never let a stray phone field leak unmasked.
  if (typeof line.phone === 'string' && line.phone.length > 6) line.phone = maskPhone(line.phone);
  const out = JSON.stringify(line).replace(EMAIL_IN_TEXT, maskEmail);
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

export const log = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

/**
 * Emit one CloudWatch EMF metric line (namespace WAAutomation). Counts by flow
 * and step so Flow D can report volume and failures without extra plumbing.
 * @param {string} name  metric name, e.g. "MessageSent"
 * @param {number} value
 * @param {Record<string,string>} [dims]  e.g. { flow: "A", step: "cod_confirm" }
 */
export function metric(name, value = 1, dims = {}) {
  const dimNames = Object.keys(dims);
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'WAAutomation',
          Dimensions: dimNames.length ? [dimNames] : [[]],
          Metrics: [{ Name: name, Unit: 'Count' }],
        },
      ],
    },
    [name]: value,
    ...dims,
  };
  console.log(JSON.stringify(emf));
}
