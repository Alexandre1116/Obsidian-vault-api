/**
 * Content-scan runner.
 *
 * Pure and free of the `obsidian` import so it can be unit-tested directly
 * (tests/vault-scan.test.ts). The caller supplies `stat` and `read` callbacks;
 * everything about the budget is decided here.
 *
 * Why a runner instead of a loop in the tool: the size reported by the vault
 * file list can be stale. A file that grew after enumeration used to be read at
 * its new size, and with 20 concurrent reads the aggregate could blow well past
 * the advertised budget. Bytes are therefore **reserved** at the worst-case
 * per-file cap before a read starts, and the current size is checked again
 * before the read, so the aggregate is strict no matter what the listing said.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";

export interface ScanItem {
  /** Vault-relative path, used only as an identity for the callbacks. */
  path: string;
  /**
   * Size from the file listing, when known. It seeds the byte reservation; the
   * runner tops it up from the fresh stat before reading, so the aggregate
   * stays strict without penalizing accurate listings.
   */
  declaredSize?: number;
}

export interface ScanReadResult {
  /** Bytes actually decoded. Must not exceed the cap the runner passed in. */
  bytes: number;
  /** Matching lines, when the file matched. */
  matches?: string[];
  /** Current size is above the cap: the file was not read. */
  tooLarge?: boolean;
  /** The file could not be read at all. */
  failed?: boolean;
  /** Stopped because the wall-clock budget passed. */
  cancelled?: boolean;
}

export interface ScanOptions<T extends ScanItem> {
  /** Hard cap for one file: reserved before reading and passed to `read`. */
  perFileBytes: number;
  /** Strict aggregate cap, enforced by reservation rather than after the fact. */
  maxTotalBytes: number;
  /** Maximum simultaneous reads. */
  concurrency: number;
  /** Wall-clock stop; also re-checked before every individual read. */
  deadlineAt: number;
  /** Current size on disk. Called immediately before each read. */
  stat: (item: T) => Promise<number | null>;
  /** Reads at most `capBytes`. Must not allocate beyond that. */
  read: (item: T, capBytes: number) => Promise<ScanReadResult>;
  /** Called for every match. Return false to stop the scan (result cap). */
  onMatch: (item: T, matches: string[]) => boolean;
}

export interface ScanSummary {
  scannedFiles: number;
  bytesScanned: number;
  /** Highest number of reads in flight at once, for regression checks. */
  maxConcurrentReads: number;
  tooLarge: number;
  readFailed: number;
  deadlineHit: boolean;
  budgetHit: boolean;
  /** The result callback stopped the scan. */
  capped: boolean;
  /** Candidates that were never started because the scan stopped early. */
  notStarted: number;
  /** One candidate that fit the listing but not the budget after the fresh stat. */
  deferredByBudget: number;
}

/**
 * True when `target` is `root` or below it. Compares case-insensitively on
 * Windows, where the same directory can appear with different letter case, and
 * requires a real separator so `/vault-evil` is never treated as inside
 * `/vault`.
 */
export function isSameOrInside(root: string, target: string): boolean {
  if (!root) return false;
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const a = fold(root), b = fold(target);
  if (a === b) return true;
  if (!b.startsWith(a)) return false;
  const rest = target.slice(root.length);
  return rest.startsWith(nodePath.sep) || rest.startsWith("/");
}

/**
 * Native realpath. On Windows the plain implementation returns the path as it
 * was given, which for a temp directory means the 8.3 short form
 * (`C:\Users\RUNNER~1\...`), while resolving a link through the OS yields the
 * long form (`C:\Users\runneradmin\...`). Both sides must be produced the same
 * way or containment compares two spellings of the same directory.
 */
export function realPathNative(target: string): Promise<string> {
  return new Promise(resolve => {
    fs.realpath.native(target, (err, resolved) => resolve(err ? nodePath.resolve(target) : resolved));
  });
}

export class DeadlineExpiredError extends Error {
  constructor() { super("the scan deadline passed"); }
}

/**
 * Race an operation against the scan deadline. When the deadline wins,
 * `onOverdue` runs first: closing the file handle there is what aborts a
 * blocked read, because Node rejects the pending operation once its handle is
 * closed.
 *
 * A pending `open` cannot be aborted (no handle exists yet), so the runner also
 * checks the deadline before starting work.
 */
export function withDeadline<T>(operation: Promise<T>, deadlineAt: number, onOverdue?: () => void): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    onOverdue?.();
    return Promise.reject(new DeadlineExpiredError());
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onOverdue?.();
      reject(new DeadlineExpiredError());
    }, remaining);
    operation.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * Reads at most `capBytes` from an absolute path, without ever allocating the
 * whole file.
 *
 * The name is resolved once and verified against the vault root, and the file
 * is then opened with `O_NOFOLLOW` where the platform supports it, so the final
 * component cannot be swapped for a link between the check and the open. Size
 * and type come from the **handle** (`fstat`), not from the name. Every
 * operation is bounded by the deadline, which closes the handle and aborts a
 * read stuck on a slow mount.
 *
 * Residual race, stated honestly: renaming an intermediate directory mid-scan
 * is not detected, and a pending `open` cannot be aborted because no handle
 * exists yet.
 */
export interface BoundedRead {
  /** Bytes read, always <= the cap that was passed in. */
  bytes: number;
  /** UTF-8 text, when the caller wanted text. */
  text?: string;
  /** Raw bytes, when the caller wanted binary. */
  data?: Buffer;
  /** Current size on disk, reported even when the file was refused. */
  size?: number;
  tooLarge?: boolean;
  failed?: boolean;
  cancelled?: boolean;
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Opens one file for a bounded read, with the containment and link checks done
 * in one place.
 *
 * The name is resolved once and verified against the vault root, and the file
 * is then opened with `O_NOFOLLOW` where the platform supports it, so the final
 * component cannot be swapped for a link between the check and the open. A
 * vault may legitimately contain links to other notes, so a link is followed
 * once, verified, and the resolved target is what gets opened with `O_NOFOLLOW`.
 *
 * Residual race, stated honestly: renaming an intermediate directory mid-read
 * is not detected, and a pending `open` cannot be aborted because no handle
 * exists yet.
 */
async function openBoundedFile(
  absPath: string,
  vaultRoot: string,
  deadlineAt: number
): Promise<{ handle: fs.promises.FileHandle | null; error?: "outside" | "missing" | "link-outside" }> {
  const lexical = nodePath.resolve(absPath);
  if (!isSameOrInside(vaultRoot, lexical)) return { handle: null, error: "outside" };

  const link = await withDeadline(fs.promises.lstat(lexical), deadlineAt);
  if (!link) return { handle: null, error: "missing" };

  let openTarget = lexical;
  if (link.isSymbolicLink()) {
    const real = await realPathNative(lexical);
    if (!isSameOrInside(vaultRoot, real)) return { handle: null, error: "link-outside" };
    openTarget = real;
  }

  const flags = fs.constants.O_NOFOLLOW !== undefined
    ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    : fs.constants.O_RDONLY;

  const handle = await withDeadline(fs.promises.open(openTarget, flags), deadlineAt);
  return { handle };
}

/**
 * Reads at most `capBytes` from an open handle, in chunks, so the allocation is
 * bounded by the cap rather than by whatever the file reports. The extra byte
 * that is allowed for only tells "exactly at the cap" from "above it"; the
 * caller never receives it.
 *
 * Chunking matters independently of the size check: the size a file reports is
 * not always what it yields (grown or truncated after `fstat`, a sparse file, a
 * pseudo-file that reports 0), and a single `read` call is not required to
 * return the whole request.
 */
async function readCapped(
  handle: fs.promises.FileHandle,
  capBytes: number,
  deadlineAt: number
): Promise<{ chunks: Buffer[]; total: number; tooLarge: boolean }> {
  const close = () => { void handle.close().catch(() => undefined); };
  const chunks: Buffer[] = [];
  let total = 0;

  while (total <= capBytes) {
    const want = Math.min(READ_CHUNK_BYTES, capBytes + 1 - total);
    if (want <= 0) break;
    const slice = Buffer.alloc(want);
    const { bytesRead } = await withDeadline(handle.read(slice, 0, want, total), deadlineAt, close);
    if (bytesRead === 0) break;
    total += bytesRead;
    chunks.push(slice.subarray(0, bytesRead));
  }

  return { chunks, total, tooLarge: total > capBytes };
}

/**
 * Bounded read of one vault file, as text. Size and type come from the **handle**
 * (`fstat`), never from the name or from the vault file listing, so a file that
 * grew after it was listed cannot be read past the cap. Every filesystem
 * operation is raced against `deadlineAt`: when the deadline wins the handle is
 * closed, which is what aborts a read stuck on a slow or dead mount.
 *
 * `absPath` must already be the result of the plugin's vault path validation
 * (`validateVaultPath` plus the join with the root); it is contained again here
 * because this is the only place the read paths touch `fs` directly.
 */
export async function readBoundedFile(
  absPath: string,
  vaultRoot: string,
  capBytes: number,
  deadlineAt: number
): Promise<BoundedRead> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const opened = await openBoundedFile(absPath, vaultRoot, deadlineAt);
    if (!opened.handle) return { bytes: 0, failed: true };
    handle = opened.handle;

    const stat = await withDeadline(handle.stat(), deadlineAt, () => { void handle?.close().catch(() => undefined); });
    if (!stat.isFile()) return { bytes: 0, failed: true };
    if (stat.size > capBytes) return { bytes: 0, size: stat.size, tooLarge: true };

    const read = await readCapped(handle, capBytes, deadlineAt);
    if (read.tooLarge) return { bytes: 0, size: read.total, tooLarge: true };

    return { bytes: read.total, size: stat.size, text: Buffer.concat(read.chunks, read.total).toString("utf-8") };
  } catch (err) {
    if (err instanceof DeadlineExpiredError) return { bytes: 0, cancelled: true };
    // ELOOP is what O_NOFOLLOW reports when the path is a link at open time.
    return { bytes: 0, failed: true };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Same bounded read, returning bytes instead of text. Used by `read_file` for
 * binary and media payloads, where `vault.readBinary` allocates whatever the
 * file is now, based on a listing size that may be stale.
 */
export async function readBoundedBinary(
  absPath: string,
  vaultRoot: string,
  capBytes: number,
  deadlineAt: number
): Promise<BoundedRead> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const opened = await openBoundedFile(absPath, vaultRoot, deadlineAt);
    if (!opened.handle) return { bytes: 0, failed: true };
    handle = opened.handle;

    const stat = await withDeadline(handle.stat(), deadlineAt, () => { void handle?.close().catch(() => undefined); });
    if (!stat.isFile()) return { bytes: 0, failed: true };
    if (stat.size > capBytes) return { bytes: 0, size: stat.size, tooLarge: true };

    const read = await readCapped(handle, capBytes, deadlineAt);
    if (read.tooLarge) return { bytes: 0, size: read.total, tooLarge: true };

    return { bytes: read.total, size: stat.size, data: Buffer.concat(read.chunks, read.total) };
  } catch (err) {
    if (err instanceof DeadlineExpiredError) return { bytes: 0, cancelled: true };
    return { bytes: 0, failed: true };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runContentScan<T extends ScanItem>(
  items: T[],
  options: ScanOptions<T>
): Promise<ScanSummary> {
  const summary: ScanSummary = {
    scannedFiles: 0,
    bytesScanned: 0,
    maxConcurrentReads: 0,
    tooLarge: 0,
    readFailed: 0,
    deadlineHit: false,
    budgetHit: false,
    capped: false,
    notStarted: 0,
    deferredByBudget: 0,
  };

  let cursor = 0;
  let reserved = 0;
  let active = 0;
  let stopped = false;
  let capReached = false;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      if (Date.now() >= options.deadlineAt) { summary.deadlineHit = true; stopped = true; break; }
      if (reserved >= options.maxTotalBytes) { summary.budgetHit = true; stopped = true; break; }

      const item = items[cursor++];
      if (!item) break;

      const sizeNow = await options.stat(item);
      if (sizeNow === null) { summary.readFailed++; continue; }
      if (sizeNow > options.perFileBytes) { summary.tooLarge++; continue; }

      // Reserve the listed size, then top it up to the current size. A
      // reservation is always at least what the read can allocate, so the
      // aggregate cannot pass the budget even when every listed size was
      // stale. A file that grew past the cap was already rejected above.
      const declared = Math.min(item.declaredSize ?? options.perFileBytes, options.perFileBytes);
      const cost = Math.max(declared, Math.min(sizeNow, options.perFileBytes));
      if (reserved + cost > options.maxTotalBytes) {
        summary.budgetHit = true;
        summary.deferredByBudget++;
        stopped = true;
        break;
      }
      reserved += cost;

      if (Date.now() >= options.deadlineAt) { summary.deadlineHit = true; stopped = true; break; }

      active++;
      if (active > summary.maxConcurrentReads) summary.maxConcurrentReads = active;
      let result: ScanReadResult;
      try {
        result = await options.read(item, options.perFileBytes);
      } catch {
        result = { bytes: 0, failed: true };
      } finally {
        active--;
      }

      if (result.cancelled) { summary.deadlineHit = true; stopped = true; continue; }
      if (result.tooLarge) { summary.tooLarge++; continue; }
      if (result.failed) { summary.readFailed++; continue; }
      if (result.bytes > options.perFileBytes) {
        // A reader that ignored the cap is treated as a failure rather than
        // allowed to move the aggregate past the budget.
        summary.readFailed++;
        continue;
      }

      // Results from reads that were already in flight are still credited:
      // their bytes were really allocated, and the caller's own cap decides how
      // many matches it sees. Only matches past that cap are dropped.
      summary.scannedFiles++;
      summary.bytesScanned += result.bytes;
      if (!capReached && result.matches && result.matches.length) {
        if (!options.onMatch(item, result.matches)) {
          summary.capped = true;
          capReached = true;
          stopped = true;
        }
      }
    }
  };

  const workers = Math.max(1, Math.min(options.concurrency, items.length));
  const running: Promise<void>[] = [];
  for (let i = 0; i < workers; i++) running.push(worker());
  await Promise.all(running);

  summary.notStarted = Math.max(0, items.length - cursor);
  return summary;
}
