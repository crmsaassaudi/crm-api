import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../common/plugins/tenant-filter.plugin';

export type AssignmentSkillDocument =
  HydratedDocument<AssignmentSkillSchemaClass>;

/**
 * The skill catalogue — the one vocabulary for skill-based routing.
 *
 * Before consolidation the catalogue existed but only the record engine used
 * it, while the omni rule editor accepted free text. Both wrote into the same
 * `user.skills` array, so a rule requiring `Tiếng Anh` never matched a user
 * tagged `english`, and the mismatch fell through to "no skilled agent → use
 * the whole pool" without surfacing anywhere.
 *
 * `apiName` is the stored form: `user.skills` holds apiNames, rules hold
 * apiNames, and `name` is display-only.
 */
@Schema({
  timestamps: true,
  collection: 'assignment_skills',
  toJSON: { virtuals: true, getters: true },
})
export class AssignmentSkillSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, trim: true })
  name: string;

  /** Slug used everywhere machine-readable. Immutable once created. */
  @Prop({ required: true, lowercase: true, trim: true })
  apiName: string;

  @Prop({ type: String, default: null })
  category?: string | null;

  @Prop({ type: String, default: null })
  description?: string | null;
}

export const AssignmentSkillSchema = SchemaFactory.createForClass(
  AssignmentSkillSchemaClass,
);

AssignmentSkillSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AssignmentSkillSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
AssignmentSkillSchema.index({ tenantId: 1, category: 1, name: 1 });

/**
 * Strip the combining marks NFD leaves behind, and map the one Vietnamese
 * letter NFD does not decompose.
 *
 * Written as an explicit code-point scan rather than a regex character class:
 * a class containing combining marks is both unreadable in source and flagged
 * as a misleading character class by lint.
 */
function stripDiacritics(value: string): string {
  let out = '';
  for (const ch of value.normalize('NFD')) {
    const code = ch.codePointAt(0) ?? 0;
    // U+0300..U+036F — combining diacritical marks.
    if (code >= 0x300 && code <= 0x36f) continue;
    // U+0111 LATIN SMALL LETTER D WITH STROKE.
    out += code === 0x111 ? 'd' : ch;
  }
  return out;
}

/**
 * Derive the canonical apiName for a display name.
 *
 * Diacritics are decomposed and removed rather than filtered out, so
 * "Tieng Anh" with accents becomes `tieng_anh` instead of losing every
 * accented character to the final `[^a-z0-9_]` pass.
 */
export function toSkillApiName(name: string): string {
  return stripDiacritics(name.toLowerCase())
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}
