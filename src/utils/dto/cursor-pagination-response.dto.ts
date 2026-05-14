import { Type } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CursorPaginationResponseDto<T> {
  data: T[];
  nextCursor?: string | null;
  prevCursor?: string | null;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  totalItems?: number;
  isExactCount?: boolean;
}

export function CursorPaginationResponse<T>(classReference: Type<T>) {
  abstract class CursorPagination {
    @ApiProperty({ type: [classReference] })
    data!: T[];

    @ApiPropertyOptional({ type: String, nullable: true })
    nextCursor?: string | null;

    @ApiPropertyOptional({ type: String, nullable: true })
    prevCursor?: string | null;

    @ApiProperty({ type: Boolean, example: true })
    hasNextPage: boolean;

    @ApiProperty({ type: Boolean, example: false })
    hasPreviousPage: boolean;

    @ApiPropertyOptional({ type: Number, example: 10000 })
    totalItems?: number;

    @ApiPropertyOptional({ type: Boolean, example: false })
    isExactCount?: boolean;
  }

  Object.defineProperty(CursorPagination, 'name', {
    writable: false,
    value: `CursorPagination${classReference.name}ResponseDto`,
  });

  return CursorPagination;
}
