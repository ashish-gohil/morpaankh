/*
 * pages.mjs — the HTML the /r/ redirect serves when it cannot send the
 * customer on to their checkout. Copy lives here with the rest of the copy,
 * not inside the Lambda, so it is covered by the no-dash/no-emoji test.
 *
 * Both pages ALWAYS give them somewhere to go. A dead end on a link we sent
 * reads as a broken shop, so the closed page still carries their bag (without
 * the code, which has genuinely closed) and the ordered page carries the store.
 */

/** Pine green and brass, Cormorant Garamond heading, one button, mobile first. */
export const CART_PAGES = {
  closed: {
    heading: 'Your private code has closed, but your bag is still saved.',
    button: 'Continue to my bag',
  },
  ordered: {
    heading: 'Your order is placed. Thank you for choosing Morpaankh.',
    button: 'Visit Morpaankh',
  },
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {{heading: string, button: string}} copy
 * @param {string} href where the button goes
 */
export function cartPage(copy, href) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Morpaankh</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500&display=swap">' +
    '<style>' +
    ':root{--pine:#2E4B3C;--brass:#B08D57;--cream:#FBF8F3}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;' +
    'background:var(--cream);color:var(--pine);' +
    'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    'main{width:100%;max-width:30rem;text-align:center}' +
    'h1{font-family:"Cormorant Garamond",Georgia,serif;font-weight:500;' +
    'font-size:clamp(1.5rem,6vw,2rem);line-height:1.3;margin:0 0 2rem}' +
    'a.btn{display:block;width:100%;padding:16px 20px;border-radius:2px;' +
    'background:var(--pine);color:var(--cream);text-decoration:none;font-size:1rem;' +
    'letter-spacing:.02em;border:1px solid var(--pine)}' +
    'a.btn:focus-visible{outline:2px solid var(--brass);outline-offset:3px}' +
    '.rule{width:48px;height:1px;background:var(--brass);margin:0 auto 1.75rem}' +
    '</style></head><body><main>' +
    '<div class="rule"></div>' +
    `<h1>${esc(copy.heading)}</h1>` +
    `<a class="btn" href="${esc(href)}">${esc(copy.button)}</a>` +
    '</main></body></html>'
  );
}
