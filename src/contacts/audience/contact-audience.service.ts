import { Injectable } from '@nestjs/common';
import { FilterQuery } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { buildVisibilityClauses } from '../../common/permissions/visibility-scope';
import { ContactSegmentsService } from '../segments/contact-segments.service';
import {
  AudienceDefinition,
  AudienceSource,
  assertAudienceShape,
} from './audience-definition';

/**
 * Turns an `AudienceDefinition` into the Mongo predicate that selects it.
 *
 * The single owner of "which contacts does this audience mean". Segments, the
 * contact list and campaigns all arrive here, so a saved segment used inside a
 * campaign resolves through exactly the same code path as the same segment
 * opened on the contact list.
 */
@Injectable()
export class ContactAudienceService {
  constructor(
    private readonly segments: ContactSegmentsService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Compile a definition, intersected with what the caller is allowed to read.
   *
   * The visibility clause is applied HERE rather than left to the caller. Reading
   * contacts through the Mongoose model gets the tenant filter from
   * `tenantFilterPlugin` but nothing else — row-level visibility lives in
   * `buildVisibilityClauses` and is applied by the repository layer, which an
   * audience walk deliberately bypasses for the sake of a cursor. Without this
   * line a rep whose scope is "own records" would broadcast to the whole tenant:
   * messaging a contact you are not allowed to open is a disclosure, not a
   * feature.
   *
   * Soft-deleted contacts are excluded here too, because the filter compiler
   * knows nothing about `deletedAt` — an audience built on it would otherwise
   * include the recycle bin.
   */
  async buildFilter(
    definition: AudienceDefinition,
  ): Promise<FilterQuery<Record<string, unknown>>> {
    assertAudienceShape(definition);

    const [include, exclude] = await Promise.all([
      Promise.all(definition.include.map((source) => this.compile(source))),
      Promise.all(
        (definition.exclude ?? []).map((source) => this.compile(source)),
      ),
    ]);

    const clauses: FilterQuery<Record<string, unknown>>[] = [
      { deletedAt: null },
      include.length === 1 ? include[0] : { $or: include },
    ];

    // `$nor` rather than `$not` per source: "in none of these" is one clause the
    // planner can reason about, and it stays correct when a source is a static
    // segment whose membership is an id list.
    if (exclude.length) clauses.push({ $nor: exclude });

    const visibility = buildVisibilityClauses(this.cls, 'Contact');
    if (visibility) clauses.push(...visibility);

    return { $and: clauses };
  }

  /**
   * The predicate a launched run should keep using, whatever happens next.
   *
   * A campaign that has started must reach the audience it was launched against.
   * Freezing the compiled predicate — rather than re-resolving the definition
   * when the worker gets to it — means an edited segment cannot change an
   * in-flight send, and a deleted one cannot break it.
   */
  async freeze(
    definition: AudienceDefinition,
  ): Promise<FilterQuery<Record<string, unknown>>> {
    return this.buildFilter(definition);
  }

  private async compile(
    source: AudienceSource,
  ): Promise<FilterQuery<Record<string, unknown>>> {
    return source.type === 'segment'
      ? this.segments.buildMembershipFilter(String(source.segmentId))
      : this.segments.compileDraft(source.filter!);
  }
}
