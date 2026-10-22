import "@/lib/stellar/polyfill";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Clock, Fingerprint, Gauge, History as HistoryIcon, PanelLeftClose, PanelLeftOpen, Radio, RefreshCw, ShieldCheck, SlidersHorizontal, Timer, Trash2, XCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Countdown } from "./Countdown";
import { Console } from "./Console";
import { History } from "./History";
import { historyPayload, useExecutionHistory } from "@/lib/history";
import { balanceStatus, configuredEndpoints, type ExecutionResult, type TimingMode } from "@/lib/stellar/execution";
import { setPreciseInterval } from "@/lib/stellar/timer";
import { CUSTOM_FEE_DEFAULT, CUSTOM_FEE_MAX, ENDPOINT_HINTS, ESCALATION_CAP_DEFAULT, FEE_TIERS, NETWORKS, toStroops, toUnits } from "@/lib/stellar/networks";
import { holdAwake } from "@/lib/stellar/timer";
import { isValidDestination, keypairFromCredential, mnemonicChecksumOk } from "@/lib/stellar/keys";
import {
  RecoveryEngine,
  fetchBalance,
  fetchClaimableBalances,
  fetchFeeStats,
  type BalanceInfo,
  type FeeStats,
  type LogEntry,
  type LogLevel,
} from "@/lib/stellar/engine";
import { diagnose } from "@/lib/stellar/errors";

type Tier = keyof typeof FEE_TIERS | "custom";

type Phase = "idle" | "scheduled" | "submitting" | "success" | "failed" | "dry_run" | "unconfirmed";

const PHASE_META: Record<Exclude<Phase, "idle">, { label: string; hint: string; icon: typeof Clock; classes: string }> = {
  scheduled: {
    label: "Scheduled",
    hint: "Armed — waiting for the unlock second",
    icon: Clock,
    classes: "border-info/50 bg-info/10 text-info",
  },
  submitting: {
    label: "Submitting",
    hint: "Firing transactions at the network",
    icon: Radio,
    classes: "border-warning/50 bg-warning/10 text-warning",
  },
  success: {
    label: "Successful",
    hint: "Funds swept to your vault",
    icon: CheckCircle2,
    classes: "border-success/50 bg-success/10 text-success",
  },
  dry_run: { label: "Dry run complete", hint: "Built and signed locally — nothing submitted", icon: ShieldCheck, classes: "border-info/50 bg-info/10 text-info" },
  unconfirmed: { label: "Unconfirmed", hint: "Verify the transaction in the explorer", icon: Clock, classes: "border-info/50 bg-info/10 text-info" },
  failed: {
    label: "Failed",
    hint: "No successful sweep — see result code in the log",
    icon: XCircle,
    classes: "border-destructive/50 bg-destructive/10 text-destructive",
  },
};

function PhaseBanner({ phase }: { phase: Phase }) {
  if (phase === "idle") return null;
  const meta = PHASE_META[phase];
  const Icon = meta.icon;
  return (
    <div role="status" className={`mb-3 flex items-center gap-3 rounded-md border px-3 py-2.5 ${meta.classes}`}>
      <Icon className={`size-5 shrink-0 ${phase === "submitting" ? "animate-pulse" : ""}`} />
      <div className="min-w-0">
        <div className="font-display text-sm font-semibold uppercase tracking-wide">{meta.label}</div>
        <div className="truncate text-xs opacity-80">{meta.hint}</div>
      </div>
    </div>
  );
}

function Panel({ title, step, hidden, children }: { title: string; step: string; hidden: boolean; children: React.ReactNode }) {
  return (
    <section hidden={hidden} id={`settings-${step}`} role="tabpanel" className="settings-panel">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-xs text-primary">{step} /</span>
        <h2 className="font-display text-xl font-semibold">{title}</h2>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function RecoveryConsole() {
  const [activeSection, setActiveSection] = useState("01");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [networkId, setNetworkId] = useState("pi-mainnet");
  const network = useMemo(() => {
    const preset = NETWORKS.find((n) => n.id === networkId) ?? NETWORKS[0];
    if (!preset) throw new Error("Network presets missing");
    return preset;
  }, [networkId]);
  const [extraHorizons, setExtraHorizons] = useState("");
  const [candidates, setCandidates] = useState<BalanceInfo[]>([]);
  const [credential, setCredential] = useState("");
  const [destination, setDestination] = useState("");
  const [rememberDest, setRememberDest] = useState(true);
  const [claimantPk, setClaimantPk] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [fees, setFees] = useState<FeeStats | null>(null);
  const [tier, setTier] = useState<Tier>("high");
  const [customFee, setCustomFee] = useState(String(CUSTOM_FEE_DEFAULT));
  const [feeBump, setFeeBump] = useState(true);
  const [feeCredential, setFeeCredential] = useState("");
  const [escalate, setEscalate] = useState(true);
  const [maxFee, setMaxFee] = useState(String(ESCALATION_CAP_DEFAULT));
  const [directId, setDirectId] = useState("");
  const [leadMs, setLeadMs] = useState("1500");
  const [burstMs, setBurstMs] = useState("80");
  const [timingMode, setTimingMode] = useState<TimingMode>("fixed");
  const [dryRun, setDryRun] = useState(false);
  const [now, setNow] = useState(0);
  const history = useExecutionHistory();
  const scanRef = useRef(0);
  const [mergeAccount, setMergeAccount] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const engineRef = useRef<RecoveryEngine | null>(null);
  const cancelledRef = useRef(false);
  const idRef = useRef(0);

  const log = useCallback((level: LogLevel, msg: string, extra?: { details?: string[]; hash?: string }) => {
    if (msg.startsWith("FIRING")) setPhase("submitting");
    setLogs((l) => [...l.slice(-500), { id: idRef.current++, at: Date.now(), level, msg, ...extra }]);
  }, []);

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    return setPreciseInterval(() => setNow(Math.floor(Date.now() / 1000)), 250);
  }, []);
  useEffect(() => () => engineRef.current?.stop(), []);

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
    () => configuredEndpoints(network.horizon, extraHorizons),
    [network, extraHorizons],
  );

  const baseFee = fees?.min ?? (network.id.startsWith("pi") ? 100000 : 100);
  const tierFees: Record<Exclude<Tier, "custom">, number> = {
    standard: Math.max(baseFee, toStroops(FEE_TIERS.standard.perOp)),
    high: Math.max(baseFee, toStroops(FEE_TIERS.high.perOp)),
    ultra: Math.max(baseFee, toStroops(FEE_TIERS.ultra.perOp)),
  };
  const customUnits = Math.min(CUSTOM_FEE_MAX, Math.max(0, Number(customFee) || 0));
  const perOpFee = tier === "custom" ? Math.max(baseFee, toStroops(customUnits)) : tierFees[tier];
  const opCount = (mergeAccount ? 3 : 2) + (feeBump ? 1 : 0);

  async function loadBalance() {
    if (!credential.trim() || running) return;
    const scan = ++scanRef.current;
    setLoading(true);
    try {
      const kp = await keypairFromCredential(credential, network.coinType);
      if (scan !== scanRef.current) return;
      const pk = kp.publicKey();
      setClaimantPk(pk);
      if (mnemonicChecksumOk(credential) === false) {
        log("warn", "Passphrase checksum failed — deriving anyway. Verify the derived address below matches your wallet before arming.");
      }
      const id = directId.trim();
      const [list, f] = await Promise.all([
        id
          ? fetchBalance(network.horizon, id, pk, network.nativeCode).then((b) => [b])
          : fetchClaimableBalances(network.horizon, pk, network.nativeCode),
        fetchFeeStats(network.horizon).catch(() => null),
      ]);
      if (scan !== scanRef.current) return;
      setCandidates(list);
      setFees(f);
      if (list.length === 0) {
        setBalance(null);
        log("warn", `No claimable balances found for ${pk.slice(0, 8)}… on ${network.label}.`);
      } else {
        const target = list.find((b) => b.id === balance?.id) ?? list.find((b) => b.claimableNow) ?? list[0];
        if (!target) return;
        setBalance(target);
        log("ok", `Found ${list.length} claimable balance${list.length > 1 ? "s" : ""} for ${pk.slice(0, 8)}…`);
        log("ok", `Selected ${target.amount} ${target.assetLabel} · predicate ${target.predicateText}`);
      }
      if (f) log("net", `Fee stats: base ${f.min} · p50 ${f.p50} · p99 ${f.p99} stroops · capacity ${f.capacity}`);
    } catch (e) {
      if (scan !== scanRef.current) return;
      setCandidates([]);
      setBalance(null);
      const d = diagnose(e);
      log("error", `Load failed: ${d.title}`, { details: d.details });
    } finally {
      if (scan === scanRef.current) setLoading(false);
    }
  }

  // Auto-discover balances as soon as a valid key/passphrase is entered
  useEffect(() => {
    scanRef.current++;
    setLoading(false);
    setClaimantPk(null);
    setCandidates([]);
    setBalance(null);
    setFees(null);
    if (!credential.trim()) return;
    const t = setTimeout(() => {
      keypairFromCredential(credential, network.coinType)
        .then(() => loadBalance())
        .catch(() => {}); // incomplete/invalid input — wait for more typing
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credential, networkId, directId]);

  async function arm() {
    if (!balance || running) return;
    if (!isValidDestination(destination)) return log("error", "Vault destination must be a valid G… or M… address.");
    setResult(null);
    setPhase("scheduled");
    setRunning(true);
    cancelledRef.current = false;
    let release = () => {};
    const run = { networkId: network.id, balanceId: balance.id, amount: balance.amount, assetLabel: balance.assetLabel, unlockAt: balance.unlockAt, dryRun };
    let historyId: string | null = null;
    const savePromise = history.userId ? history.save(historyPayload(run, null)) : Promise.resolve(null);
    const updateHistory = async (payload: ReturnType<typeof historyPayload>) => {
      historyId = historyId ?? await savePromise;
      if (historyId) await history.update(historyId, payload);
    };
    try {
      release = await holdAwake();
      log("info", "Wake lock requested; keep this tab open.");
      const claimant = await keypairFromCredential(credential, network.coinType);
      const feeSource = feeBump && feeCredential.trim() ? await keypairFromCredential(feeCredential, network.coinType) : undefined;
      if (cancelledRef.current) throw new DOMException("Cancelled", "AbortError");
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
          maxPerOpFee: Math.max(perOpFee, toStroops(Number(maxFee) || ESCALATION_CAP_DEFAULT)),
          leadMs: Number(leadMs) || 0,
          burstIntervalMs: Math.max(50, Number(burstMs) || 80),
          windowSec: 600,
          mergeAccount,
          timingMode,
          dryRun,
        },
        log,
      );
      engineRef.current = engine;
      log("warn", `ARMED. Target unlock ${balance.unlockAt ? new Date(balance.unlockAt * 1000).toISOString() : "now"}`);
      const r = await engine.run(balance);
      setResult(r);
    setPhase(r.result === "successful" ? "success" : r.result);
      await updateHistory(historyPayload(run, r));
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        log("warn", "Disarmed by user.");
        setPhase("unconfirmed");
        log("warn", "Cancellation stops future broadcasts, not submissions already accepted. Verify the explorer before retrying.");
        await updateHistory({ ...historyPayload(run, null), result: "cancelled", result_code: "cancelled_verify_pending" });
      } else {
        const d = diagnose(e);
        log("error", d.title, { details: d.details });
        setPhase("failed");
        await updateHistory({ ...historyPayload(run, null), result: "failed", result_code: d.title });
      }
    } finally {
      release();
      setRunning(false);
      engineRef.current = null;
    }
  }

  const credValid = credential.trim().length > 0;

  return (
    <div className={`recovery-workspace ${railCollapsed ? "rail-collapsed" : ""}`}>
      <aside className="workspace-rail">
        <a href="/" className="rail-brand" aria-label="Vaultline home"><ShieldCheck className="size-7 text-primary" /><span className="font-display font-semibold">Vaultline</span></a>
        <div className="rail-caption">Recovery workspace</div>
        <nav className="rail-navigation" aria-label="Recovery settings" role="tablist" aria-orientation="vertical">
          {[{ id: "01", label: "Credentials", icon: Fingerprint }, { id: "02", label: "Priority", icon: Gauge }, { id: "03", label: "Tuning", icon: SlidersHorizontal }, { id: "04", label: "History", icon: HistoryIcon }].map((item) => (
            <Button key={item.id} variant="ghost" role="tab" aria-selected={activeSection === item.id} aria-controls={`settings-${item.id}`} title={item.label} onClick={() => setActiveSection(item.id)} className={`rail-tab ${activeSection === item.id ? "rail-tab-active" : ""}`}>
              <item.icon /><span>{item.label}</span><span className="rail-number">{item.id}</span>
            </Button>
          ))}
        </nav>
        <div className="rail-bottom"><ShieldCheck className="size-4 text-primary" /><span>Local signing</span></div>
      </aside>
      <div className="workspace-body">
      <header className="workspace-header">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="icon" className="rail-toggle" title={railCollapsed ? "Expand navigation" : "Collapse navigation"} aria-label={railCollapsed ? "Expand navigation" : "Collapse navigation"} onClick={() => setRailCollapsed(!railCollapsed)}>{railCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button>
          <div><h1 className="font-display text-xl font-semibold">Vaultline</h1><p className="text-xs text-muted-foreground">Time-locked asset recovery</p></div>
        </div>
        <Select disabled={running} value={networkId} onValueChange={(v) => { setNetworkId(v); setBalance(null); }}>
          <SelectTrigger aria-label="Network" className="w-44 shrink-0"><SelectValue /></SelectTrigger>
          <SelectContent>
            {NETWORKS.map((n) => <SelectItem key={n.id} value={n.id}>{n.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </header>

      <div className="workspace-content">
        <div className="settings-area">
          <fieldset disabled={running} className="min-w-0 border-0 p-0">
          <Panel step="01" title="Credentials" hidden={activeSection !== "01"}>
            <div className="space-y-1.5">
              <Label htmlFor="claimant-credential">Claimant secret key or 24-word passphrase</Label>
              <Textarea
                id="claimant-credential"
                className="text-sm"
                rows={4}
                autoComplete="off"
                spellCheck={false}
                placeholder="S… or mnemonic words"
                value={credential}
                onChange={(e) => { setCredential(e.target.value); setClaimantPk(null); }}
              />
              {claimantPk && <p className="break-all text-xs text-muted-foreground">→ {claimantPk}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vault-destination">Vault destination (G… or muxed M…)</Label>
              <Input id="vault-destination" className="text-sm" placeholder="G… or M…" value={destination} onChange={(e) => setDestination(e.target.value)} />
              {destination && !isValidDestination(destination) && <p className="text-xs text-destructive">Invalid address</p>}
              <div className="flex items-center justify-between">
                <Label htmlFor="remember-address" className="text-xs text-muted-foreground">Remember this address on this device</Label>
                <Switch id="remember-address" checked={rememberDest} onCheckedChange={setRememberDest} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="direct-balance">Direct claimable balance ID <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="direct-balance" className="text-sm" placeholder="00000000…" value={directId} onChange={(e) => setDirectId(e.target.value)} />
            </div>
            <Button onClick={loadBalance} disabled={!credential.trim() || loading} variant="secondary" className="w-full">
              <RefreshCw className={loading ? "animate-spin" : ""} />{loading ? "Scanning balances…" : "Refresh balances"}
            </Button>
            {candidates.length > 0 && (
              <div className="space-y-1.5">
                <Label>Select balance to recover</Label>
                <div className="max-h-80 space-y-1 overflow-y-auto">
                  {candidates.map((c) => (
                    <Button variant="ghost"
                      key={c.id}
                      type="button"
                      onClick={() => setBalance(c)}
                      className={`h-auto w-full flex-col items-stretch whitespace-normal rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                        balance?.id === c.id ? "border-primary bg-primary/10" : "bg-background hover:border-primary/50"
                      }`}
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="text-foreground">{c.amount} {c.assetLabel}</span>
                        <span className={balanceStatus(c, now) === "CLAIMABLE" ? "text-success" : "text-info"}>
                          {balanceStatus(c, now)}
                        </span>
                      </div>
                      <div className="break-all text-muted-foreground">{c.id}</div>
                      <div className="text-muted-foreground">Unlock: {c.unlockAt === null ? "No claimable window" : new Date(c.unlockAt * 1000).toISOString()}</div>
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {balance && (
              <dl className="grid grid-cols-2 gap-3 border-t pt-4 text-xs">
                <div><dt className="text-muted-foreground">Amount</dt><dd className="text-base text-foreground">{balance.amount} {balance.assetLabel}</dd></div>
                <div><dt className="text-muted-foreground">Status</dt><dd className={balance.claimableNow ? "text-success" : "text-warning"}>{balanceStatus(balance, now)}</dd></div>
                <div className="col-span-2"><dt className="text-muted-foreground">Predicate</dt><dd className="break-all">{balance.predicateText}</dd></div>
                {balance.expiresAt && <div className="col-span-2"><dt className="text-muted-foreground">Window closes</dt><dd>{new Date(balance.expiresAt * 1000).toISOString()}</dd></div>}
              </dl>
            )}
          </Panel>

          <Panel step="02" title="Priority fee" hidden={activeSection !== "02"}>
            <div className="grid grid-cols-2 gap-2">
              {(["standard", "high", "ultra", "custom"] as Tier[]).map((t) => (
                <Button variant="ghost"
                  key={t}
                  onClick={() => setTier(t)}
                  aria-pressed={tier === t}
                  className={`h-20 flex-col items-start whitespace-normal rounded-md border p-3 text-left transition ${tier === t ? "border-primary bg-primary/10" : "hover:bg-accent"}`}
                >
                  <div className="text-sm font-semibold">{t === "custom" ? "Custom" : FEE_TIERS[t].label}</div>
                  <div className="text-xs text-muted-foreground">
                    {t === "custom" ? "manual" : `${toUnits(tierFees[t as Exclude<Tier, "custom">])}/op`}
                  </div>
                </Button>
              ))}
            </div>
            {tier === "custom" && (
              <div className="space-y-1.5">
                <Label>Custom fee per operation ({network.nativeCode}, max {CUSTOM_FEE_MAX})</Label>
                <Input type="number" step="0.5" min={0} max={CUSTOM_FEE_MAX} value={customFee} onChange={(e) => setCustomFee(e.target.value)} />
              </div>
            )}
            <div className="border-y py-4 text-sm">
              Max total fee: <span className="text-primary">{toUnits(perOpFee * opCount)} {network.nativeCode}</span>{" "}
              <span className="text-muted-foreground">({perOpFee} stroops × {opCount} ops · standard is {toUnits(baseFee * 2)})</span>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Fee-bump envelope</Label>
                <p className="text-xs text-muted-foreground">Outer envelope carries the priority bid; enables 10× replace-by-fee.</p>
              </div>
              <Switch aria-label="Fee-bump envelope" checked={feeBump} onCheckedChange={setFeeBump} />
            </div>
            {feeBump && (
              <div className="space-y-1.5">
                <Label>Fee payer key (optional, defaults to claimant)</Label>
                <Input type="password" className="text-sm" placeholder="S… of a funded fee account" value={feeCredential} onChange={(e) => setFeeCredential(e.target.value)} />
              </div>
            )}
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-escalate on congestion</Label>
                <p className="text-xs text-muted-foreground">Rebid when fee is too low or tx stalls in the queue.</p>
              </div>
              <Switch aria-label="Auto-escalate on congestion" checked={escalate} onCheckedChange={setEscalate} />
            </div>
            {escalate && (
              <div className="space-y-1.5">
                <Label>Escalation cap per op ({network.nativeCode})</Label>
                <Input type="number" step="0.1" value={maxFee} onChange={(e) => setMaxFee(e.target.value)} />
              </div>
            )}
          </Panel>

          <Panel step="03" title="Execution tuning" hidden={activeSection !== "03"}>
            <div className="space-y-1.5"><Label>Timing mode</Label>
              <Select value={timingMode} onValueChange={(v) => setTimingMode(v === "ledger" ? "ledger" : "fixed")}>
                <SelectTrigger aria-label="Timing mode"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="fixed">Fixed fire lead</SelectItem><SelectItem value="ledger">Ledger gate (early)</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between"><Label htmlFor="dry-run">Dry-run</Label><Switch id="dry-run" checked={dryRun} onCheckedChange={setDryRun} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Fire lead (ms before unlock)</Label><Input type="number" value={leadMs} onChange={(e) => setLeadMs(e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Burst interval (ms)</Label><Input type="number" value={burstMs} onChange={(e) => setBurstMs(e.target.value)} /></div>
            </div>
            <div className="space-y-2 border-y py-4">
              <Label htmlFor="extra-endpoints" className="text-primary">Additional endpoints — parallel broadcast ({horizons.length} active)</Label>
              <Textarea id="extra-endpoints" rows={3} className="text-sm" placeholder={ENDPOINT_HINTS.join("\n")} value={extraHorizons} onChange={(e) => setExtraHorizons(e.target.value)} />
              <p className="text-xs text-muted-foreground">One per line. Every endpoint receives the same signed envelope at the same moment. Example core nodes: {ENDPOINT_HINTS.join(", ")}</p>
              {horizons.some((h) => h.startsWith("http://")) && typeof window !== "undefined" && window.location.protocol === "https:" && (
                <p className="text-xs text-warning">Plain http:// endpoints are blocked by the browser on this secure page. They work when the app is opened over http (e.g. run locally); otherwise they'll simply fail without stopping the other endpoints.</p>
              )}
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Also merge claimant account into vault</Label>
                <p className="text-xs text-muted-foreground">Sweeps the remaining native balance & reserves. Fails if the account has trustlines.</p>
              </div>
              <Switch aria-label="Also merge claimant account into vault" checked={mergeAccount} onCheckedChange={setMergeAccount} />
            </div>
          </Panel>
          </fieldset>
          <Panel step="04" title="History" hidden={activeSection !== "04"}><History history={history} running={running} /></Panel>
        </div>

        <div className="execution-area">
          <section className="execution-timer">
            <div className="mb-5 flex items-center justify-between"><span className="flex items-center gap-2 text-sm text-muted-foreground"><Timer className="size-4" />Unlock window</span><span className="text-xs text-muted-foreground">{running ? "Armed" : result ? "Completed" : "Not armed"}</span></div>
            <Countdown target={balance?.unlockAt ?? null} label="Time to unlock" />
            <div className="mt-5 flex gap-2">
              {!running ? (
                <Button size="lg" className="flex-1 font-semibold" disabled={!balance || balanceStatus(balance, now) === "EXPIRED" || balance.unlockAt === null || !credValid || !isValidDestination(destination)} onClick={arm}>
                  <Zap />{dryRun ? "Build dry-run" : balance && balanceStatus(balance, now) === "CLAIMABLE" ? "Execute now" : "Arm & auto-fire"}
                </Button>
              ) : (
                <Button size="lg" variant="destructive" className="flex-1" onClick={() => { cancelledRef.current = true; engineRef.current?.stop(); }}>
                  Disarm
                </Button>
              )}
            </div>
            {!history.userId && <p className="mt-2 text-xs text-muted-foreground">Not signed in · runs will not be saved to History.</p>}
            {history.error && <p role="alert" className="mt-2 text-xs text-destructive">{history.error}</p>}
            {running && <p className="mt-2 text-xs text-warning">Keep this tab open and in the foreground until execution completes.</p>}
            {result && (
              <div className={`mt-4 rounded-md border p-3 text-xs ${result.result === "successful" ? "border-success/50 bg-success/10" : "border-info/50 bg-info/10"}`}>
                <div className="font-semibold">{result.result === "successful" ? `Funds swept · ${result.amount} ${result.assetLabel}` : result.result === "dry_run" ? "Dry-run complete · nothing submitted" : result.result.toUpperCase()}</div>
                <div className="mt-1">Ledger: {result.ledger ?? "—"} · Fee paid: {result.feePaid ?? "unavailable"} {network.nativeCode}</div>
                {result.code && <div className="mt-1 break-words">{result.code}</div>}
                {result.hash && (result.result === "dry_run" ? <div className="mt-2 break-all">{result.hash}</div> : <a className="mt-2 block break-all text-info underline" href={network.explorerTx(result.hash)} target="_blank" rel="noreferrer">{result.hash}</a>)}
              </div>
            )}
          </section>
          <section className="execution-journal">
            <div className="mb-3 flex items-center justify-between">
              <div><h2 className="font-display text-sm font-semibold">Execution console</h2><p className="mt-1 text-xs text-muted-foreground">{logs.length} entries</p></div>
              <Button variant="ghost" size="icon" title="Clear execution log" aria-label="Clear execution log" onClick={() => setLogs([])}><Trash2 /></Button>
            </div>
            <PhaseBanner phase={phase} />
            <Console logs={logs} explorer={network.explorerTx} />
          </section>
        </div>
      </div>
      <footer className="workspace-footer">
        Signing happens locally with your keys held only in memory. Test on testnet first.
      </footer>
      </div>
    </div>
  );
}

