import { BadRequestException } from '@nestjs/common';
import { DEFAULTS_MAP } from './tenant-settings-seeding.service';

/**
 * The keys `crm_settings` recognises.
 *
 * `PATCH /crm-settings/:key` accepted any key at all, which had two consequences.
 * The small one: a tenant could grow unlimited documents nothing reads, because a
 * typo created a key rather than failing. The one that mattered: a typo in a
 * settings screen — `layout_setting`, `validation_rule` — saved successfully,
 * returned 200, and configured nothing. The screen said the change was applied and
 * every reader kept using the untouched key.
 *
 * `DEFAULTS_MAP` is already the list of every key the product seeds and reads, so it
 * is the allowlist rather than a second list that would drift from it. A new module
 * adds its key there and works everywhere; forgetting to is now a clear 400 instead
 * of a silent no-op.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULTS_MAP));

/**
 * Keys read and written by a module that owns its own default, so they never appear
 * in `DEFAULTS_MAP`.
 *
 * Listed explicitly, with the owner named, so the exception is auditable rather
 * than a hole in the check.
 */
const MODULE_OWNED_KEYS: ReadonlySet<string> = new Set<string>([
  // AgentFallbackService reacts to 'settings.changed' for this key.
  'omni_agent_fallback',
]);

export const isKnownSettingKey = (key: string): boolean =>
  KNOWN_KEYS.has(key) || MODULE_OWNED_KEYS.has(key);

export const assertKnownSettingKey = (key: string): void => {
  if (isKnownSettingKey(key)) return;
  throw new BadRequestException(
    `Unknown setting key "${key}". A settings key must be declared in DEFAULTS_MAP so every reader agrees it exists.`,
  );
};

/** Exposed for the guard test that keeps the allowlist honest. */
export const knownSettingKeys = (): string[] => [...KNOWN_KEYS].sort();
