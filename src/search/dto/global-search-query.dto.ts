import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const SEARCH_MODULES = [
  'contacts',
  'accounts',
  'deals',
  'tickets',
  'tasks',
] as const;

export type SearchModule = (typeof SEARCH_MODULES)[number];

const parseModules = (value: unknown): string[] | undefined => {
  if (value == null || value === '') return undefined;
  const values = Array.isArray(value) ? value : String(value).split(',');
  return [
    ...new Set(
      values
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
};

export class GlobalSearchQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  query: string;

  @IsOptional()
  @Transform(({ value }) => parseModules(value))
  @IsArray()
  @ArrayMaxSize(SEARCH_MODULES.length)
  @IsIn(SEARCH_MODULES, { each: true })
  modules?: SearchModule[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limitPerModule = 5;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string;
}
