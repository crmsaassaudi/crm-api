import * as crypto from 'crypto';
import { ConflictException, Logger } from '@nestjs/common';
import { TenantAliasReservationRepository } from '../infrastructure/persistence/document/repositories/tenant-alias-reservation.repository';

const logger = new Logger('AliasGenerator');

/**
 * Generates a URL-safe alias from a company name.
 *
 * Handles Vietnamese characters (Đ/đ), diacritics, and special chars.
 * Output: lowercase alphanumeric + hyphens, 3–50 chars.
 *
 * @example generateAlias("Đại Phát Corp") → "dai-phat-corp"
 * @example generateAlias("Toan  Corp!!") → "toan-corp"
 */
export function generateAlias(companyName: string): string {
  // Step 1: Replace Vietnamese Đ/đ before NFD normalization (NFD cannot decompose them)
  let alias = companyName.replace(/Đ/g, 'D').replace(/đ/g, 'd');

  // Step 2: NFD normalize + strip diacritical marks (e.g. à → a)
  alias = alias
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // Step 3: Keep only a-z, 0-9, spaces, and hyphens
  alias = alias.replace(/[^a-z0-9\s-]/g, '');

  // Step 4: Trim, collapse whitespace/hyphens
  alias = alias.trim().replace(/\s+/g, '-').replace(/-+/g, '-');

  // Step 5: Ensure starts/ends with alphanumeric
  alias = alias.replace(/(?:^-+)|(?:-+$)/g, '');

  // Step 6: Enforce length constraints
  alias = alias.slice(0, 50);
  if (alias.length < 3) {
    alias = `org-${alias || crypto.randomBytes(2).toString('hex')}`;
  }

  return alias;
}

/**
 * Attempts to reserve a unique alias, appending a random 4-char hex
 * suffix on conflict (up to 5 retries).
 *
 * @example "toan-corp" → (conflict) → "toan-corp-a1b2"
 */
export async function ensureUniqueAlias(
  base: string,
  aliasReservationRepository: TenantAliasReservationRepository,
): Promise<string> {
  let alias = base;
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    try {
      await aliasReservationRepository.reserve(alias);
      logger.log(`Alias "${alias}" reserved successfully`);
      return alias;
    } catch (e) {
      if (e instanceof ConflictException) {
        attempts++;
        const suffix = crypto.randomBytes(2).toString('hex');
        alias = `${base.slice(0, 45)}-${suffix}`;
        logger.warn(
          `Alias conflict, retrying with "${alias}" (attempt ${attempts}/${maxAttempts})`,
        );
      } else {
        throw e;
      }
    }
  }

  throw new ConflictException(
    `Could not generate a unique alias after ${maxAttempts} attempts`,
  );
}
