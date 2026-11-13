/**
 * The Copilot adapter: the parts of driving the GitHub Copilot CLI, gathered as
 * one value.
 *
 * It is the whole of what the harness knows about Copilot, beside the reporting
 * server it ships. Nothing above it may reach past this for a command line, a
 * grant or a way to read what the reviewer reported.
 */

import type { Adapter } from "../adapter.ts";
import { argv, grants, stderrFile } from "./argv.ts";
import { confine, userModel } from "./confine.ts";
import { readReports } from "./reports.ts";
import { resumeLine } from "./session.ts";

/** The line Copilot opens its stderr with when it finds no login, before any request. */
const SIGNED_OUT = "Error: No authentication information found.";

export const copilot: Adapter = {
  argv,
  confine: (invocation) => confine(invocation),
  parse: readReports,
  grants,
  resume: resumeLine,
  costAtExit: true,
  stderrFile,
  diagnose: (said) =>
    said.split("\n").some((line) => line.trim() === SIGNED_OUT)
      ? `the reviewer is not signed in to Copilot: it said "${SIGNED_OUT}"`
      : undefined,
  userModel: (environment) => {
    const model = userModel(environment);
    return typeof model === "object" ? { problem: model.problem, failsTheRound: true } : model;
  },
};
