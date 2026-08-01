/**
 * Recognise a search term that is unambiguously a ticket number, and return it
 * in the stored form.
 *
 * `TicketRepository.generateTicketNumber` mints `TKT-00001` (a per-tenant
 * counter, zero-padded to five) and the import worker mints `TKT-<8 chars of a
 * ULID>`. Both are `TKT-` followed by an alphanumeric run, so that is the only
 * shape accepted here.
 *
 * Accepted, because these are what a human actually types:
 *   `TKT-00042`, `tkt-00042`, ` TKT-00042 `, `#TKT-00042`, `00042`, `42`
 *
 * Rejected, so free text keeps going to the regex branch:
 *   `TKT`, `TKT-`, `payment failed`, `TKT-00042 refund`
 *
 * Returns null when the term is not a ticket number — the signal to fall back
 * to text search rather than answer with an exact match that would find
 * nothing.
 */
export function normalizeTicketNumberQuery(search: string): string | null {
  const term = search.trim().replace(/^#/, '');
  if (!term) return null;

  const prefixed = /^TKT-([A-Za-z0-9]+)$/i.exec(term);
  if (prefixed) return `TKT-${prefixed[1].toUpperCase()}`;

  // A bare number: the counter form without its prefix. Padded to the width the
  // generator uses, so `42` finds `TKT-00042`.
  //
  // Only digits qualify. A bare alphanumeric run would collide with ordinary
  // words — searching "refund" must not become a ticket-number lookup — and the
  // ULID form is never typed from memory anyway.
  if (/^\d{1,5}$/.test(term)) {
    return `TKT-${term.padStart(5, '0')}`;
  }

  // Longer digit runs cannot be the padded counter form. They are far more
  // likely a phone number or an order reference pasted into the wrong box, so
  // let text search answer and return nothing rather than assert a match.
  return null;
}
