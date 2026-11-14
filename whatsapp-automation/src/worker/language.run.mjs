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
import { setLang, getLang, langState, claimLangAsk, releaseLangAsk, langPilotAllows } from '../store/phoneProfile.mjs';
import { getState } from '../store/orderState.mjs';
import { RULES } from '../../messages/rules.mjs';
import { sess, getNormByName } from './send.mjs';
import { normalizeLang, LANGS, langName, DEFAULT_LANG } from '../../messages/lang.mjs';
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

  const st = orderId && orderId !== 'owner' && orderId !== 'picker' ? await getState(orderId) : null;
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

  /*
   * soft, and this is the last thing that happens.
   *
   * Branch 1 above sets codConfirmAt. If this receipt then threw, the SQS
   * record would be redelivered, the condition that selected branch 1 would
   * now be false, and the customer would get a reminder on top of the
   * confirmation they already had. The receipt is the least important message
   * in this handler and must not be able to cause a second one.
   */
  await soft('languageSetAck', () => sess(deps, phone, 'language_set', {}, { lang }), {});
  return { replied: 'ack' };
}

/*
 * PLAN B: the picker as a free-form message, after they tap something else.
 *
 * Reached only when RULES.language.askMode is 'session', which is what gate G2
 * switches to if Meta rejects the picker TEMPLATE or classifies it MARKETING.
 * Then there is no template to send at the confirmation moment, and the
 * confirmation is never delayed at all; instead the question goes out the first
 * time the customer taps anything on an order message, which is the first
 * moment a 24 hour window is open and a free-form message can reach them.
 *
 * ONCE PER PHONE, ever, and claimed through the same counter the template
 * route uses, so maxAsks means the same thing on both.
 *
 * soft at the call site: this is an extra question asked after the customer has
 * already been answered. It must never cost them the reply they tapped for.
 */
export async function offerPickerAfterTap(phone, deps) {
  const L = RULES.language || {};
  if (!L.enabled || L.askMode !== 'session') return null;
  if (!langPilotAllows(phone)) return null;

  const ls = await langState(phone);
  if (ls.chosen) return null;
  // Asked before, on either route. One question, not one per tap.
  if (ls.askedAt || ls.askCount >= (L.maxAsks ?? 2)) return null;

  /*
   * Claimed before sending, for the same reason the template route claims it:
   * a customer with two open orders can tap a button on each within a second,
   * and two taps are two message groups running in parallel.
   */
  const now = nowOf(deps);
  const claim = await claimLangAsk(phone, now, (L.waitMinutes ?? 5) * 60 * 1000, L.maxAsks ?? 2);
  if (!claim.claimed) return null;

  /*
   * orderId: 'picker', a literal, for the same reason ownerSend passes
   * 'owner'. Without it encodePayload writes the string "undefined" into both
   * button ids and onPick then reads the state of an order called "undefined".
   */
  const r = await sess(deps, phone, 'language_select', { customer_name: langName(DEFAULT_LANG, null) }, { orderId: 'picker' });
  // A skipped send is not a send, so the claim goes back and the question is
  // still owed once the gate that skipped it lifts.
  if (!r) {
    await releaseLangAsk(phone, claim.prev);
    return null;
  }
  metric('LangAskedSession', 1, {});
  log.info('language: asked which language after their first tap', { phone: maskPhone(phone) });
  return r;
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
  /*
   * No order in hand here, so no name either: this came from somebody typing
   * LANGUAGE, not from a flow. langName gives the greeting we use when a name
   * is missing, which is the same one every other message uses, rather than
   * leaving "Hello ," with a hole in it.
   */
  return sess(deps, phone, 'language_select', { customer_name: langName(lang, null) }, { lang, orderId: 'picker' });
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
  /*
   * Say so rather than promising it. langFor returns English while the feature
   * is off, so setting a language here would reply "I will write to this
   * customer in Hindi from now on" and then not.
   */
  if (!RULES.language?.enabled) {
    return { reply: 'Languages are switched off right now, so everyone gets English. Turn on RULES.language.enabled first.' };
  }
  if (!LANGS.includes(want)) return { reply: `I know ${LANGS.join(' and ')}, not ${want}.` };

  const n = await getNormByName(deps, order.replace(/^#/, ''));
  if (!n) return { reply: `I cannot find order ${order}.` };
  if (!n.verifiedPhone) return { reply: `${n.name} has no WhatsApp number I can write to.` };

  await setLang(n.verifiedPhone, want, 'owner', nowOf(deps));
  log.info('language: owner set a customer language', { order: n.name, lang: want });
  metric('LangOwnerSet', 1, { lang: want });
  return { reply: `${n.name}: I will write to this customer in ${want === 'hi' ? 'Hindi' : 'English'} from now on.`, lang: want };
}
