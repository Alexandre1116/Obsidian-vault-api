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
