import { describe, it, expect } from "vitest";
import { runContentScan, type ScanReadResult } from "../src/vault-scan";

// The listing that feeds the scan can be stale: cloud-sync clients and editors
// change files while a search is running. These tests pin the aggregate budget
// against that, which is what the tool response promises to the caller.

const PER_FILE = 2048;
const TOTAL = 16 * PER_FILE;

function items(count: number, prefix = "note"): { path: string }[] {
  return Array.from({ length: count }, (_, i) => ({ path: `${prefix}/${String(i).padStart(3, "0")}.md` }));
}

describe("aggregate byte budget", () => {
  it("never exceeds the budget even when every read uses its full cap", async () => {
    let reads = 0;
    const summary = await runContentScan(items(200), {
      perFileBytes: PER_FILE,
      maxTotalBytes: TOTAL,
      concurrency: 20,
      deadlineAt: Date.now() + 5_000,
      stat: async () => PER_FILE,
      read: async (): Promise<ScanReadResult> => { reads++; return { bytes: PER_FILE }; },
      onMatch: () => true,
    });

    expect(reads).toBe(TOTAL / PER_FILE);
    expect(summary.bytesScanned).toBe(TOTAL);
    expect(summary.bytesScanned).toBeLessThanOrEqual(TOTAL);
    expect(summary.budgetHit).toBe(true);
    // Every candidate is accounted for: read, or never started, or started and
    // then deferred when the fresh size no longer fitted the budget.
    expect(summary.notStarted + summary.deferredByBudget).toBe(200 - reads);
  });

  it("reserves the worst case, so a file that grew after listing cannot inflate the total", async () => {
    const attempted: string[] = [];
    const summary = await runContentScan(items(40), {
      perFileBytes: PER_FILE,
      maxTotalBytes: TOTAL,
      concurrency: 20,
      deadlineAt: Date.now() + 5_000,
      // Every file was listed as tiny but is now 300 MB on disk.
      stat: async () => 300 * 1024 * 1024,
      read: async (item): Promise<ScanReadResult> => { attempted.push(item.path); return { bytes: 300 * 1024 * 1024 }; },
      onMatch: () => true,
    });

    expect(attempted).toHaveLength(0);
    expect(summary.tooLarge).toBeGreaterThan(0);
    expect(summary.bytesScanned).toBe(0);
  });

  it("tops up the reservation from the fresh size, so a stale listing cannot break the budget", async () => {
    let reads = 0;
    const listedTiny = items(400).map(i => ({ ...i, declaredSize: 10 }));
    const summary = await runContentScan(listedTiny, {
      perFileBytes: PER_FILE,
      maxTotalBytes: TOTAL,
      concurrency: 20,
      deadlineAt: Date.now() + 5_000,
      // Every file was listed as 10 bytes but is really at the cap.
      stat: async () => PER_FILE,
      read: async (): Promise<ScanReadResult> => { reads++; return { bytes: PER_FILE }; },
      onMatch: () => true,
    });

    expect(reads * PER_FILE).toBeLessThanOrEqual(TOTAL);
    expect(summary.bytesScanned).toBeLessThanOrEqual(TOTAL);
    expect(summary.budgetHit).toBe(true);
  });

  it("still scans every small file when the listing is accurate", async () => {
    const accurate = items(100).map(i => ({ ...i, declaredSize: 200 }));
    const summary = await runContentScan(accurate, {
      perFileBytes: PER_FILE,
      maxTotalBytes: TOTAL,
      concurrency: 20,
      deadlineAt: Date.now() + 5_000,
      stat: async () => 200,
      read: async (): Promise<ScanReadResult> => ({ bytes: 200 }),
      onMatch: () => true,
    });

    // 100 x 200 bytes fits the 32 KiB budget: no coverage penalty for a
    // correct listing, the strictness only bites when sizes were stale.
    expect(summary.scannedFiles).toBe(100);
    expect(summary.budgetHit).toBe(false);
    expect(summary.bytesScanned).toBe(100 * 200);
  });

  it("refuses to credit a reader that ignored the cap", async () => {
    const summary = await runContentScan(items(5), {
      perFileBytes: PER_FILE,
      maxTotalBytes: TOTAL,
      concurrency: 5,
      deadlineAt: Date.now() + 5_000,
      stat: async () => 10,
      read: async (): Promise<ScanReadResult> => ({ bytes: 10 * PER_FILE, matches: ["x"] }),
      onMatch: () => true,
    });

    expect(summary.bytesScanned).toBe(0);
    expect(summary.readFailed).toBe(5);
  });
});

describe("concurrency", () => {
  it("never runs more reads at once than the configured limit", async () => {
    let active = 0;
    let peak = 0;
    const summary = await runContentScan(items(120), {
      perFileBytes: 1,
      maxTotalBytes: 10_000,
      concurrency: 6,
      deadlineAt: Date.now() + 5_000,
      stat: async () => 1,
      read: async (): Promise<ScanReadResult> => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        return { bytes: 1 };
      },
      onMatch: () => true,
    });

    expect(peak).toBeLessThanOrEqual(6);
    expect(summary.maxConcurrentReads).toBeLessThanOrEqual(6);
    expect(summary.scannedFiles).toBe(120);
  });
});

describe("stopping conditions", () => {
  it("stops starting work once the deadline passes and reports the rest", async () => {
    const summary = await runContentScan(items(50), {
      perFileBytes: 1,
      maxTotalBytes: 100_000,
      concurrency: 4,
      deadlineAt: Date.now() - 1,
      stat: async () => 1,
      read: async (): Promise<ScanReadResult> => ({ bytes: 1 }),
      onMatch: () => true,
    });

    expect(summary.deadlineHit).toBe(true);
    expect(summary.scannedFiles).toBe(0);
    expect(summary.notStarted + summary.deferredByBudget).toBe(50);
  });

  it("never publishes matches past the caller's limit", async () => {
    let matches = 0;
    const summary = await runContentScan(items(50), {
      perFileBytes: 1,
      maxTotalBytes: 100_000,
      concurrency: 3,
      deadlineAt: Date.now() + 5_000,
      stat: async () => 1,
      read: async (): Promise<ScanReadResult> => ({ bytes: 1, matches: ["hit"] }),
      onMatch: () => { matches++; return matches < 5; },
    });

    // Results that finished while the stop was already decided are discarded,
    // so the caller never sees more than the limit it asked for.
    expect(matches).toBe(5);
    expect(summary.capped).toBe(true);
    expect(summary.notStarted + summary.deferredByBudget).toBeGreaterThan(0);
  });

  it("counts read failures separately instead of hiding them", async () => {
    const summary = await runContentScan(items(10), {
      perFileBytes: 1,
      maxTotalBytes: 100_000,
      concurrency: 5,
      deadlineAt: Date.now() + 5_000,
      stat: async (item) => (item.path.endsWith("003.md") ? null : 1),
      read: async (): Promise<ScanReadResult> => { throw new Error("EIO"); },
      onMatch: () => true,
    });

    expect(summary.readFailed).toBe(10);
    expect(summary.scannedFiles).toBe(0);
  });
});
