/**
 * What a round spent, summed from the assistant messages `pi` reported.
 *
 * Cost arrives once per assistant message and the stream carries no run total,
 * so the addition is this module's.
 *
 * The tokens come back beside the dollars because zero dollars has more than
 * one reading. A model `pi`'s price catalogue does not cover reports nothing
 * against real tokens, a round killed before its first assistant message
 * completed has no figure at all, and a provider that never reached the model
 * reports zero for everything against one message. The three fields together
 * are what tell those apart.
 *
 * Whether the round failed is decided elsewhere, and an errored message is not
 * that decision: `pi` retries a failed request itself, so one sits among
 * working messages in a round that reviewed. It carries zero usage, and the sum
 * is unaffected.
 */

import type { PiEvent } from "./stream.ts";

/** What a round spent: the dollars `pi` priced it at, and the tokens behind them. */
export type RoundCost = {
  /** US dollars. Zero against a non-zero `tokens` is unknown rather than free. */
  readonly dollars: number;
  readonly tokens: number;
  /** How many assistant messages the two figures cover. */
  readonly messages: number;
};

/**
 * A round that has reported nothing yet.
 *
 * It is also what a round killed before its first assistant message completed
 * comes back as, which is a fact about that round rather than a missing figure.
 */
export const unspent: RoundCost = Object.freeze({ dollars: 0, tokens: 0, messages: 0 });

/**
 * The round's cost with one more event counted.
 *
 * Every event but an assistant `message_end` leaves the total as it was, so a
 * caller reading the stream for anything else walks it once and passes every
 * event through here.
 */
export function costWith(total: RoundCost, event: PiEvent): RoundCost {
  if (event.type !== "message_end" || event.message.role !== "assistant") return total;
  const usage = event.message.usage;
  // `messages` says what the sum covers, so a message carrying no spend to sum
  // is left out of it rather than counted as zero.
  if (usage === undefined) return total;
  return {
    dollars: total.dollars + usage.cost.total,
    tokens: total.tokens + usage.totalTokens,
    messages: total.messages + 1,
  };
}

/**
 * What a round spent, over the whole of its stream.
 *
 * A stream that stops early — the reviewer killed at the time bound — yields
 * what the completed messages carry. That figure is a floor rather than the
 * round's cost: the request in flight is spent, billed and never reported.
 */
export async function costOf(events: AsyncIterable<PiEvent>): Promise<RoundCost> {
  let total = unspent;
  for await (const event of events) total = costWith(total, event);
  return total;
}
