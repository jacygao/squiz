/**
 * The entry point `bin/squiz` execs. Every command dispatches from here, and
 * the dispatch itself runs under the top-level trap, so nothing the binary is
 * handed can end the process non-zero and stop the coding agent finishing its
 * turn.
 */

import { runHook } from "./hook/hook.ts";
import { reportFailure } from "./hook/report.ts";
import { runUnderTrap, type HookExit } from "./hook/trap.ts";

// A name that is not here is reported rather than stubbed, so an agent that
// runs a command this binary does not have is told so.
const commands = ["hook"];

function dispatch(argv: readonly string[]): HookExit | Promise<HookExit> {
  const command = argv[0];
  if (command === "hook") {
    return runHook();
  }

  // Exit 2 is how a round blocks the coding agent's turn, and a name the binary
  // has no command for is not grounds for that.
  const named = command === undefined ? "no command" : `no command ${JSON.stringify(command)}`;
  reportFailure(`${named}. The commands are: ${commands.join(", ")}`);
  return 0;
}

await runUnderTrap(() => dispatch(process.argv.slice(2)));
