import { useState } from "react";
import { LogIn, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { lovable } from "@/integrations/lovable";
import { supabase } from "@/integrations/supabase/client";
import { NETWORKS } from "@/lib/stellar/networks";
import type { useExecutionHistory } from "@/lib/history";
import "@lovable.dev/cloud-auth-js/styles.css";

export function History({ history, running }: { history: ReturnType<typeof useExecutionHistory>; running: boolean }) {
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  async function signIn(provider: "google" | "lovable") {
    setSigningIn(true);
    setAuthError(null);
    try {
      const result = await lovable.auth.signInWithOAuth(provider, { redirect_uri: window.location.origin });
      if (result.error) setAuthError("Sign-in was not completed. Try again.");
    } catch { setAuthError("Sign-in was not completed. Try again."); }
    finally { setSigningIn(false); }
  }
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{history.userId ? "Private execution history" : "Sign in to save private execution history"}</span>
      {history.userId && <div className="flex gap-1">
        <Button variant="ghost" size="icon" aria-label="Refresh history" title="Refresh history" disabled={history.loading} onClick={() => void history.refresh()}><RefreshCw className={history.loading ? "animate-spin" : ""} /></Button>
        <Button variant="ghost" size="icon" aria-label="Sign out" title="Sign out" disabled={running} onClick={() => void supabase.auth.signOut()}><LogOut /></Button>
      </div>}
    </div>
    {!history.userId && <div className="flex flex-col gap-2">
      <Button variant="secondary" disabled={running || signingIn} onClick={() => void signIn("google")}><LogIn />Continue with Google</Button>
      <Button className="lovable-auth-button" disabled={running || signingIn} onClick={() => void signIn("lovable")}>Continue with Lovable</Button>
    </div>}
    {(history.error || authError) && <p role="alert" className="text-xs text-destructive">{authError ?? history.error}</p>}
    {history.userId && !history.loading && history.rows.length === 0 && <p className="text-sm text-muted-foreground">No saved runs yet.</p>}
    {history.rows.map((row) => {
      const network = NETWORKS.find((n) => n.id === row.network_id);
      return <article key={row.id} className="space-y-2 border-b py-3 text-xs">
        <div className="flex flex-wrap justify-between gap-2"><strong className="text-foreground">{row.amount} {row.asset_label}</strong><span className={row.result === "successful" ? "text-success" : row.result === "failed" ? "text-destructive" : "text-info"}>{row.result.replaceAll("_", " ").toUpperCase()}</span></div>
        <div className="text-muted-foreground">{network?.label ?? row.network_id} · {new Date(row.created_at).toLocaleString()}</div>
        <div className="break-all">Balance: {row.balance_id}</div>
        <div>Unlock: {row.unlock_time ? new Date(row.unlock_time).toISOString() : "—"}</div>
        <div>Ledger: {row.ledger ?? "—"} · Fee paid: {row.fee_paid ?? "—"} {network?.nativeCode}</div>
        {row.result_code && <div className="break-words text-muted-foreground">{row.result_code}</div>}
        {row.tx_hash && (network && !row.dry_run ? <a className="block break-all text-info underline" href={network.explorerTx(row.tx_hash)} target="_blank" rel="noreferrer">{row.tx_hash} ↗</a> : <div className="break-all text-muted-foreground">{row.tx_hash}</div>)}
      </article>;
    })}
  </div>;
}