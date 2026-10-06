/**
 * Where the reviewer `.squiz.json` names becomes the adapter that drives it.
 *
 * It is the one place a reviewer's name is turned into its CLI. Nothing outside
 * this directory imports an adapter, so a round runs the reviewer the project
 * chose and no other.
 */

import type { Reviewer } from "../config/config.ts";
import type { Adapter } from "./adapter.ts";
import { copilot } from "./copilot/adapter.ts";
import { pi } from "./pi/adapter.ts";

const adapters: Readonly<Record<Reviewer, Adapter>> = Object.freeze({ pi, copilot });

export function adapterFor(reviewer: Reviewer): Adapter {
  return adapters[reviewer];
}
