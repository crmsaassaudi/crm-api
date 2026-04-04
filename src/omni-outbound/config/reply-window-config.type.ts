/**
 * Platform reply window durations (in hours).
 *
 * Each messaging platform enforces a window after the customer's last message
 * during which free-form replies are allowed. After the window expires,
 * only template/ZNS messages can be sent.
 *
 * A value of 0 means unlimited (no window restriction, e.g. LiveChat).
 */
export interface ReplyWindowConfig {
  facebook: number;
  zalo: number;
  whatsapp: number;
  instagram: number;
  livechat: number;
}
