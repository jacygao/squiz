/**
 * The one place the harness runs `gh`. Both transports come through it: `gh api`
 * for REST and `gh api graphql` for GraphQL.
 *
 * Nothing here throws. Every way a call can fail arrives as a value, because a
 * round that cannot reach GitHub still has to exit 0.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/**
 * The ceiling on one call to GitHub, in milliseconds.
 *
 * Not a budget a project chooses but a guard on the one deadline the harness
 * does not own: a call that hangs spends the two minutes a round has left for
 * posting, and then the runtime's kill of the hook.
 */
const CALL_CEILING_MS = 30_000;

/** The failure line is a pointer rather than a report, so one bounded line of it. */
const REASON_LIMIT = 200;

/** Where `gh` runs, and how long it may take. */
export type GhCall = {
  /**
   * The directory `gh` runs in, which decides which repository it answers
   * about: `gh` reads that directory's remotes, and `{owner}` and `{repo}` in a
   * path come from them.
   */
  readonly directory: string;
  /**
   * A bound below the ceiling, so that a test can reach the bound without
   * waiting the ceiling out.
   *
   * It only lowers: a larger value is ignored, and no configuration is read to
   * set it. The ceiling is not a project's to raise.
   */
  readonly boundMs?: number;
};

/** A REST call: `gh api <path>`. */
export type RestRequest = {
  /** The endpoint as `gh api` takes it: `repos/{owner}/{repo}/pulls/142/comments`. */
  readonly path: string;
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /**
   * The request body, sent as JSON on `gh`'s stdin.
   *
   * Not `gh`'s own field flags: `-F` reads a value beginning `@` from a file and
   * converts anything that looks like a number, and a comment body is written
   * by a model.
   */
  readonly body?: Readonly<Record<string, unknown>>;
};

/** A GraphQL call: `gh api graphql`. */
export type GraphqlRequest = {
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
};

/**
 * Why a call produced no answer. Every one carries `reason`: the one line the
 * caller reports.
 *
 * A call that reached the bound is `unreachable`, which is what GitHub being
 * unreachable is reported as. It is not a failure of its own.
 */
export type GhFailure =
  | { readonly outcome: "not-run"; readonly reason: string }
  | { readonly outcome: "unreachable"; readonly reason: string }
  | {
      readonly outcome: "exited";
      readonly reason: string;
      readonly exitStatus: number;
      // Null where the call was not an API call, or where no status line arrived.
      readonly httpStatus: number | null;
      // The response body where it parsed as JSON, `undefined` where it did not.
      readonly body: unknown;
    }
  | {
      readonly outcome: "unparsable";
      readonly reason: string;
      readonly httpStatus: number | null;
    }
  | {
      readonly outcome: "graphql-errors";
      readonly reason: string;
      readonly httpStatus: number | null;
      // Each entry as GitHub sent it. A caller narrows what it needs.
      readonly errors: readonly unknown[];
    };

/** What an API call answered, or why there is no answer. */
export type GhAnswer =
  | { readonly outcome: "answered"; readonly httpStatus: number; readonly body: unknown }
  | GhFailure;

/** What running `gh` printed, or why it printed nothing usable. */
export type GhRun = { readonly outcome: "ran"; readonly stdout: string } | GhFailure;

/**
 * Run `gh` with `argv` and hand back what it printed.
 *
 * For a `gh` command that is not an API call, or whose answer is not JSON. An
 * `api` answer goes through `callRest` or `callGraphql`, which read the HTTP
 * status that this cannot.
 *
 * A non-zero exit is a failure and never an answer: a `gh` that failed writes
 * nothing to stdout, and an empty stdout parses.
 */
export function runGh(argv: readonly string[], call: GhCall): GhRun {
  const run = invoke(argv, call, undefined);
  if (run.outcome !== "completed") return run;
  if (run.exitStatus !== 0) {
    return {
      outcome: "exited",
      reason: exitReason(run.exitStatus, null, run.stderr),
      exitStatus: run.exitStatus,
      httpStatus: null,
      body: undefined,
    };
  }
  return { outcome: "ran", stdout: run.stdout };
}

/**
 * Call a REST endpoint and read the response.
 *
 * The HTTP status and the body come back on the failure paths too. A 422 is a
 * routing signal for the caller that posts a thread and a failure for the rest,
 * and only the body says which.
 */
export function callRest(request: RestRequest, call: GhCall): GhAnswer {
  const method = request.method === undefined ? [] : ["--method", request.method];
  // `--input -` is what makes gh read the body from stdin, and it switches the
  // method to POST, so it goes with a body and never without one.
  const input = request.body === undefined ? [] : ["--input", "-"];
  const run = invoke(
    ["api", "--include", ...method, request.path, ...input],
    call,
    request.body === undefined ? undefined : JSON.stringify(request.body),
  );
  if (run.outcome !== "completed") return run;
  return readResponse(run, "rest");
}

/**
 * Call GraphQL and read the response.
 *
 * The query and its variables go as one JSON body, so a variable keeps the type
 * the query declares and nothing in it is read as a flag.
 */
export function callGraphql(request: GraphqlRequest, call: GhCall): GhAnswer {
  const body: Readonly<Record<string, unknown>> =
    request.variables === undefined
      ? { query: request.query }
      : { query: request.query, variables: request.variables };
  const run = invoke(["api", "graphql", "--include", "--input", "-"], call, JSON.stringify(body));
  if (run.outcome !== "completed") return run;
  return readResponse(run, "graphql");
}

/** The first thing a stream said, bounded to what a failure line can carry. */
export function saidBy(output: string): string {
  const line = output.split("\n").find((candidate) => candidate.trim() !== "")?.trim();
  if (line === undefined || line === "") return "it said nothing";
  return line.length > REASON_LIMIT ? `${line.slice(0, REASON_LIMIT - 3)}...` : line;
}

/** A `gh` that ran to a decision of its own, whatever that decision was. */
type Completed = {
  readonly outcome: "completed";
  readonly exitStatus: number;
  readonly stdout: string;
  readonly stderr: string;
};

function invoke(
  argv: readonly string[],
  call: GhCall,
  input: string | undefined,
): Completed | GhFailure {
  const boundMs = boundOf(call.boundMs);
  // The arguments go as an array, so no shell parses them. A branch name, a
  // comment body and a node id are all attacker-influenced, and git alone
  // admits `$( )`, backticks and `;` into a branch name.
  const result = spawnSync("gh", argv, {
    cwd: call.directory,
    encoding: "utf8",
    input,
    // GitHub's limit is the only limit. Node's default stops at a mebibyte and
    // hands back what it got, so a large diff arrives as one that reads whole
    // with files missing from the end.
    maxBuffer: Infinity,
    timeout: boundMs,
  });
  return classify(result, boundMs);
}

function classify(result: SpawnSyncReturns<string>, boundMs: number): Completed | GhFailure {
  // A call that reached the bound is reported twice over by spawnSync: as an
  // ETIMEDOUT error, and as a null exit status with SIGTERM. It is read before
  // either, or GitHub being unreachable is reported as a gh that would not run.
  if (errorCodeOf(result.error) === "ETIMEDOUT") {
    return {
      outcome: "unreachable",
      reason: `gh did not answer within ${boundMs / 1000} seconds, so GitHub could not be reached`,
    };
  }
  if (result.error !== undefined) {
    return { outcome: "not-run", reason: `gh could not be run: ${result.error.message}` };
  }
  // A gh killed by anything else answered nothing either, and "gh exited null"
  // names the mechanism rather than the failure.
  if (result.status === null) {
    return {
      outcome: "unreachable",
      reason: `gh was killed by ${result.signal ?? "a signal"}, so GitHub could not be reached`,
    };
  }
  return {
    outcome: "completed",
    exitStatus: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * The bound this call runs under: the ceiling, or a smaller one asked for.
 *
 * A `timeout` of zero turns spawnSync's timeout off altogether, so zero and
 * anything that is not a positive number fall back to the ceiling.
 */
function boundOf(asked: number | undefined): number {
  if (asked === undefined || !Number.isFinite(asked) || asked <= 0) return CALL_CEILING_MS;
  return Math.min(asked, CALL_CEILING_MS);
}

/**
 * `gh api --include` writes the status line, the headers, a blank line, then the
 * body. The status line ends in a bare newline and the headers in CRLF, so the
 * blank line that separates them from the body is either.
 */
const HEADERS_END = /\r?\n\r?\n/u;

/**
 * The status line, whatever HTTP version it names. GitHub answers `HTTP/2.0`,
 * and a pattern spelling a version out reads no status at all.
 */
const STATUS_LINE = /^HTTP\/\S+ (\d{3})/u;

/** A body that parsed. `parsed: false` covers no body, an empty one and JSON that is not. */
type Parsed = { readonly parsed: true; readonly value: unknown } | { readonly parsed: false };

/**
 * Read an `api` response: the HTTP status, the body, and whether either of them
 * says the call failed.
 *
 * The transport is a parameter because a GraphQL failure does not announce
 * itself in the status and a REST one does.
 */
function readResponse(run: Completed, transport: "rest" | "graphql"): GhAnswer {
  const httpStatus = httpStatusOf(run.stdout);
  const body = bodyOf(run.stdout);
  const parsed = parseBody(body);

  if (transport === "graphql") {
    // The errors array decides, ahead of the exit status and whatever the status
    // line says. A wrong node id to a resolve mutation fails inside an HTTP 200,
    // and a caller reading the status reports a thread closed that is still open.
    const errors = parsed.parsed ? errorsIn(parsed.value) : [];
    if (errors.length > 0) {
      return {
        outcome: "graphql-errors",
        reason: `GitHub reported a GraphQL error: ${saidBy(messageOf(errors[0]))}`,
        httpStatus,
        errors,
      };
    }
  }

  // The body survives an error status, and it is where a refused anchor is told
  // from a real failure, so a non-zero exit carries it out.
  if (run.exitStatus !== 0) {
    return {
      outcome: "exited",
      reason: exitReason(run.exitStatus, httpStatus, run.stderr),
      exitStatus: run.exitStatus,
      httpStatus,
      body: parsed.parsed ? parsed.value : undefined,
    };
  }

  if (httpStatus === null) {
    return {
      outcome: "unparsable",
      reason: `gh answered without an HTTP status: ${saidBy(run.stdout)}`,
      httpStatus: null,
    };
  }
  if (!parsed.parsed) {
    return {
      outcome: "unparsable",
      reason: `gh answered with what is not JSON: ${saidBy(body ?? "")}`,
      httpStatus,
    };
  }
  return { outcome: "answered", httpStatus, body: parsed.value };
}

function httpStatusOf(stdout: string): number | null {
  const digits = STATUS_LINE.exec(stdout)?.[1];
  if (digits === undefined) return null;
  return Number.parseInt(digits, 10);
}

/** What `gh` printed after the headers, or `null` where no headers ended. */
function bodyOf(stdout: string): string | null {
  const end = HEADERS_END.exec(stdout);
  if (end === null) return null;
  return stdout.slice(end.index + end[0].length);
}

function parseBody(body: string | null): Parsed {
  if (body === null) return { parsed: false };
  try {
    return { parsed: true, value: JSON.parse(body) };
  } catch {
    return { parsed: false };
  }
}

/**
 * The `errors` array of a GraphQL response, empty where there is none.
 *
 * An `errors` that is there and is not an array counts as one error. Fail
 * closed: the other way round reports a failed mutation as a success.
 */
function errorsIn(value: unknown): readonly unknown[] {
  if (typeof value !== "object" || value === null || !("errors" in value)) return [];
  const errors: unknown = value.errors;
  if (errors === null || errors === undefined) return [];
  return Array.isArray(errors) ? errors : [errors];
}

/** The `message` of one GraphQL error, or the error as it arrived where it has none. */
function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message: unknown = error.message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(error) ?? "";
}

function exitReason(exitStatus: number, httpStatus: number | null, stderr: string): string {
  const status = httpStatus === null ? "" : ` on HTTP ${httpStatus}`;
  return `gh exited ${exitStatus}${status}: ${saidBy(stderr)}`;
}

/** The errno a failed spawn carries. `spawnSync` types its error as a plain one. */
function errorCodeOf(error: Error | undefined): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
