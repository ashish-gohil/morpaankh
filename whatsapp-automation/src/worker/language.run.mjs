/*
 * language.run.mjs — Flow L: the customer choosing which language we write in.
 *
 * Three ways in, all of them ending at setLang on the PHONE:
 *   a tap on the picker's two buttons (lang_en / lang_hi)
 *   typing HINDI, ENGLISH, हिंदी, भाषा and the rest
 *   the owner typing /lang 1214 hi
 *
 * The invariant this file exists to hold: A TAP IS NEVER MET WITH SILENCE. The
 * customer pressed a button and is watching the screen, so every path through
 * onPick sends exactly one thing back, whether that is the order confirmation
 * they were waiting for, a repeat of it in the new language, or the one line
 * receipt.
 */
import { log, maskPhone, metric } from '../log.mjs';
import { setLang, getLang } from '../store/phoneProfile.mjs';
import { getState } from '../store/orderState.mjs';
import { sess, getNormByName } from './send.mjs';
import { normalizeLang, LANGS } from '../../messages/lang.mjs';
import { soft } from '../lib/resilience.mjs';
import * as flowA from './flowA.run.mjs';

const nowOf = (deps) => deps.now || new Date();

/** 'lang_hi' -> 'hi'. Anything else is null, and null is logged and dropped. */
const langOfAction = (action) => {
  const m = /^lang_(\w+)$/.exec(String(action || ''));
  return m && LANGS.includes(m[1]) ? m[1] : null;
};

/**
 * A tap on the picker.
 *
 * Sets the language of the TAPPING PHONE and of nothing else. The order id in
 * the payload is used only to decide what to say back, and only when the
 * order's own stored phone matches this one STRICTLY: a flow L payload is
 * clear text like every other button payload, so a forged one carrying
 * somebody else's order must move that order not one inch. The worst it can do
 * is set the language of the phone that sent it, which is that phone's to set.
 */
export async function onPick(phone, action, orderId, deps) {
  const lang = langOfAction(action);
  if (!lang) return log.warn('language: unknown L tap action', { action });
  const now = nowOf(deps);

  await setLang(phone, lang, 'picker', now);
  metric('LangPicked', 1, { lang });
  log.info('language: customer chose a language', { lang, phone: maskPhone(phone) });

  const st = orderId && orderId !== 'owner' ? await getState(orderId) : null;
  /*
   * STRICT equality, and not ownsOrder's fail-open. ownsOrder lets an order it
   * has never seen through, which is right for a read and wrong here: this
   * branch runs a flow handler.
   */
  if (st && st.verifiedPhone === phone) {
    /*
     * THE CONFIRMATION IS STILL WAITING ON THIS ANSWER. Send it now, in the
     * language they just chose, and let it be the reply: a receipt followed by
     * the confirmation is two messages where one says more.
     */
    if (st.flowA?.langAskAt && !st.flowA?.codConfirmAt && !st.flowA?.codSkip) {
      await flowA.onCodTimer(String(orderId), deps);
      /*
       * Re-read, because onCodTimer may legitimately have decided NOT to send:
       * the order may have shipped or been cancelled in the five minutes the
       * picker was open. Either it sent (codConfirmAt) or it recorded a
       * decision (codSkip); if neither, the tap would otherwise go unanswered.
       */
      const after = await getState(orderId);
      if (after?.flowA?.codConfirmAt) return { replied: 'confirmation' };
    } else {
      /*
       * The confirmation already went out in the other language. Repeat it
       * once, free-form, which the tap itself has just made possible: a tap
       * opens the 24 hour window.
       */
      const done = await soft('langResendConfirm', () => flowA.resendConfirm(String(orderId), deps, lang), { orderId });
      if (done?.resent) return { replied: 'resent' };
    }
  }

  await sess(deps, phone, 'language_set', {}, { lang });
  return { replied: 'ack' };
}

/**
 * A typed keyword. Already matched by the router, so this only records it and
 * answers.
 */
export async function onKeyword(phone, lang, deps) {
  const now = nowOf(deps);
  await setLang(phone, normalizeLang(lang), 'keyword', now);
  metric('LangKeyword', 1, { lang });
  log.info('language: customer switched by keyword', { lang, phone: maskPhone(phone) });
  return sess(deps, phone, 'language_set', {}, { lang });
}

/** They typed LANGUAGE or भाषा: show the picker rather than guessing. */
export async function onShowPicker(phone, deps) {
  metric('LangPickerAsked', 1, {});
  /*
   * In the language they are CURRENTLY on, so somebody who switched by mistake
   * can read the way back. The body carries both scripts anyway.
   */
  const lang = await getLang(phone);
  return sess(deps, phone, 'language_select', { customer_name: '' }, { lang });
}

/**
 * The owner setting a customer's language by hand: /lang 1214 hi
 *
 * For the phone call that ends "just send it to me in Hindi". Sets it against
 * the ORDER'S customer, not the owner's own handset, which is the whole point
 * and also the thing to be careful about.
 */
export async function onOwnerRequest(args, deps, _ownerPhone) {
  const [order, want] = String(args || '').trim().split(/\s+/);
  if (!order || !want) return { reply: 'Use it like this: /lang 1214 hi' };
  if (!LANGS.includes(want)) return { reply: `I know ${LANGS.join(' and ')}, not ${want}.` };

  const n = await getNormByName(deps, order.replace(/^#/, ''));
  if (!n) return { reply: `I cannot find order ${order}.` };
  if (!n.verifiedPhone) return { reply: `${n.name} has no WhatsApp number I can write to.` };

  await setLang(n.verifiedPhone, want, 'owner', nowOf(deps));
  log.info('language: owner set a customer language', { order: n.name, lang: want });
  metric('LangOwnerSet', 1, { lang: want });
  return { reply: `${n.name}: I will write to this customer in ${want === 'hi' ? 'Hindi' : 'English'} from now on.`, lang: want };
}
