/**
 * The Copilot adapter: the parts of driving the GitHub Copilot CLI, gathered as
 * one value.
 *
 * It is the whole of what the harness knows about Copilot, beside the reporting
 * server it ships. Nothing above it may reach past this for a command line, a
 * grant or a way to read what the reviewer reported.
 */

import type { Adapter } from "../adapter.ts";
import { argv, grants } from "./argv.ts";
import { confine } from "./confine.ts";
import { readReports } from "./reports.ts";
import { resumeLine } from "./session.ts";

export const copilot: Adapter = {
  argv,
  confine: (invocation) => confine(invocation),
  parse: readReports,
  grants,
  resume: resumeLine,
};
