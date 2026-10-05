/**
 * Split items into consecutive pages of pageSize, the last holding what is left.
 *
 * Throws a RangeError when pageSize is not a positive integer.
 */
export function paginate<T>(items: readonly T[], pageSize: number): T[][] {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`page size must be a positive integer, got ${pageSize}`);
  }
  const pages: T[][] = [];
  for (let start = 0; start < items.length; start += pageSize) {
    pages.push(items.slice(start, start + pageSize));
  }
  return pages;
}
