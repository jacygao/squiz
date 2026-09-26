/**
 * Splitting a run of items into spans of a fixed size.
 *
 * Scratch work for exercising the review harness. Nothing imports this file and
 * nothing here is meant to ship.
 */

/** Where one span begins and ends, as a half-open interval. */
export type Span = {
  /** The index the span begins at. */
  readonly start: number;
  /** The index after the last item of the span. */
  readonly end: number;
};

/**
 * How many spans of `size` it takes to cover `total` items.
 *
 * A short last span is a span of its own, so 10 items in spans of 4 is 3 spans.
 * A total of 0 is no spans at all.
 */
export function spanCount(total: number, size: number): number {
  return Math.ceil(total / size);
}

/**
 * The index the span numbered `number` begins at.
 *
 * Spans count from 1, so span 1 begins at index 0 and span 2 at index `size`.
 */
export function spanStart(number: number, size: number): number {
  return number * size;
}

/**
 * The 1-based number of the span that holds item `index`.
 *
 * Spans count from 1, so item 0 falls in span 1 and item `size` falls in span 2.
 */
export function spanOf(index: number, size: number): number {
  return Math.floor(index / size) + 1;
}

/**
 * Every span covering `total` items, in order.
 *
 * The last span ends at `total`, so no span reaches past the items it covers
 * and the spans together hold every item exactly once.
 */
export function spansOf(total: number, size: number): readonly Span[] {
  const spans: Span[] = [];
  for (let number = 1; number <= spanCount(total, size); number += 1) {
    const start = spanStart(number, size);
    spans.push({ start, end: Math.min(start + size, total) });
  }
  return spans;
}
