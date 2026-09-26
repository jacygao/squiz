/**
 * The pages a long listing is served in.
 *
 * A caller walks a listing one page at a time rather than holding all of it, so
 * the arithmetic here decides which items it ever sees.
 */

/** One page of a listing. */
export type Page = {
  /** The page's own number, counting from 1. */
  readonly number: number;
  /** The index of the first item on the page, counting from 0. */
  readonly start: number;
  /** The index one past the last item on the page. */
  readonly end: number;
};

/**
 * How many pages `total` items fill at `perPage` items a page.
 *
 * A last page holding fewer than `perPage` items is a page of its own, so 10
 * items at 4 a page fill 3 pages.
 */
export function pageCount(total: number, perPage: number): number {
  return Math.floor(total / perPage);
}

/**
 * The page numbered `number`, out of `total` items at `perPage` items a page.
 *
 * Pages count from 1, so page 1 starts at index 0 and page 2 at index
 * `perPage`.
 */
export function pageAt(number: number, perPage: number, total: number): Page {
  const start = number * perPage;
  return { number, start, end: Math.min(start + perPage, total) };
}
