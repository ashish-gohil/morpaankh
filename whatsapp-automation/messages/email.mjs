/*
 * email.mjs — the email versions of the flows' copy, and the one renderer that
 * turns them into a message SES can send.
 *
 * There is exactly one entry today, Flow W's welcome offer, and it exists
 * because a customer whose number we cannot reach on WhatsApp still joined the
 * shop and still deserves the offer. It is held to the SAME copy rules as a
 * template: no en or em dash, no emoji, the rupee symbol and not "Rs", and the
 * same promise in the same words. registry.test.mjs enforces all of that,
 * including that the body is byte-identical to the WhatsApp one.
 *
 * `body` IS the WhatsApp body, imported rather than retyped. A third copy of
 * those nine lines beside templates.mjs and session.mjs is a third place for
 * them to drift, and the thing being promised is money and a gift.
 *
 * The HTML is inline-styled and 600px wide because that is the only thing
 * every mail client agrees on: Gmail strips <style> blocks, Outlook renders
 * through Word. No external CSS, no web fonts, no images we host.
 */
import { TEMPLATES } from './templates.mjs';

export const EMAIL = {
  subscriber_offer: {
    /*
     * The closing time is in the subject on purpose: this is a 24 hour offer
     * and a subject line that does not say so is asking to be opened tomorrow.
     * subjectNoName is used when Shopify holds no first name, because
     * "there, your private welcome code" reads as a mail merge that failed.
     */
    subject: '{{first_name}}, your private welcome code closes tomorrow',
    subjectNoName: 'Your private welcome code closes tomorrow',
    // The preview line most clients show beside the subject. Without one they
    // show the first words of the HTML, which here would be the heading again.
    preheader: '₹200 off any order above ₹1,500, plus a gift in your parcel.',
    heading: 'A private welcome, for the next 24 hours',
    button: 'Shop best sellers',
    body: TEMPLATES.subscriber_offer.body,
    /*
     * Every condition on the code, in one place, in plain words. The minimum is
     * already in the body, and it is repeated here with the closing time
     * because this is the part a customer re-reads at the cart when something
     * does not apply. The last sentence is why they are hearing from us at all,
     * which is what makes this a marketing email somebody can account for
     * rather than one that arrived from nowhere.
     */
    smallPrint:
      'Single use. Valid on orders above ₹1,500 until {{expires_at}} IST. ' +
      'Cannot be combined with other codes. ' +
      'You are receiving this because you joined us at morpaankh.in.',
    unsubscribe: 'Unsubscribe',
  },
};

/* The brand's three colours, from theme-variables.css. Named, not repeated. */
const PINE = '#2E4B3C';
const BRASS = '#B08D57';
const CREAM = '#FAF7F0';
const INK = '#2B2B2B';

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Fill named placeholders, passing every value through `esc` on the way in. */
const fill = (str, vars, esc = (v) => v) =>
  String(str).replace(PLACEHOLDER, (_, k) => esc(vars[k] == null ? '' : String(vars[k])));

/*
 * A header value can carry no CR and no LF, ever. Shopify gives us the
 * unsubscribe URL and the customer gives us their address, and a bare CRLF in
 * either appends headers of somebody else's choosing to our message: a Bcc, a
 * second Reply-To, a forged From.
 */
export const headerSafe = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();

/**
 * One product tile. Three of them sit side by side at 600px and stack by
 * themselves on a phone, because they are table cells with a percentage width
 * rather than a flex row, which is the only layout Outlook gets right.
 */
function tile(p, href, esc) {
  const img = p.imageUrl
    ? `<img src="${esc(p.imageUrl)}" width="176" alt="${esc(p.title)}" style="display:block;width:100%;max-width:176px;height:auto;border:0;border-radius:2px" />`
    : '';
  return `<td width="33%" style="padding:0 6px;vertical-align:top">
      <a href="${esc(href)}" style="text-decoration:none;color:${INK}">${img}
        <div style="font:400 14px/1.4 Georgia,'Times New Roman',serif;padding:8px 0 0">${esc(p.title)}</div>
      </a>
    </td>`;
}

/**
 * The welcome offer as an email: a subject, a text part and an HTML part.
 *
 * EVERY interpolated value is escaped on the way into the HTML and stripped of
 * CR and LF on the way into a header. The product titles and the customer's
 * own name are the two that come from outside this service.
 *
 * @param {{vars: Record<string,string>, rawFirstName?: string, url: string,
 *          picks?: any[], unsubscribeUrl?: string, shopUrl: string,
 *          utm?: string, escapeHtml: (v: any) => string}} args
 * @returns {{subject: string, text: string, html: string}}
 */
export function renderSubscriberEmail({ vars, rawFirstName, url, picks = [], unsubscribeUrl, shopUrl, utm = '', escapeHtml: esc }) {
  const c = EMAIL.subscriber_offer;
  const subject = headerSafe(
    rawFirstName ? fill(c.subject, { first_name: vars.customer_name }) : c.subjectNoName,
  );

  // The text part keeps the words and drops the WhatsApp bold markers: an
  // asterisk is emphasis on WhatsApp and litter in an inbox.
  const plain = fill(c.body, vars).replace(/\*/g, '');
  const text = [
    c.heading,
    '',
    plain,
    '',
    `${c.button}: ${url}`,
    '',
    fill(c.smallPrint, vars),
    unsubscribeUrl ? `${c.unsubscribe}: ${unsubscribeUrl}` : '',
  ].join('\n');

  /*
   * Escape the BODY first and the values as they go in, so a value cannot
   * close a tag and the body's own asterisks still become <strong>. The
   * placeholders survive escaping untouched, which is what makes this order
   * work rather than only look careful.
   */
  const bodyHtml = fill(esc(c.body), vars, esc)
    .replace(/\*([^*\n]+)\*/g, `<strong style="color:${PINE}">$1</strong>`)
    .split('\n\n')
    .map((para) => `<p style="margin:0 0 16px">${para.replace(/\n/g, '<br />')}</p>`)
    .join('');

  const tiles = picks.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr>${
      /*
       * The tiles go STRAIGHT to the shop, so they carry the campaign tags
       * themselves. The button above goes through /w/{token} instead, because
       * that is what applies the code and counts the tap; its own destination
       * is built from the record at redirect time and is tagged there.
       */
      picks.slice(0, 3).map((p) => tile(p, `${shopUrl}/products/${p.handle || ''}${utm ? `?${utm}` : ''}`, esc)).join('')
    }</tr></table>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${CREAM};color:${INK}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM}">
<tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid ${BRASS}33">
  <tr><td style="padding:28px 28px 0">
    <div style="font:400 13px/1 Georgia,'Times New Roman',serif;letter-spacing:0.14em;text-transform:uppercase;color:${BRASS}">Morpaankh</div>
    <h1 style="font:400 26px/1.25 Georgia,'Times New Roman',serif;color:${PINE};margin:16px 0 20px">${esc(c.heading)}</h1>
  </td></tr>
  <tr><td style="padding:0 28px;font:400 15px/1.6 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${bodyHtml}</td></tr>
  <tr><td style="padding:4px 28px 0" align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto">
      <tr><td align="center" style="border:2px solid ${BRASS};border-radius:2px;padding:14px 22px;background:${CREAM}">
        <div style="font:700 22px/1 'Courier New',Courier,monospace;letter-spacing:0.08em;color:${PINE}">${esc(vars.code)}</div>
      </td></tr>
    </table>
  </td></tr>
  <tr><td align="center" style="padding:24px 28px 8px">
    <a href="${esc(url)}" style="display:inline-block;background:${PINE};color:#FFFFFF;text-decoration:none;padding:14px 28px;font:400 15px/1 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:0.04em;border-radius:2px">${esc(c.button)}</a>
  </td></tr>
  <tr><td style="padding:16px 22px 0">${tiles}</td></tr>
  <tr><td style="padding:0 28px 28px;border-top:1px solid ${BRASS}33">
    <p style="font:400 12px/1.6 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#6B6B6B;margin:16px 0 8px">${fill(esc(c.smallPrint), vars, esc)}</p>
    ${unsubscribeUrl ? `<p style="margin:0;font:400 12px/1.6 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><a href="${esc(unsubscribeUrl)}" style="color:#6B6B6B">${esc(c.unsubscribe)}</a></p>` : ''}
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}
