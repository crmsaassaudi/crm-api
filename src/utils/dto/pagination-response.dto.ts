import { Type } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

export class PaginationResponseDto<T> {
  data: T[];
  totalItems: number;
  totalPages: number;
  currentPage: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export function PaginationResponse<T>(classReference: Type<T>) {
  abstract class Pagination {
    @ApiProperty({ type: [classReference] })
    data!: T[];

    @ApiProperty({ type: Number, example: 100 })
    totalItems: number;

    @ApiProperty({ type: Number, example: 10 })
    totalPages: number;

    @ApiProperty({ type: Number, example: 1 })
    currentPage: number;

    @ApiProperty({ type: Boolean, example: true })
    hasNextPage: boolean;

    @ApiProperty({ type: Boolean, example: false })
    hasPreviousPage: boolean;
  }

  Object.defineProperty(Pagination, 'name', {
    writable: false,
    value: `Pagination${classReference.name}ResponseDto`,
  });

  return Pagination;
}
