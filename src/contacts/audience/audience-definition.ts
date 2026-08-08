import { BadRequestException } from '@nestjs/common';
import { FilterGroup } from '../filters/contact-filter';

/**
 * Who a piece of outbound work is addressed to.
 *
 * One vocabulary, shared by everything that needs an audience, so there is
 * exactly one answer to "which contacts does this mean". A saved segment is a
 * named `AudienceDefinition`; a campaign carries an unnamed one. Both compile
 * through `compileContactFilter`, so a condition can never mean one thing in the
 * contact list and another in a send.
 */

export const AUDIENCE_SOURCE_TYPES = ['segment', 'filter'] as const;
export type AudienceSourceType = (typeof AUDIENCE_SOURCE_TYPES)[number];

export interface AudienceSource {
  type: AudienceSourceType;
  /** Set when `type` is `segment`. */
  segmentId?: string;
  /** Set when `type` is `filter` — a condition tree written in place. */
  filter?: FilterGroup;
}

export interface AudienceDefinition {
  /** Unioned: a contact matching any include source is in the audience. */
  include: AudienceSource[];
  /**
   * Subtracted: a contact matching any exclude source is out, whatever else
   * said. Optional on the wire, always an array once stored.
   */
  exclude?: AudienceSource[];
}

/**
 * How many sources one side may carry.
 *
 * Each source is an independent predicate the planner has to evaluate, and a
 * union of twenty segments is a request-shaped way to build a query that scans
 * the collection twenty times.
 */
export const MAX_AUDIENCE_SOURCES = 10;

export const emptyAudience = (): AudienceDefinition => ({
  include: [],
  exclude: [],
});

export function isAudienceEmpty(
  definition?: AudienceDefinition | null,
): boolean {
  return !definition?.include?.length;
}

/**
 * Reject a definition that cannot be resolved, before anything tries.
 *
 * Shape only — whether a field is filterable and whether an operator suits its
 * type is the compiler's decision, and duplicating those rules here is how the
 * two drift apart.
 */
export function assertAudienceShape(
  definition: AudienceDefinition | undefined | null,
): asserts definition is AudienceDefinition {
  if (!definition || typeof definition !== 'object') {
    throw new BadRequestException('An audience is required.');
  }

  const { include, exclude } = definition;

  if (!Array.isArray(include) || include.length === 0) {
    throw new BadRequestException(
      'An audience needs at least one source to send to.',
    );
  }
  if (exclude !== undefined && !Array.isArray(exclude)) {
    throw new BadRequestException('Audience exclusions must be a list.');
  }

  assertSources(include, 'include');
  assertSources(exclude ?? [], 'exclude');
}

function assertSources(sources: AudienceSource[], side: string): void {
  if (sources.length > MAX_AUDIENCE_SOURCES) {
    throw new BadRequestException(
      `An audience cannot ${side} more than ${MAX_AUDIENCE_SOURCES} sources.`,
    );
  }

  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      throw new BadRequestException('Each audience source must be an object.');
    }
    if (source.type === 'segment') {
      if (!source.segmentId) {
        throw new BadRequestException('A segment source needs a segment.');
      }
      continue;
    }
    if (source.type === 'filter') {
      // An empty condition tree compiles to "match nothing" for an include and
      // "exclude nothing" for an exclude — both silently useless, so they are
      // refused where the author can still see why.
      if (!source.filter?.conditions?.length) {
        throw new BadRequestException(
          'A filter source needs at least one condition.',
        );
      }
      continue;
    }
    throw new BadRequestException(
      `Unsupported audience source "${String((source as AudienceSource).type)}".`,
    );
  }
}
