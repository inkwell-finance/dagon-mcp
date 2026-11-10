import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface DayTotals {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  cents: number;
  lamports: bigint;
}

/** Default ledger location: the per-user config directory (%APPDATA% on Windows, $XDG_CONFIG_HOME or ~/.config elsewhere). */
export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = process.platform === "win32" ? env.APPDATA || join(homedir(), "AppData", "Roaming") : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "dagon-mcp", "spend-ledger.json");
}

/**
 * Daily purchase totals shared by every server process that uses the same file, so restarting the MCP server (which many
 * clients do per conversation) does not reset the cap. Without a path the totals live only in this process. A ledger that
 * exists but cannot be read fails closed.
 */
export class SpendLedger {
  private memory: DayTotals | null = null;

  private readonly path: string | undefined;
  private readonly now: () => Date;

  constructor(path: string | undefined, now: () => Date = () => new Date()) {
    this.path = path;
    this.now = now;
  }

  private load(): DayTotals {
    const day = this.now().toISOString().slice(0, 10);
    let stored: DayTotals | null = this.memory;
    if (this.path) {
      let raw: string | null = null;
      try {
        raw = readFileSync(this.path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read the spend ledger ${this.path}; refusing to purchase.`);
      }
      stored = raw === null ? null : parse(raw, this.path);
    }
    return stored && stored.day === day ? stored : { day, cents: 0, lamports: 0n };
  }

  private save(totals: DayTotals): void {
    this.memory = totals;
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ day: totals.day, cents: totals.cents, lamports: totals.lamports.toString() }), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Today's totals. */
  totals(): { cents: number; lamports: bigint } {
    const { cents, lamports } = this.load();
    return { cents, lamports };
  }

  /** Adds to today's totals if they stay within both caps; returns false (and changes nothing) otherwise. */
  reserve(cents: number, lamports: bigint, maxCents: number, maxLamports: bigint): boolean {
    const current = this.load();
    if (current.cents + cents > maxCents || current.lamports + lamports > maxLamports) return false;
    this.save({ day: current.day, cents: current.cents + cents, lamports: current.lamports + lamports });
    return true;
  }

  /** Returns a reservation that was never used (same UTC day only; earlier days are already reset). */
  release(cents: number, lamports: bigint): void {
    const current = this.load();
    this.save({ day: current.day, cents: Math.max(0, current.cents - cents), lamports: current.lamports > lamports ? current.lamports - lamports : 0n });
  }
}

function parse(raw: string, path: string): DayTotals {
  try {
    const v = JSON.parse(raw) as { day?: unknown; cents?: unknown; lamports?: unknown };
    if (typeof v.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.day) && Number.isSafeInteger(v.cents) && (v.cents as number) >= 0 && typeof v.lamports === "string" && /^\d+$/.test(v.lamports)) {
      return { day: v.day, cents: v.cents as number, lamports: BigInt(v.lamports) };
    }
  } catch {
    // fall through
  }
  throw new Error(`The spend ledger ${path} is corrupt; refusing to purchase. Delete it only if you are sure of today's spending.`);
}
