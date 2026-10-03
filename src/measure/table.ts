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

const rows = process.argv.slice(2).map((directory) => {
  const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8")) as Summary;
  const outside = `${summary.outside.length} of ${summary.looks}`;
  const findings = summary.findings.length === 0 ? "none" : summary.findings.join("<br>");
  return `| ${summary.label} | ${summary.outcome} | ${summary.messages} | ${summary.tokens.toLocaleString("en")} | ${summary.seconds} | ${summary.dollars.toFixed(2)} | ${outside} | ${findings} |`;
});

console.log("| Run | Outcome | Messages | Tokens | Seconds | Dollars | Looks outside the diff | Findings |");
console.log("|---|---|---|---|---|---|---|---|");
for (const row of rows) console.log(row);
