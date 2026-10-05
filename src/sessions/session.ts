/**
 * Start a command as a session: in a Herdr pane, in a tmux window, or as a child
 * with no terminal, whichever the environment offers first.
 *
 * What a start returns names the backend, the pane or window, and the identity
 * of the session's process. Written down, that is enough for a process that did
 * not start the session to find it and stop it.
 *
 * Nothing here throws. Every answer is a value the caller reads.
 */

import { startChild, type ChildCommand, type ChildProcessHandle, type ChildStart } from "./child.ts";
import { insideHerdr, startInHerdrPane, type HerdrOptions, type PaneCommand, type PaneStart } from "./herdr.ts";
import type { ProcessIdentity } from "./process.ts";
import { openWindow, type Environment, type TmuxWindow, type WindowOpening, type WindowRequest } from "./tmux.ts";

export type SessionRequest = {
  /** The tab's label or the window's name. */
  readonly name: string;
  readonly directory: string;
  /** What runs where there is a terminal. */
  readonly inPane: { readonly program: string; readonly arguments: readonly string[] };
  /** What runs where there is none, which may need other arguments to run unattended. */
  readonly withoutTerminal: { readonly program: string; readonly arguments: readonly string[] };
  /** How long a Herdr pane's command may take to start running once the shell has it. */
  readonly startsWithinMs: number;
  /** The Herdr workspace to open the tab in. Without one, Herdr uses the focused workspace. */
  readonly workspace?: string;
  /**
   * Set in the command's environment on every backend. A pane's command
   * otherwise has the pane server's environment, not the caller's.
   */
  readonly variables?: Readonly<Record<string, string>>;
};

export type SessionOptions = {
  /**
   * Chooses the backend, and is what Herdr and tmux run with. A child runs
   * with it too, under the request's variables. It is not passed into a pane
   * whole, where the caller's `TERM` or `TMUX` would be wrong for the pane.
   */
  readonly environment: Environment;
  /** Bounds each program this runs to start the session. */
  readonly boundMs: number;
};

export type Backends = {
  readonly herdr: (command: PaneCommand, options: HerdrOptions) => PaneStart;
  readonly tmux: (request: WindowRequest, environment: Environment, boundMs: number) => WindowOpening;
  readonly child: (command: ChildCommand, environment: NodeJS.ProcessEnv, boundMs: number) => Promise<ChildStart>;
};

export type SessionPlace =
  | { readonly backend: "herdr"; readonly pane: string; readonly identity: ProcessIdentity }
  | { readonly backend: "tmux"; readonly window: TmuxWindow; readonly identity: ProcessIdentity }
  | { readonly backend: "child"; readonly identity: ProcessIdentity };

/** A pane or window a failed start left open, which may still be running the command. */
export type LeftOpen =
  | { readonly backend: "herdr"; readonly pane: string }
  | { readonly backend: "tmux"; readonly window: TmuxWindow };

export type Refusal = { readonly backend: "herdr" | "tmux"; readonly reason: string };

export type SessionStart =
  | {
      readonly outcome: "started";
      readonly place: SessionPlace;
      /** The handle the caller drains, waits on and reaps. Only a child has one. */
      readonly child?: ChildProcessHandle;
      /** Why each backend tried before this one opened nothing. */
      readonly refusals: readonly Refusal[];
    }
  | {
      readonly outcome: "failed";
      readonly backend: SessionPlace["backend"];
      readonly reason: string;
      readonly leftOpen?: LeftOpen;
    };

const BACKENDS: Backends = { herdr: startInHerdrPane, tmux: openWindow, child: startChild };

/**
 * Start `request` in the first place the environment offers: a Herdr pane, a
 * tmux window, or a child with no terminal.
 *
 * A pane backend that refuses opened nothing, so the next is tried. One that
 * fails may have left the command running, so its failure is returned and
 * nothing else is started: starting another would run the command twice.
 */
export async function startSession(
  request: SessionRequest,
  options: SessionOptions,
  backends: Backends = BACKENDS,
): Promise<SessionStart> {
  const { environment, boundMs } = options;
  const refusals: Refusal[] = [];

  if (insideHerdr(environment)) {
    const command: PaneCommand = {
      directory: request.directory,
      name: request.name,
      program: request.inPane.program,
      arguments: request.inPane.arguments,
      startsWithinMs: request.startsWithinMs,
      ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
      ...(request.variables === undefined ? {} : { variables: request.variables }),
    };
    const pane = backends.herdr(command, { environment, boundMs });
    if (pane.outcome === "started") {
      return { outcome: "started", place: { backend: "herdr", pane: pane.pane, identity: pane.leader }, refusals };
    }
    if (pane.outcome === "failed") {
      const leftOpen: LeftOpen | undefined =
        pane.paneLeftOpen === undefined ? undefined : { backend: "herdr", pane: pane.paneLeftOpen };
      return failure("herdr", pane.reason, leftOpen);
    }
    refusals.push({ backend: "herdr", reason: pane.reason });
  }

  if (insideTmux(environment)) {
    const argv = [request.inPane.program, ...request.inPane.arguments];
    const windowRequest: WindowRequest = {
      name: request.name,
      directory: request.directory,
      argv,
      ...(request.variables === undefined ? {} : { variables: request.variables }),
    };
    const window = backends.tmux(windowRequest, environment, boundMs);
    if (window.outcome === "opened") {
      const place: SessionPlace = { backend: "tmux", window: window.window, identity: window.identity };
      return { outcome: "started", place, refusals };
    }
    if (window.outcome === "failed") {
      const leftOpen: LeftOpen | undefined =
        window.window === undefined ? undefined : { backend: "tmux", window: window.window };
      return failure("tmux", window.reason, leftOpen);
    }
    refusals.push({ backend: "tmux", reason: window.reason });
  }

  const { program, arguments: args } = request.withoutTerminal;
  const child = await backends.child(
    { program, arguments: args, directory: request.directory },
    { ...environment, ...request.variables },
    boundMs,
  );
  if (child.outcome === "failed") return failure("child", child.reason, undefined);
  return { outcome: "started", place: { backend: "child", identity: child.identity }, child: child.child, refusals };
}

function failure(backend: SessionPlace["backend"], reason: string, leftOpen: LeftOpen | undefined): SessionStart {
  if (leftOpen === undefined) return { outcome: "failed", backend, reason };
  return { outcome: "failed", backend, reason, leftOpen };
}

function insideTmux(environment: Environment): boolean {
  return (environment["TMUX"] ?? "") !== "";
}
