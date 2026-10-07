/**
 * Print the runs `review-once.ts` recorded as one Markdown table, a row each.
 *
 *   node src/measure/table.ts <out-directory>...
 *
 * Which known defect a finding reports is a reading of its headline against the
 * case, so the findings are listed for a person to judge rather than scored.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Summary } from "./summary.ts";

type Recorded = Summary & { readonly case: string; readonly reviewer: string; readonly depth: string };

const rows = process.argv.slice(2).map((directory) => {
  const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8")) as Recorded;
  const cost = summary.credits === undefined ? `$${summary.dollars.toFixed(2)}` : `${summary.credits.toFixed(1)} credits`;
  const deep = summary.deepCalls.length === 0 ? "none" : summary.deepCalls.map((call) => call.tool).join(", ");
  const findings = summary.findings.length === 0 ? "none" : summary.findings.join("<br>");
  return `| ${summary.label} | ${summary.case} | ${summary.reviewer} | ${summary.depth} | ${summary.outcome} | ${summary.messages} | ${summary.tokens.toLocaleString("en")} | ${summary.seconds} | ${cost} | ${deep} | ${findings} |`;
});

console.log("| Run | Case | Reviewer | Depth | Outcome | Messages | Tokens | Seconds | Cost | Deep calls | Findings |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const row of rows) console.log(row);
