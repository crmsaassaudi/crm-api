import { Contact } from '../domain/contact';

/**
 * Field-level survivorship for a contact merge.
 *
 * The previous merge kept the survivor's scalars and silently threw the loser's
 * away. That is wrong in the common case: agents merge a rich shadow contact
 * created from a conversation into a sparse manually-created one, so "survivor
 * wins" discards precisely the data they were trying to keep. It is also
 * invisible — nothing recorded what was dropped.
 *
 * The rules below are deliberately simple and explainable, because a merge is
 * something a user has to be able to predict:
 *
 *   - identity arrays (emails, phones, omniIdentities, tags): UNION. Never lose
 *     a way to reach someone.
 *   - scalars: survivor wins IF it has a value; otherwise fill from the loser.
 *     "Fill the blanks" is what people expect and it is never destructive.
 *   - customFields: per-key fill-the-blanks, same rule one level down.
 *   - booleans that restrict contact (doNotCall): OR — the stricter value wins.
 *     Consent flags (emailOptIn/smsOptIn): AND — a merge must never manufacture
 *     consent the person did not give for both records.
 *   - score / lastActivityAt: MAX. Recency and engagement are monotonic.
 *   - stageHistory: concatenate, sorted by time — one continuous history.
 *   - explicit overrides let the UI offer a per-field picker without changing
 *     this logic.
 *
 * Every decision is reported back so the merge ledger can store it.
 */

/** Arrays whose values are set-unioned rather than chosen between. */
const UNION_ARRAY_FIELDS = ['emails', 'phones', 'tags'] as const;

/** Scalars filled from the loser when the survivor has no value. */
const FILL_SCALAR_FIELDS = [
  'firstName',
  'lastName',
  'companyName',
  'accountId',
  'title',
  'sourceId',
  'role',
  'address',
  'birthday',
  'ownerId',
  'orgUnitId',
  'lifecycleStageId',
  'statusId',
  'linkedinUrl',
  'twitterUrl',
  'instagramUrl',
  'tiktokUrl',
  'youtubeUrl',
  'githubUrl',
] as const;

export type FieldChoice = {
  chosen: unknown;
  from: 'survivor' | 'merged';
  discarded?: unknown;
};

export interface SurvivorshipResult {
  /** The `$set` payload to apply to the survivor. */
  update: Record<string, any>;
  /** Per-field decisions, for the merge ledger and the UI preview. */
  choices: Record<string, FieldChoice>;
}

export interface SurvivorshipOptions {
  /**
   * Explicit per-field winners chosen by the user in the merge dialog:
   * `{ firstName: 'merged' }` takes the loser's value even though the survivor
   * has one. Only applies to scalar fields — identity arrays always union,
   * because "choose one" there means deliberately discarding a phone number.
   */
  fieldWinners?: Record<string, 'survivor' | 'merged'>;
}

export function resolveSurvivorship(
  survivor: Contact,
  merged: Contact,
  options: SurvivorshipOptions = {},
): SurvivorshipResult {
  const update: Record<string, any> = {};
  const choices: Record<string, FieldChoice> = {};

  // Identity arrays: union, never choose
  for (const field of UNION_ARRAY_FIELDS) {
    const left = (survivor as any)[field] ?? [];
    const right = (merged as any)[field] ?? [];
    const union = Array.from(
      new Set([...left, ...right].filter((v) => v !== null && v !== '')),
    );
    if (union.length !== left.length || union.some((v, i) => v !== left[i])) {
      update[field] = union;
    }
    choices[field] = { chosen: union, from: 'survivor' };
  }

  // omniIdentities is an array of objects — dedupe by composite key.
  const identityKey = (i: { channelType: string; senderId: string }) =>
    `${i.channelType}:${i.senderId}`;
  const seenIdentities = new Set<string>();
  const omniIdentities = [
    ...(survivor.omniIdentities ?? []),
    ...(merged.omniIdentities ?? []),
  ].filter((identity) => {
    const key = identityKey(identity);
    if (seenIdentities.has(key)) return false;
    seenIdentities.add(key);
    return true;
  });
  update.omniIdentities = omniIdentities;
  choices.omniIdentities = { chosen: omniIdentities, from: 'survivor' };

  // Scalars: explicit winner, else fill the blanks
  for (const field of FILL_SCALAR_FIELDS) {
    const survivorValue = (survivor as any)[field];
    const mergedValue = (merged as any)[field];
    const winner = options.fieldWinners?.[field];

    if (winner === 'merged' && !isEmpty(mergedValue)) {
      update[field] = mergedValue;
      choices[field] = {
        chosen: mergedValue,
        from: 'merged',
        ...(isEmpty(survivorValue) ? {} : { discarded: survivorValue }),
      };
      continue;
    }

    if (isEmpty(survivorValue) && !isEmpty(mergedValue)) {
      update[field] = mergedValue;
      choices[field] = { chosen: mergedValue, from: 'merged' };
      continue;
    }

    if (!isEmpty(survivorValue)) {
      choices[field] = {
        chosen: survivorValue,
        from: 'survivor',
        ...(isEmpty(mergedValue) || mergedValue === survivorValue
          ? {}
          : { discarded: mergedValue }),
      };
    }
  }

  // customFields: fill the blanks per key
  const customFields = { ...(merged.customFields ?? {}) };
  for (const [key, value] of Object.entries(survivor.customFields ?? {})) {
    if (!isEmpty(value)) customFields[key] = value;
  }
  if (Object.keys(customFields).length > 0) {
    update.customFields = customFields;
    choices.customFields = { chosen: customFields, from: 'survivor' };
  }

  // Consent: never widen it
  // A merge is a data-cleanup operation; it must not be able to create
  // permission to contact someone that neither source record carried.
  applyBooleanRule(update, choices, 'emailOptIn', survivor, merged, 'and');
  applyBooleanRule(update, choices, 'smsOptIn', survivor, merged, 'and');
  // ...and never narrow a restriction.
  applyBooleanRule(update, choices, 'doNotCall', survivor, merged, 'or');

  // Monotonic numerics
  const score = Math.max(survivor.score ?? 0, merged.score ?? 0);
  update.score = score;
  choices.score = { chosen: score, from: 'survivor' };

  const lastActivityAt = latestDate(
    survivor.lastActivityAt,
    merged.lastActivityAt,
  );
  if (lastActivityAt) update.lastActivityAt = lastActivityAt;

  // A merge of two shadow contacts stays shadow; merging in anything real
  // promotes the survivor, matching the promotion rule in ContactsService.
  const isShadow = Boolean(survivor.isShadow) && Boolean(merged.isShadow);
  update.isShadow = isShadow;
  choices.isShadow = { chosen: isShadow, from: 'survivor' };

  // VIP is a routing privilege — if either record had it, keep it.
  const isVIP = Boolean(survivor.isVIP) || Boolean(merged.isVIP);
  update.isVIP = isVIP;
  choices.isVIP = { chosen: isVIP, from: 'survivor' };

  // One continuous stage history
  const stageHistory = [
    ...(survivor.stageHistory ?? []),
    ...(merged.stageHistory ?? []),
  ].sort(
    (a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime(),
  );
  update.stageHistory = stageHistory;

  return { update, choices };
}

function applyBooleanRule(
  update: Record<string, any>,
  choices: Record<string, FieldChoice>,
  field: 'emailOptIn' | 'smsOptIn' | 'doNotCall',
  survivor: Contact,
  merged: Contact,
  rule: 'and' | 'or',
): void {
  const left = Boolean(survivor[field]);
  const right = Boolean(merged[field]);
  const value = rule === 'and' ? left && right : left || right;
  update[field] = value;
  choices[field] = {
    chosen: value,
    from: value === left ? 'survivor' : 'merged',
    ...(left === right ? {} : { discarded: value === left ? right : left }),
  };
}

function latestDate(a?: Date, b?: Date): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
