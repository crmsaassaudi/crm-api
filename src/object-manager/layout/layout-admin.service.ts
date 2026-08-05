import { BadRequestException, Injectable } from '@nestjs/common';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { ConfigurableObject } from '../object-registry';
import { ObjectRegistryService } from '../object-registry.service';
import { LAYOUT_SETTINGS_KEY } from './layout-settings.service';
import {
  ACCESS_LEVELS,
  AccessLevel,
  DEFAULT_LAYOUT_GROUP,
  MASKING_STRATEGIES,
  MaskingStrategy,
  StoredFieldConfig,
} from './field-policy';

/** One field's configuration as submitted by the settings screen. */
export interface LayoutFieldInput {
  key: string;
  isVisible?: boolean;
  isRequired?: boolean;
  accessLevel?: AccessLevel;
  masking?: MaskingStrategy;
  section?: string;
  sortOrder?: number;
  visibleAtStages?: string[];
}

/**
 * The write side of the layout configuration.
 *
 * Separate from `LayoutSettingsService`, which only reads and resolves: the read
 * path runs on every response and should not carry validation code it never
 * executes.
 *
 * Two things happen here that did not happen before:
 *
 *   1. The write is scoped. `PATCH /crm-settings/layout_settings` replaced the whole
 *      document from a snapshot the browser took at mount, so two admins editing
 *      different objects overwrote each other with no warning. This sets one dotted
 *      path.
 *   2. The configuration is validated. Marking a server-owned field required is the
 *      bug that made every ticket create return 422 with no remedy, and offering
 *      masking on a number produced a setting that saved and did nothing. Both are
 *      refused at the edge, with a message naming the field.
 */
@Injectable()
export class LayoutAdminService {
  constructor(
    private readonly settings: CrmSettingsService,
    private readonly registry: ObjectRegistryService,
  ) {}

  async replaceObjectLayout(
    groupId: string,
    object: ConfigurableObject,
    fields: LayoutFieldInput[],
  ): Promise<StoredFieldConfig[]> {
    const normalised = this.normalise(object, fields);

    await this.settings.replaceLayoutFields(
      LAYOUT_SETTINGS_KEY,
      this.assertGroupId(groupId),
      object,
      normalised,
    );

    return normalised;
  }

  async replaceSections(sections: unknown): Promise<void> {
    await this.settings.replaceLayoutSections(LAYOUT_SETTINGS_KEY, sections);
  }

  /**
   * Reject configurations the enforcement layer would ignore or could not satisfy,
   * and store every entry under its payload key.
   *
   * Storing the resolved key is what stops the document accumulating two spellings
   * of the same field: the registry accepts legacy names on read so old documents
   * keep working, but nothing new should add to the set of names a future reader has
   * to know about.
   */
  private normalise(
    object: ConfigurableObject,
    fields: LayoutFieldInput[],
  ): StoredFieldConfig[] {
    const seen = new Set<string>();
    const result: StoredFieldConfig[] = [];

    for (const input of fields) {
      const field = this.registry.resolveFieldKey(object, input.key);

      // Custom fields are not in the registry; they are configured by their own
      // `internalKey`, which is already the payload key.
      const key = field?.key ?? input.key;

      if (seen.has(key)) {
        throw new BadRequestException(
          `Field "${key}" appears twice in the ${object} layout. Two entries for one field make the merge order decide the policy.`,
        );
      }
      seen.add(key);

      if (input.accessLevel && !ACCESS_LEVELS.includes(input.accessLevel)) {
        throw new BadRequestException(
          `accessLevel for "${key}" must be one of ${ACCESS_LEVELS.join(', ')}`,
        );
      }

      if (input.masking && !MASKING_STRATEGIES.includes(input.masking)) {
        throw new BadRequestException(
          `masking for "${key}" must be one of ${MASKING_STRATEGIES.join(', ')}`,
        );
      }

      if (input.isRequired && field && (field.readOnly || field.audit)) {
        throw new BadRequestException(
          `"${key}" is set by the server, so it cannot be required — a required check on it is a 422 no user can clear.`,
        );
      }

      if (
        input.masking &&
        input.masking !== 'none' &&
        field?.maskable === false
      ) {
        throw new BadRequestException(
          `"${key}" cannot be masked: it is the record's primary label, and masking it makes every list unreadable without protecting anything the record permission does not already cover.`,
        );
      }

      result.push({
        key,
        ...(input.isVisible !== undefined
          ? { isVisible: input.isVisible }
          : {}),
        ...(input.isRequired !== undefined
          ? { isRequired: input.isRequired }
          : {}),
        ...(input.accessLevel ? { accessLevel: input.accessLevel } : {}),
        ...(input.masking ? { masking: input.masking } : {}),
        ...(input.section ? { section: input.section } : {}),
        ...(input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : {}),
        ...(input.visibleAtStages
          ? { visibleAtStages: input.visibleAtStages }
          : {}),
      });
    }

    return result;
  }

  /**
   * A group id becomes a Mongo path segment, so it has to be a plain token.
   *
   * `$set` with a dotted path built from user input is how a write to
   * `groupLayouts.a.b.c` — or worse, a sibling of `groupLayouts` — gets smuggled in.
   */
  private assertGroupId(groupId: string): string {
    const candidate = groupId?.trim();
    if (!candidate) return DEFAULT_LAYOUT_GROUP;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(candidate)) {
      throw new BadRequestException(
        'groupId must be up to 64 letters, digits, dashes or underscores',
      );
    }
    return candidate;
  }
}
