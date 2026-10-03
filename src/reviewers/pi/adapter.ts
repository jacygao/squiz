/**
 * The `pi` adapter: the four parts of driving that CLI, gathered as one value.
 *
 * It is the whole of what the harness knows about `pi`. A second reviewer is a
 * second value of this shape and no other change, so nothing above it may reach
 * past this for a command line, a grant or a way to read output.
 */

import type { Adapter } from "../adapter.ts";
import { argv, grants } from "./argv.ts";
import { parse } from "./parse.ts";
import { confine } from "./settings.ts";

export const pi: Adapter = { argv, confine, parse, grants };
