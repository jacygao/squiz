/** How many pages of `size` items it takes to hold `count` items. */
export function pageCount(count: number, size: number): number {
  return Math.floor(count / size);
}
