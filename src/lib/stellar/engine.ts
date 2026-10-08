import { Buffer } from "buffer";
import {
  Asset,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { claimWindow, describe, type HorizonPredicate } from "./predicate";
import { diagnose, txCode } from "./errors";
import type { NetworkPreset } from "./networks";

export type LogLevel = "info" | "ok" | "warn" | "error" | "net";
export type LogEntry = { id: number; at: number; level: LogLevel; msg: string; details?: string[]; hash?: string };
export type Logger = (level: LogLevel, msg: string, extra?: { details?: string[]; hash?: string }) => void;

export type BalanceInfo = {
  id: string;
  amount: string;
  asset: Asset;
  assetLabel: string;
  sponsor?: string | undefined;
  claimant: string;
  predicateText: string;
  unlockAt: number | null;
  expiresAt: number | null;
  claimableNow: boolean;
};

export type FeeStats = { min: number; p50: number; p90: number; p99: number; capacity: string };

export type EngineConfig = {
  network: NetworkPreset;
  horizons: string[];
  balanceId: string;
  claimant: Keypair;
  destination: string;
  perOpFee: number; // stroops
  baseFee: number; // network minimum per op (stroops)
  feeBump: boolean;
  feeSource?: Keypair | undefined;
  escalate: boolean;
  maxPerOpFee: number; // stroops cap for escalation
  leadMs: number; // start firing this many ms before unlock
  burstIntervalMs: number;
  windowSec: number; // maxTime = unlock + windowSec
  mergeAccount: boolean;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new DOMException("aborted", "AbortError"));
    });
  });

const assetFromString = (s: string) => {
  if (s === "native") return Asset.native();
  const [code, issuer] = s.split(":");
  return new Asset(code ?? "", issuer);
};

export async function fetchBalance(horizon: string, id: string, claimant: string, nativeCode: string): Promise<BalanceInfo> {
  const server = new Horizon.Server(horizon);
  const cb = await server.claimableBalances().claimableBalance(id.trim()).call();
  const createdAt = Math.floor(Date.parse((cb as unknown as { last_modified_time?: string }).last_modified_time ?? new Date().toISOString()) / 1000);
  const entry = cb.claimants.find((c) => c.destination === claimant) ?? cb.claimants[0];
  if (!entry) throw new Error("Balance has no claimants");
  const pred = entry.predicate as unknown as HorizonPredicate;
  const w = claimWindow(pred, createdAt, Math.floor(Date.now() / 1000));
  const asset = assetFromString(cb.asset);
  return {
    id: cb.id,
    amount: cb.amount,
    asset,
    assetLabel: asset.isNative() ? nativeCode : `${asset.getCode()}`,
    sponsor: cb.sponsor,
    claimant: entry.destination,
    predicateText: describe(pred),
    ...w,
  };
}

/** List every claimable balance where `claimant` is a claimant. */
export async function fetchClaimableBalances(horizon: string, claimant: string, nativeCode: string): Promise<BalanceInfo[]> {
  const server = new Horizon.Server(horizon);
  const page = await server.claimableBalances().claimant(claimant).limit(200).order("desc").call();
  const now = Math.floor(Date.now() / 1000);
  return page.records.flatMap((cb): BalanceInfo[] => {
    const createdAt = Math.floor(
      Date.parse((cb as unknown as { last_modified_time?: string }).last_modified_time ?? new Date().toISOString()) / 1000,
    );
    const entry = cb.claimants.find((c) => c.destination === claimant) ?? cb.claimants[0];
    if (!entry) return [];
    const pred = entry.predicate as unknown as HorizonPredicate;
    const w = claimWindow(pred, createdAt, now);
    const asset = assetFromString(cb.asset);
    return [{
      id: cb.id,
      amount: cb.amount,
      asset,
      assetLabel: asset.isNative() ? nativeCode : `${asset.getCode()}`,
      ...(cb.sponsor ? { sponsor: cb.sponsor } : {}),
      claimant: entry.destination,
      predicateText: describe(pred),
      ...w,
    }];
  });
}

export async function fetchFeeStats(horizon: string): Promise<FeeStats> {
  const s = await new Horizon.Server(horizon).feeStats();
  return {
    min: Number(s.last_ledger_base_fee),
    p50: Number(s.fee_charged.p50),
    p90: Number(s.fee_charged.p90),
    p99: Number(s.fee_charged.p99),
    capacity: s.ledger_capacity_usage,
  };
}

/** Estimate local-vs-network clock offset (ms) from the latest closed ledger. */
export async function measureLatency(horizon: string) {
  const t0 = performance.now();
  const r = await fetch(`${horizon.replace(/\/$/, "")}/ledgers?order=desc&limit=1`, { cache: "no-store" });
  const rtt = performance.now() - t0;
  const j = await r.json();
  const closedAt = Date.parse(j._embedded.records[0].closed_at);
  return { rtt, lastClose: closedAt, ledger: j._embedded.records[0].sequence as number };
}

type SubmitResult =
  | { ok: true; hash: string; ledger: number; horizon: string }
  | { ok: false; code?: string | undefined; err: unknown; status?: number | undefined; horizon: string };

async function rawSubmit(horizon: string, xdr: string, signal: AbortSignal): Promise<SubmitResult> {
  try {
    const r = await fetch(`${horizon.replace(/\/$/, "")}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `tx=${encodeURIComponent(xdr)}`,
      signal,
      keepalive: true,
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, hash: data.hash, ledger: data.ledger, horizon };
    const err = { response: { status: r.status, data } };
    return { ok: false, code: txCode(err), err, status: r.status, horizon };
  } catch (err) {
    return { ok: false, err, horizon };
  }
}

export class RecoveryEngine {
  private abort = new AbortController();
  private servers: Horizon.Server[];
  constructor(
    private cfg: EngineConfig,
    private log: Logger,
  ) {
    this.servers = cfg.horizons.map((h) => new Horizon.Server(h));
  }

  stop() {
    this.abort.abort();
  }

  private get primary() {
    return this.servers[0]!;
  }

  private async build(balance: BalanceInfo, unlockAt: number, perOpFee: number): Promise<{ tx: Transaction | FeeBumpTransaction; hash: string }> {
    const { cfg } = this;
    const account = await this.primary.loadAccount(cfg.claimant.publicKey());
    const opCount = cfg.mergeAccount ? 3 : 2;
    const innerFee = cfg.feeBump ? cfg.baseFee : perOpFee; // inner bid minimal when outer fee-bump carries priority
    const builder = new TransactionBuilder(account, {
      fee: String(innerFee),
      networkPassphrase: cfg.network.passphrase,
      timebounds: { minTime: unlockAt, maxTime: unlockAt + cfg.windowSec },
    })
      .addOperation(Operation.claimClaimableBalance({ balanceId: balance.id }))
      .addOperation(Operation.payment({ destination: cfg.destination, asset: balance.asset, amount: balance.amount }));
    if (cfg.mergeAccount) builder.addOperation(Operation.accountMerge({ destination: cfg.destination }));
    const inner = builder.build();
    inner.sign(cfg.claimant);
    this.log("info", `Built atomic envelope seq=${inner.sequence} ops=${opCount} minTime=${unlockAt}`);
    if (!cfg.feeBump) return { tx: inner, hash: Buffer.from(inner.hash()).toString("hex") };
    const feeKp = cfg.feeSource ?? cfg.claimant;
    const fb = TransactionBuilder.buildFeeBumpTransaction(feeKp, String(perOpFee), inner, cfg.network.passphrase);
    fb.sign(feeKp);
    this.log("info", `Wrapped in fee-bump: ${perOpFee} stroops/op, total max ${(perOpFee * (opCount + 1)) / 1e7}`);
    return { tx: fb, hash: Buffer.from(fb.hash()).toString("hex") };
  }

  private async pollHash(hash: string, until: number) {
    while (Date.now() < until && !this.abort.signal.aborted) {
      for (const s of this.servers) {
        try {
          const r = await s.transactions().transaction(hash).call();
          return r;
        } catch {
          /* not yet */
        }
      }
      await sleep(1000, this.abort.signal);
    }
    return null;
  }

  async run(balance: BalanceInfo): Promise<{ hash: string; ledger: number } | null> {
    const { cfg, log } = this;
    const signal = this.abort.signal;
    const unlockAt = Math.max(balance.unlockAt ?? 0, Math.floor(Date.now() / 1000) - 5);

    // Preflight
    log("info", `Preflight: ${cfg.horizons.length} endpoint(s), claimant ${cfg.claimant.publicKey().slice(0, 6)}…`);
    await this.primary.loadAccount(cfg.claimant.publicKey());
    if (cfg.destination.startsWith("G")) {
      try {
        const dest = await this.primary.loadAccount(cfg.destination);
        if (!balance.asset.isNative()) {
          const has = dest.balances.some(
            (b) => "asset_code" in b && b.asset_code === balance.asset.getCode() && b.asset_issuer === balance.asset.getIssuer(),
          );
          if (!has) log("warn", "Destination has no trustline for this asset — payment will fail (op_no_trust).");
        }
        log("ok", "Destination account verified on-chain.");
      } catch {
        log("warn", "Destination account not found on-chain — payment will fail with op_no_destination.");
      }
    }

    // Wait phase with periodic latency/ledger sampling
    const fireAt = unlockAt * 1000 - cfg.leadMs;
    let lastSample = 0;
    while (Date.now() < fireAt - 8000) {
      if (Date.now() - lastSample > 30000) {
        lastSample = Date.now();
        for (const h of cfg.horizons) {
          measureLatency(h)
            .then((m) => log("net", `${new URL(h).host} rtt=${m.rtt.toFixed(0)}ms ledger=${m.ledger}`))
            .catch(() => log("warn", `${h} unreachable`));
        }
      }
      await sleep(Math.min(1000, fireAt - 8000 - Date.now()), signal);
    }

    // Pre-sign ~8s before with fresh sequence so firing is pure I/O.
    let perOpFee = cfg.perOpFee;
    let built = await this.build(balance, unlockAt, perOpFee);
    log("info", `Pre-signed. Hash ${built.hash.slice(0, 12)}…`, { hash: built.hash });
    // warm TCP/TLS connections
    await Promise.all(cfg.horizons.map((h) => fetch(h, { cache: "no-store" }).catch(() => null)));
    while (Date.now() < fireAt) await sleep(Math.max(0, Math.min(50, fireAt - Date.now())), signal);

    log("warn", `FIRING burst at T${((Date.now() - unlockAt * 1000) / 1000).toFixed(2)}s`);
    const deadline = (unlockAt + cfg.windowSec) * 1000;
    let attempt = 0;
    while (Date.now() < deadline && !signal.aborted) {
      attempt++;
      const xdr = built.tx.toXDR();
      const results = await Promise.all(cfg.horizons.map((h) => rawSubmit(h, xdr, signal)));
      const win = results.find((r) => r.ok) as Extract<SubmitResult, { ok: true }> | undefined;
      if (win) {
        log("ok", `INCLUDED in ledger ${win.ledger} via ${new URL(win.horizon).host}`, { hash: win.hash });
        return { hash: win.hash, ledger: win.ledger };
      }
      const codes = results.map((r) => (r.ok ? "ok" : (r.code ?? `http${r.status ?? "-"}`)));
      const first = results.find((r) => !r.ok) as Extract<SubmitResult, { ok: false }>;
      if (codes.every((c) => c === "tx_too_early")) {
        if (attempt % 10 === 1) log("info", `#${attempt} tx_too_early — ledger not yet past unlock, re-firing`);
        await sleep(cfg.burstIntervalMs, signal);
        continue;
      }
      if (codes.some((c) => c === "http504" || c === "tx_duplicate" || c === "duplicate")) {
        log("net", `#${attempt} pending in mempool, polling hash…`);
        const r = await this.pollHash(built.hash, Date.now() + 15000);
        if (r) {
          if (r.successful) {
            log("ok", `INCLUDED in ledger ${r.ledger_attr}`, { hash: built.hash });
            return { hash: built.hash, ledger: r.ledger_attr };
          }
          log("error", "Transaction landed but failed.", { hash: built.hash });
          return null;
        }
        if (cfg.feeBump && cfg.escalate) {
          perOpFee = Math.min(perOpFee * 10, cfg.maxPerOpFee);
          log("warn", `Escalating fee-bump to ${perOpFee} stroops/op (10x replace-by-fee)`);
          built = await this.build(balance, unlockAt, perOpFee);
        }
        continue;
      }
      const d = diagnose(first.err);
      log("error", `#${attempt} ${codes.join(" | ")}`, { details: d.details });
      if (codes.includes("tx_insufficient_fee") && cfg.escalate) {
        const next = Math.min(perOpFee * (cfg.feeBump ? 10 : 2), cfg.maxPerOpFee);
        if (next === perOpFee) {
          log("error", "Fee cap reached. Aborting.");
          return null;
        }
        perOpFee = next;
        log("warn", `Raising fee to ${perOpFee} stroops/op`);
        built = await this.build(balance, unlockAt, perOpFee);
        continue;
      }
      if (codes.includes("tx_bad_seq") || codes.includes("tx_failed")) {
        const ops = (first.err as { response?: { data?: { extras?: { result_codes?: { operations?: string[] } } } } })
          .response?.data?.extras?.result_codes?.operations;
        if (ops?.[0] === "op_does_not_exist") {
          log("error", "Balance no longer exists — it was claimed by another transaction.");
          return null;
        }
        if (ops?.[0] === "op_cannot_claim") {
          log("warn", "Predicate not yet satisfied in applied ledger; rebuilding with fresh sequence.");
        }
        built = await this.build(balance, unlockAt, perOpFee);
        await sleep(cfg.burstIntervalMs, signal);
        continue;
      }
      if (!first.code) {
        await sleep(cfg.burstIntervalMs, signal);
        continue; // network error: keep hammering
      }
      return null;
    }
    log("error", "Execution window closed without inclusion.");
    return null;
  }
}
