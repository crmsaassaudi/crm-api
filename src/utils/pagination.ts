import { IPaginationOptions } from './types/pagination-options';
import { PaginationResponseDto } from './dto/pagination-response.dto';

export const pagination = <T>(
  data: T[],
  totalItems: number,
  options: IPaginationOptions,
): PaginationResponseDto<T> => {
  const totalPages = Math.ceil(totalItems / options.limit);
  const currentPage = options.page;

  return {
    data,
    totalItems,
    totalPages,
    currentPage,
    hasNextPage: currentPage < totalPages,
    hasPreviousPage: currentPage > 1,
  };
};
