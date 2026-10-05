/** How many pages of `size` items `total` items fill. */
export function pageCount(total: number, size: number): number {
  return Math.ceil(total / size);
}

/** The items on 1-indexed page `page`, or an empty array when there is no such page. */
export function getPage<T>(items: readonly T[], page: number, size: number): T[] {
  if (page < 1 || page > pageCount(items.length, size)) return [];
  return items.slice((page - 1) * size, page * size);
}

/** The items on the last page. */
export function lastPage<T>(items: readonly T[], size: number): T[] {
  return getPage(items, pageCount(items.length, size), size);
}
