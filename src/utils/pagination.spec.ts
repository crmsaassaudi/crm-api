import { pagination } from './pagination';

describe('pagination', () => {
  it('should calculate totalPages correctly', () => {
    const result = pagination(['a', 'b'], 10, { page: 1, limit: 3 });
    expect(result.totalPages).toBe(4); // ceil(10/3) = 4
    expect(result.totalItems).toBe(10);
    expect(result.currentPage).toBe(1);
  });

  it('should set hasNextPage=true when not on last page', () => {
    const result = pagination([], 10, { page: 1, limit: 5 });
    expect(result.hasNextPage).toBe(true);
  });

  it('should set hasNextPage=false on last page', () => {
    const result = pagination([], 10, { page: 2, limit: 5 });
    expect(result.hasNextPage).toBe(false);
  });

  it('should set hasPreviousPage=false on first page', () => {
    const result = pagination([], 10, { page: 1, limit: 5 });
    expect(result.hasPreviousPage).toBe(false);
  });

  it('should set hasPreviousPage=true on page > 1', () => {
    const result = pagination([], 10, { page: 2, limit: 5 });
    expect(result.hasPreviousPage).toBe(true);
  });

  it('should handle zero items', () => {
    const result = pagination([], 0, { page: 1, limit: 10 });
    expect(result.totalPages).toBe(0);
    expect(result.totalItems).toBe(0);
    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(false);
  });

  it('should return the data array unchanged', () => {
    const data = [{ id: 1 }, { id: 2 }];
    const result = pagination(data, 100, { page: 1, limit: 10 });
    expect(result.data).toBe(data);
  });

  it('should handle limit=1 with many items', () => {
    const result = pagination(['x'], 100, { page: 50, limit: 1 });
    expect(result.totalPages).toBe(100);
    expect(result.hasNextPage).toBe(true);
    expect(result.hasPreviousPage).toBe(true);
  });
});
