/**
 * A run of `squiz review` as a process of its own, for the test that stops one
 * while it waits. It starts `host-fixture.ts` as the round host.
 *
 * Its arguments are the pull request's number and the host fixture's plan file.
 */

import { fileURLToPath } from "node:url";

import { runReview } from "./review.ts";

const hostFixture = fileURLToPath(new URL("host-fixture.ts", import.meta.url));
const [number = "", planFile = ""] = process.argv.slice(2);

const printed = await runReview({
  directory: process.cwd(),
  pullRequest: Number(number),
  environment: process.env,
  pollMs: 100,
  host: (pullRequest) => ({ command: process.execPath, args: [hostFixture, String(pullRequest), planFile] }),
});
process.stdout.write(printed.stdout);
process.stderr.write(printed.stderr);
process.exitCode = printed.exit;
