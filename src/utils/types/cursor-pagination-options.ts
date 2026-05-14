export type CursorPaginationDirection = 'next' | 'prev';

export type PaginationMode = 'offset' | 'cursor';

export interface ICursorPaginationOptions {
  limit: number;
  cursor?: string | null;
  direction?: CursorPaginationDirection;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  countLimit?: number;
}

export interface PaginationModeQuery {
  page?: string | number;
  cursor?: string | null;
  direction?: CursorPaginationDirection;
  paginationMode?: PaginationMode;
  mode?: PaginationMode;
}
