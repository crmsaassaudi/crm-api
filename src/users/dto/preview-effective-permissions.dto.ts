import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsMongoId, IsObject, IsOptional } from 'class-validator';

/**
 * Unsaved membership edits to resolve against, so the admin UI can show the
 * access a pending change would produce without persisting it or reimplementing
 * the permission engine in the browser.
 *
 * An omitted field means "keep what is stored"; `[]` / `{}` mean "clear it".
 */
export class PreviewEffectivePermissionsDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Candidate custom-role ids',
  })
  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  roleIds?: string[];

  @ApiPropertyOptional({
    type: Object,
    description: 'Candidate per-key overrides, permissionKey → allow/deny',
    example: { 'contacts:delete': false },
  })
  @IsObject()
  @IsOptional()
  permissionOverrides?: Record<string, boolean>;
}
