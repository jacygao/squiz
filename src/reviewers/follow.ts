/**
 * A file another process appends to, read as it grows.
 *
 * The reviewer reports into a file rather than through its output, and the round
 * holds what it has reported at every moment of the run only if the file is read
 * while the run goes on. So this reads whatever the file has grown by since the
 * last read, at an interval, and passes those bytes on as they are.
 *
 * Nothing here knows what a line is. A read can end partway through one, and
 * the reader of these bytes holds that part until the rest arrives.
 */

import { type FileHandle, open } from "node:fs/promises";

/** How much one read takes, so that a file that grew a long way is passed on in pieces. */
const CHUNK_BYTES = 64 * 1024;

export type Following = {
  /**
   * Resolves once nothing more will be written. The file is read once more
   * after it does, and that read is the last.
   */
  readonly ended: Promise<void>;
  /** How long to wait between reads while the writer is still going. */
  readonly pollMs: number;
  /**
   * Stops the follow where it is, without the last read. For a caller that has
   * stopped waiting for the file.
   */
  readonly abandoned?: AbortSignal;
};

/**
 * Every byte appended to `path`, in order, until the writer has ended.
 *
 * A file that is not there yet is a file with nothing in it, so a writer that
 * never wrote is read as nothing at all. Any other failure to read it raises
 * through the iteration.
 */
export async function* follow(path: string, following: Following): AsyncGenerator<Uint8Array> {
  const { ended, pollMs, abandoned } = following;
  let over = false;
  let wake = (): void => {};
  void ended.then(() => {
    over = true;
    wake();
  });
  abandoned?.addEventListener("abort", () => wake());
  const gaveUp = (): boolean => abandoned?.aborted === true;

  let handle: FileHandle | undefined;
  let offset = 0;
  try {
    for (;;) {
      // Taken before the read rather than after it: whatever the writer wrote
      // before it ended is then in the file by the time this pass reads it.
      const last = over;
      for (;;) {
        if (gaveUp()) return;
        handle ??= await opened(path);
        if (handle === undefined) break;
        const buffer = new Uint8Array(CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
      if (last || gaveUp()) return;
      await new Promise<void>((settle) => {
        const timer = setTimeout(settle, pollMs);
        wake = () => {
          clearTimeout(timer);
          settle();
        };
      });
    }
  } finally {
    await handle?.close();
  }
}

/** The file opened for reading, or `undefined` where it is not there yet. */
async function opened(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, "r");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}
