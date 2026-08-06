import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Fields the list may be sorted by, in both offset and cursor mode. */
export const CONTACT_SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'firstName',
  'lastName',
  'score',
  'lastActivityAt',
  'totalRevenue',
  'lastPurchaseAt',
] as const;

export class QueryContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  viewId?: string;

  @IsOptional()
  @IsString()
  lifecycleStage?: string;

  /**
   * "Contacts at this company" — the account detail page's related list.
   *
   * Declared because the UI has always sent it: with `forbidNonWhitelisted` on,
   * an undeclared query parameter fails the whole request, so the related list
   * answered 422 instead of filtering.
   */
  @IsOptional()
  @IsMongoId()
  accountId?: string;

  /** Restrict the list to the members of a saved segment. */
  @IsOptional()
  @IsMongoId()
  segmentId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsIn(['next', 'prev'])
  direction?: string;

  @IsOptional()
  @IsIn(CONTACT_SORTABLE_FIELDS)
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: string;

  // Wider than the previous 2,000 because a condition tree with operators is
  // more verbose than the flat `[{id,value}]` list it replaces, and a segment
  // definition round-trips through here.
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  filters?: string;

  @IsOptional()
  @IsIn(['offset', 'cursor'])
  paginationMode?: string;
}
