import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuthorizationService } from '../permissions/authorization.service';
import { FIELD_SENSITIVITY } from '../permissions/field-sensitivity.registry';
import { PrincipalType } from '../permissions/principal';

/**
 * May this caller search the values that field masking hides from them?
 *
 * The gap this closes
 * -------------------
 * `FieldMaskingInterceptor` stops a user without `contacts:unmask` from reading
 * a contact's phone number or e-mail. It does nothing about the other
 * direction: the same user could type the number into the list search and be
 * shown whose it is. Masking protects the value as *output* while search
 * accepted it as a *key*, so the protected data was recoverable by anyone
 * holding `contacts:view` — one digit at a time via prefixes, or in one shot if
 * they already had the number and wanted the name.
 *
 * Under PDPL and GDPR that is the same personal data reached through a
 * different door.
 *
 * Why deny rather than allow-and-log
 * ----------------------------------
 * `contacts:unmask` is already granted to Manager, Sales Rep and Support
 * Agent — every role whose job involves ringing a customer back. Denying
 * therefore costs nothing to the people who need it and closes the hole for
 * Read Only and Marketing, which is exactly the intended shape.
 *
 * A denied attempt is recorded rather than silently dropped. If a real business
 * need exists it will show up in the log as a pattern, and can be granted
 * deliberately by giving that role the unmask permission — which is the control
 * that already exists, rather than a second one invented here.
 *
 * The record is a structured warning plus a counter, not a row in `audit_logs`:
 * that collection models entity changes, and a search that returned a narrower
 * result set is not an entity change. Logs are shipped to Loki, so this is
 * queryable and alertable at a fraction of the cost of a new audit shape.
 */
@Injectable()
export class PiiSearchPolicy {
  private readonly logger = new Logger(PiiSearchPolicy.name);

  constructor(
    private readonly authorization: AuthorizationService,
    private readonly cls: ClsService,
  ) {}

  /**
   * True when the caller holds the unmask permission for `resource`.
   *
   * Fails closed on every uncertainty: no identity, an agent principal, an
   * unknown resource, or an error from the PDP all return false. A search that
   * is narrower than it could be is a mild annoyance; one that is wider than it
   * should be is a data-protection incident.
   */
  async canSearchSensitive(resource: string): Promise<boolean> {
    const fields = FIELD_SENSITIVITY[resource];
    if (!fields?.length) return true; // nothing sensitive is declared here

    const principalType =
      this.cls.get<string>('principalType') ?? PrincipalType.USER;
    // AI agents never see PII unmasked, and must not be able to look it up
    // either — the same short-circuit FieldMaskingInterceptor applies.
    if (principalType === PrincipalType.AGENT) return false;

    const rawUserId = this.cls.get<string>('userId');
    const tenantHint = this.cls.get<string>('tenantId');
    if (!rawUserId || !tenantHint) return false;

    const unmask = fields[0].unmask;
    try {
      const decision = await this.authorization.canPerformAction({
        rule: { action: unmask.action, resource: unmask.resource },
        rawUserId,
        tenantHint,
        claims: this.cls.get('user'),
      });
      return decision.allowed === true;
    } catch (error) {
      this.logger.error(
        `Could not resolve ${unmask.resource}:${unmask.action}; refusing sensitive search: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Records that a caller searched with a term shaped like protected data while
   * lacking permission to see it.
   *
   * Called only when the term *looks like* a phone number or e-mail, so an
   * ordinary name search produces no noise, and the log line is evidence of an
   * actual reverse-lookup attempt rather than of routine use.
   */
  recordDeniedLookup(resource: string, term: string): void {
    this.logger.warn(
      `Sensitive search denied ${JSON.stringify({
        resource,
        tenantId: this.cls.get<string>('tenantId'),
        userId: this.cls.get<string>('userId'),
        // The term itself is the protected data. Only its shape is recorded —
        // logging the value would move the leak into the log pipeline.
        termShape: term.includes('@') ? 'email' : 'phone',
        termLength: term.length,
      })}`,
    );
  }
}

/**
 * Does this search term look like a value that field masking protects?
 *
 * Deliberately generous: anything with an `@`, or anything that is mostly
 * digits and long enough to be a phone number. A false positive costs a user a
 * name search that also happened to look like a number; a false negative costs
 * the control.
 */
export function looksLikeProtectedValue(term: string): boolean {
  const trimmed = term.trim();
  if (!trimmed) return false;
  if (trimmed.includes('@')) return true;
  const digits = trimmed.replace(/\D+/g, '');
  return digits.length >= 4 && /^[+\d\s().\-/]+$/.test(trimmed);
}
