/* maps.mjs — AWB#/PAYLINK#/PAYTOKEN# lookup rows -> orderId (+ small payloads). */
import { table } from './table.mjs';

const put = (pk, data) => table.put({ PK: pk, SK: 'MAP', ...data });
const get = (pk) => table.get(pk, 'MAP');

export const setAwbMap = (awb, orderId) => put(`AWB#${awb}`, { orderId, activeShipment: awb });
export const getAwbMap = (awb) => get(`AWB#${awb}`);

export const setPaylinkMap = (linkId, orderId) => put(`PAYLINK#${linkId}`, { orderId });
export const getPaylinkMap = (linkId) => get(`PAYLINK#${linkId}`);

export const setPayTokenMap = (token, data) => put(`PAYTOKEN#${token}`, data); // { orderId, url, expiresAt }
export const getPayTokenMap = (token) => get(`PAYTOKEN#${token}`);

// A delivery status webhook carries only the wamid. Without this row there is
// no way back to the order, so a message Meta accepted and then failed to
// deliver was invisible per-order: the log said a phone number and a code.
export const setWamidMap = (wamid, data) => put(`WAMID#${wamid}`, data); // { orderId, key }
export const getWamidMap = (wamid) => get(`WAMID#${wamid}`);
