/** How many pages a list of `items` fills at `size` items a page. */
export function pageCount(items: number, size: number): number {
  if (size <= 0) throw new RangeError("size must be positive");
  return Math.ceil(items / size);
}
