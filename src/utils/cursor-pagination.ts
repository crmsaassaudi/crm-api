import { BadRequestException } from '@nestjs/common';
import { FilterQuery, Types } from 'mongoose';
import {
  CursorPaginationDirection,
  PaginationModeQuery,
} from './types/cursor-pagination-options';
import { CursorPaginationResponseDto } from './dto/cursor-pagination-response.dto';

export const DEFAULT_CURSOR_COUNT_LIMIT = 10_000;
export const DEFAULT_MAX_PAGE_SIZE = 100;

interface EncodedCursorPayload {
  sortValue: string | number | boolean | null;
  id: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

interface CursorPaginationResultOptions {
  nextCursor?: string | null;
  prevCursor?: string | null;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  totalItems?: number;
  isExactCount?: boolean;
}

export const clampPaginationLimit = (
  limit: unknown,
  defaultLimit = 10,
  maxLimit = DEFAULT_MAX_PAGE_SIZE,
): number => {
  const parsedLimit = Number(limit);
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    return defaultLimit;
  }

  return Math.min(Math.floor(parsedLimit), maxLimit);
};

export const resolvePaginationMode = (
  query: PaginationModeQuery,
): 'offset' | 'cursor' => {
  if (query.paginationMode) {
    return query.paginationMode;
  }

  if (query.mode) {
    return query.mode;
  }

  if (query.cursor || query.direction) {
    return 'cursor';
  }

  return 'offset';
};

export const normalizeCursorDirection = (
  direction?: CursorPaginationDirection,
): CursorPaginationDirection => (direction === 'prev' ? 'prev' : 'next');

export const normalizeSortOrder = (sortOrder?: string): 'asc' | 'desc' =>
  sortOrder === 'asc' ? 'asc' : 'desc';

export const encodeCursor = (payload: EncodedCursorPayload): string => {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
};

export const decodeCursor = (cursor: string): EncodedCursorPayload => {
  try {
    const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      '=',
    );
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));

    if (!parsed?.id || !Types.ObjectId.isValid(parsed.id)) {
      throw new Error('Invalid cursor id');
    }

    return parsed;
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
};

export const buildMongoCursorFilter = <TSchema>({
  sortField,
  sortOrder,
  direction,
  cursorValue,
  cursorId,
}: {
  sortField: string;
  sortOrder: 'asc' | 'desc';
  direction: CursorPaginationDirection;
  cursorValue: string | number | boolean | Date;
  cursorId: string;
}): FilterQuery<TSchema> => {
  const objectId = new Types.ObjectId(cursorId);
  const operator =
    sortOrder === 'asc'
      ? direction === 'prev'
        ? '$lt'
        : '$gt'
      : direction === 'prev'
        ? '$gt'
        : '$lt';

  return {
    $or: [
      { [sortField]: { [operator]: cursorValue } },
      { [sortField]: cursorValue, _id: { [operator]: objectId } },
    ],
  } as FilterQuery<TSchema>;
};

export const buildMongoCursorSort = (
  sortField: string,
  sortOrder: 'asc' | 'desc',
  direction: CursorPaginationDirection,
): Record<string, 1 | -1> => {
  const logicalOrder: 1 | -1 = sortOrder === 'asc' ? 1 : -1;
  const queryOrder: 1 | -1 =
    direction === 'prev' ? (-logicalOrder as 1 | -1) : logicalOrder;

  return {
    [sortField]: queryOrder,
    _id: queryOrder,
  };
};

export const cursorPagination = <T>(
  data: T[],
  options: CursorPaginationResultOptions,
): CursorPaginationResponseDto<T> => ({
  data,
  nextCursor: options.nextCursor ?? null,
  prevCursor: options.prevCursor ?? null,
  hasNextPage: options.hasNextPage,
  hasPreviousPage: options.hasPreviousPage,
  totalItems: options.totalItems,
  isExactCount: options.isExactCount,
});
