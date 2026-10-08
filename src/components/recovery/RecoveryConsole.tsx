import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Countdown } from "./Countdown";
import { Console } from "./Console";
import { NETWORKS, toStroops, toUnits } from "@/lib/stellar/networks";
import { isValidDestination, keypairFromCredential, mnemonicChecksumOk } from "@/lib/stellar/keys";
import {
  RecoveryEngine,
  fetchClaimableBalances,
  fetchFeeStats,
  type BalanceInfo,
  type FeeStats,
  type LogEntry,
  type LogLevel,
} from "@/lib/stellar/engine";
import { diagnose } from "@/lib/stellar/errors";

type Tier = "standard" | "high" | "max" | "custom";

function Panel({ title, step, children }: { title: string; step: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="font-mono text-xs text-primary">{step}</span>
        <h2 className="text-sm font-semibold uppercase tracking-wider">{title}</h2>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function RecoveryConsole() {
  const [networkId, setNetworkId] = useState("pi-mainnet");
  const network = NETWORKS.find((n) => n.id === networkId)!;
  const [extraHorizons, setExtraHorizons] = useState("");
  const [candidates, setCandidates] = useState<BalanceInfo[]>([]);
  const [credential, setCredential] = useState("");
  const [destination, setDestination] = useState("");
  const [rememberDest, setRememberDest] = useState(true);
  const [claimantPk, setClaimantPk] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [fees, setFees] = useState<FeeStats | null>(null);
  const [tier, setTier] = useState<Tier>("high");
  const [customFee, setCustomFee] = useState("0.1");
  const [feeBump, setFeeBump] = useState(true);
  const [feeCredential, setFeeCredential] = useState("");
  const [escalate, setEscalate] = useState(true);
  const [maxFee, setMaxFee] = useState("1");
  const [leadMs, setLeadMs] = useState("1500");
  const [burstMs, setBurstMs] = useState("250");
  const [mergeAccount, setMergeAccount] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const engineRef = useRef<RecoveryEngine | null>(null);
  const idRef = useRef(0);

  const log = useCallback((level: LogLevel, msg: string, extra?: { details?: string[]; hash?: string }) => {
    setLogs((l) => [...l.slice(-500), { id: idRef.current++, at: Date.now(), level, msg, ...extra }]);
  }, []);

  // Restore saved vault destination on load
  useEffect(() => {
    const saved = localStorage.getItem("vaultline.destination");
    if (saved) setDestination(saved);
    if (localStorage.getItem("vaultline.rememberDest") === "0") setRememberDest(false);
  }, []);

  // Persist (or clear) the vault destination whenever it changes
  useEffect(() => {
    if (rememberDest && destination.trim()) localStorage.setItem("vaultline.destination", destination.trim());
    if (!rememberDest) localStorage.removeItem("vaultline.destination");
    localStorage.setItem("vaultline.rememberDest", rememberDest ? "1" : "0");
  }, [destination, rememberDest]);

  const horizons = useMemo(
    () => [network.horizon, ...extraHorizons.split(/[\s,]+/).filter((h) => /^https?:\/\//.test(h))],
    [network, extraHorizons],
  );

  const baseFee = fees?.min ?? (network.id.startsWith("pi") ? 100000 : 100);
  const tierFees: Record<Exclude<Tier, "custom">, number> = {
    standard: Math.max(baseFee, fees?.p50 ?? baseFee),
    high: Math.max(baseFee * 10, fees?.p99 ?? 0),
    max: Math.max(baseFee * 100, (fees?.p99 ?? 0) * 5),
  };
  const perOpFee = tier === "custom" ? toStroops(Number(customFee) || 0) : tierFees[tier];
  const opCount = (mergeAccount ? 3 : 2) + (feeBump ? 1 : 0);

  async function loadBalance() {
    if (!credential.trim()) return;
    setLoading(true);
    try {
      const kp = await keypairFromCredential(credential, network.coinType);
      const pk = kp.publicKey();
      setClaimantPk(pk);
      if (mnemonicChecksumOk(credential) === false) {
        log("warn", "Passphrase checksum failed — deriving anyway. Verify the derived address below matches your wallet before arming.");
      }
      const [list, f] = await Promise.all([
        fetchClaimableBalances(network.horizon, pk, network.nativeCode),
        fetchFeeStats(network.horizon),
      ]);
      setCandidates(list);
      setFees(f);
      if (list.length === 0) {
        setBalance(null);
        log("warn", `No claimable balances found for ${pk.slice(0, 8)}… on ${network.label}.`);
      } else {
        const target = (list.length === 1 ? list[0] : (list.find((b) => b.claimableNow) ?? list[0]))!;
        setBalance(target);
        log("ok", `Found ${list.length} claimable balance${list.length > 1 ? "s" : ""} for ${pk.slice(0, 8)}…`);
        log("ok", `Selected ${target.amount} ${target.assetLabel} · predicate ${target.predicateText}`);
      }
      log("net", `Fee stats: base ${f.min} · p50 ${f.p50} · p99 ${f.p99} stroops · capacity ${f.capacity}`);
    } catch (e) {
      const d = diagnose(e);
      log("error", `Load failed: ${d.title}`, { details: d.details });
    } finally {
      setLoading(false);
    }
  }

  // Auto-discover balances as soon as a valid key/passphrase is entered
  useEffect(() => {
    setClaimantPk(null);
    setCandidates([]);
    setBalance(null);
    if (!credential.trim()) return;
    const t = setTimeout(() => {
      keypairFromCredential(credential, network.coinType)
        .then(() => loadBalance())
        .catch(() => {}); // incomplete/invalid input — wait for more typing
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credential, networkId]);

  async function arm() {
    if (!balance) return;
    if (!isValidDestination(destination)) return log("error", "Vault destination must be a valid G… or M… address.");
    setResult(null);
    setRunning(true);
    try {
      const claimant = await keypairFromCredential(credential, network.coinType);
      const feeSource = feeBump && feeCredential.trim() ? await keypairFromCredential(feeCredential, network.coinType) : undefined;
      if (destination.trim() === claimant.publicKey()) throw new Error("Destination equals claimant account.");
      const engine = new RecoveryEngine(
        {
          network,
          horizons,
          balanceId: balance.id,
          claimant,
          destination: destination.trim(),
          perOpFee,
          baseFee,
          feeBump,
          feeSource,
          escalate,
          maxPerOpFee: toStroops(Number(maxFee) || 1),
          leadMs: Number(leadMs) || 0,
          burstIntervalMs: Math.max(50, Number(burstMs) || 250),
          windowSec: 600,
          mergeAccount,
        },
        log,
      );
      engineRef.current = engine;
      log("warn", `ARMED. Target unlock ${balance.unlockAt ? new Date(balance.unlockAt * 1000).toISOString() : "now"}`);
      const r = await engine.run(balance);
      setResult(r);
    } catch (e) {
      if ((e as Error).name === "AbortError") log("warn", "Disarmed by user.");
      else {
        const d = diagnose(e);
        log("error", d.title, { details: d.details });
      }
    } finally {
      setRunning(false);
      engineRef.current = null;
    }
  }

  const credValid = credential.trim().length > 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b pb-6">
        <div>
          <div className="font-mono text-xs text-primary">// TIME-LOCK RECOVERY ENGINE</div>
          <h1 className="text-3xl font-bold tracking-tight">Vaultline</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            Claim + sweep in one atomic envelope, pre-signed and burst-submitted to multiple endpoints at the unlock
            second. Keys never leave this browser tab.
          </p>
        </div>
        <Select value={networkId} onValueChange={(v) => { setNetworkId(v); setBalance(null); }}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {NETWORKS.map((n) => <SelectItem key={n.id} value={n.id}>{n.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-6">
          <Panel step="01" title="Target & credentials">
            <div className="space-y-1.5">
              <Label>Claimant secret key or 24-word passphrase</Label>
              <Textarea
                className="font-mono text-xs"
                rows={2}
                autoComplete="off"
                spellCheck={false}
                placeholder="S… or mnemonic words"
                value={credential}
                onChange={(e) => { setCredential(e.target.value); setClaimantPk(null); }}
              />
              {claimantPk && <p className="font-mono text-xs text-muted-foreground">→ {claimantPk}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Vault destination (G… or muxed M…)</Label>
              <Input className="font-mono text-xs" value={destination} onChange={(e) => setDestination(e.target.value)} />
              {destination && !isValidDestination(destination) && <p className="text-xs text-destructive">Invalid address</p>}
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Remember this address on this device</Label>
                <Switch checked={rememberDest} onCheckedChange={setRememberDest} />
              </div>
            </div>
            <Button onClick={loadBalance} disabled={!credential.trim() || loading} variant="secondary" className="w-full">
              {loading ? "Scanning network for your balances…" : "Refresh balances"}
            </Button>
            {candidates.length > 1 && (
              <div className="space-y-1.5">
                <Label>Select balance to recover</Label>
                <div className="max-h-44 space-y-1 overflow-y-auto">
                  {candidates.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setBalance(c)}
                      className={`w-full rounded-md border px-3 py-2 text-left font-mono text-xs transition-colors ${
                        balance?.id === c.id ? "border-primary bg-primary/10" : "bg-background hover:border-primary/50"
                      }`}
                    >
                      <div className="flex justify-between">
                        <span className="text-foreground">{c.amount} {c.assetLabel}</span>
                        <span className={c.claimableNow ? "text-success" : "text-warning"}>
                          {c.claimableNow ? "CLAIMABLE" : c.unlockAt ? new Date(c.unlockAt * 1000).toISOString() : "LOCKED"}
                        </span>
                      </div>
                      <div className="truncate text-muted-foreground">{c.id}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {balance && (
              <dl className="grid grid-cols-2 gap-3 rounded-md border bg-background p-3 font-mono text-xs">
                <div><dt className="text-muted-foreground">Amount</dt><dd className="text-base text-foreground">{balance.amount} {balance.assetLabel}</dd></div>
                <div><dt className="text-muted-foreground">Status</dt><dd className={balance.claimableNow ? "text-success" : "text-warning"}>{balance.claimableNow ? "CLAIMABLE NOW" : balance.unlockAt ? "LOCKED" : "NEVER CLAIMABLE"}</dd></div>
                <div className="col-span-2"><dt className="text-muted-foreground">Predicate</dt><dd className="break-all">{balance.predicateText}</dd></div>
                {balance.expiresAt && <div className="col-span-2"><dt className="text-muted-foreground">Window closes</dt><dd>{new Date(balance.expiresAt * 1000).toISOString()}</dd></div>}
              </dl>
            )}
          </Panel>

          <Panel step="02" title="Priority fee">
            <div className="grid grid-cols-4 gap-2">
              {(["standard", "high", "max", "custom"] as Tier[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTier(t)}
                  className={`rounded-md border p-2 text-left transition ${tier === t ? "border-primary bg-primary/10" : "hover:bg-accent"}`}
                >
                  <div className="text-xs font-semibold uppercase">{t}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {t === "custom" ? "manual" : `${toUnits(tierFees[t as Exclude<Tier, "custom">])}/op`}
                  </div>
                </button>
              ))}
            </div>
            {tier === "custom" && (
              <div className="space-y-1.5">
                <Label>Custom fee per operation ({network.nativeCode})</Label>
                <Input type="number" step="0.01" value={customFee} onChange={(e) => setCustomFee(e.target.value)} />
              </div>
            )}
            <div className="rounded-md border bg-background p-3 font-mono text-xs">
              Max total fee: <span className="text-primary">{toUnits(perOpFee * opCount)} {network.nativeCode}</span>{" "}
              <span className="text-muted-foreground">({perOpFee} stroops × {opCount} ops · standard is {toUnits(baseFee * 2)})</span>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Fee-bump envelope</Label>
                <p className="text-xs text-muted-foreground">Outer envelope carries the priority bid; enables 10× replace-by-fee.</p>
              </div>
              <Switch checked={feeBump} onCheckedChange={setFeeBump} />
            </div>
            {feeBump && (
              <div className="space-y-1.5">
                <Label>Fee payer key (optional, defaults to claimant)</Label>
                <Input type="password" className="font-mono text-xs" placeholder="S… of a funded fee account" value={feeCredential} onChange={(e) => setFeeCredential(e.target.value)} />
              </div>
            )}
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-escalate on congestion</Label>
                <p className="text-xs text-muted-foreground">Rebid when fee is too low or tx stalls in the queue.</p>
              </div>
              <Switch checked={escalate} onCheckedChange={setEscalate} />
            </div>
            {escalate && (
              <div className="space-y-1.5">
                <Label>Escalation cap per op ({network.nativeCode})</Label>
                <Input type="number" step="0.1" value={maxFee} onChange={(e) => setMaxFee(e.target.value)} />
              </div>
            )}
          </Panel>

          <Panel step="03" title="Execution tuning">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Fire lead (ms before unlock)</Label><Input type="number" value={leadMs} onChange={(e) => setLeadMs(e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Burst interval (ms)</Label><Input type="number" value={burstMs} onChange={(e) => setBurstMs(e.target.value)} /></div>
            </div>
            <div className="space-y-1.5">
              <Label>Additional endpoints (parallel broadcast)</Label>
              <Textarea rows={2} className="font-mono text-xs" placeholder="https://your-own-horizon.example" value={extraHorizons} onChange={(e) => setExtraHorizons(e.target.value)} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Also merge claimant account into vault</Label>
                <p className="text-xs text-muted-foreground">Sweeps the remaining native balance & reserves. Fails if the account has trustlines.</p>
              </div>
              <Switch checked={mergeAccount} onCheckedChange={setMergeAccount} />
            </div>
          </Panel>
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <section className="rounded-lg border bg-card p-5">
            <Countdown target={balance?.unlockAt ?? null} label="Time to unlock" />
            <div className="mt-5 flex gap-2">
              {!running ? (
                <Button size="lg" className="flex-1 font-semibold" disabled={!balance || !credValid || !isValidDestination(destination)} onClick={arm}>
                  {balance?.claimableNow ? "Execute now" : "Arm & auto-fire at unlock"}
                </Button>
              ) : (
                <Button size="lg" variant="destructive" className="flex-1" onClick={() => engineRef.current?.stop()}>
                  Disarm
                </Button>
              )}
            </div>
            {running && <p className="mt-2 text-xs text-warning">Keep this tab open and in the foreground until execution completes.</p>}
            {result && (
              <div className="mt-4 rounded-md border border-success/50 bg-success/10 p-3 font-mono text-xs">
                <div className="text-success">✓ Funds swept · ledger {result.ledger}</div>
                <a className="break-all underline" href={network.explorerTx(result.hash)} target="_blank" rel="noreferrer">{result.hash}</a>
              </div>
            )}
          </section>
          <section className="rounded-lg border bg-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider">Execution console</h2>
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setLogs([])}>clear</button>
            </div>
            <Console logs={logs} explorer={network.explorerTx} />
          </section>
        </div>
      </div>
      <footer className="mt-10 text-center text-xs text-muted-foreground">
        Signing happens locally with your keys held only in memory. Test on testnet first.
      </footer>
    </div>
  );
}

