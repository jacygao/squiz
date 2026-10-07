/**
 * The `pi` adapter: the parts of driving that CLI, gathered as one value.
 *
 * It is the whole of what the harness knows about `pi`. A second reviewer is a
 * second value of this shape and no other change, so nothing above it may reach
 * past this for a command line, a grant or a way to read what the reviewer
 * reported.
 */

import type { Adapter } from "../adapter.ts";
import { argv, grants } from "./argv.ts";
import { confine } from "./confine.ts";
import { readReports } from "./reports.ts";
import { resumeLine } from "./session.ts";
import { userModel } from "./settings.ts";

export const pi: Adapter = {
  argv,
  confine: (invocation) => confine(invocation),
  parse: readReports,
  grants,
  resume: (sessionDirectory, spelled) => {
    const resume = resumeLine(sessionDirectory, spelled);
    return resume.kind === "resumable" ? resume.line : undefined;
  },
  userModel,
};
