import "@/lib/stellar/polyfill";
import { createFileRoute } from "@tanstack/react-router";
import { RecoveryConsole } from "@/components/recovery/RecoveryConsole";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Vaultline — Atomic Claimable Balance Recovery" },
      {
        name: "description",
        content: "Claim time-locked Stellar/Pi balances and sweep to cold storage in one atomic, priority-fee transaction at the exact unlock second.",
      },
      { property: "og:title", content: "Vaultline — Atomic Claimable Balance Recovery" },
      { property: "og:description", content: "Atomic claim + sweep with fee-bump priority and burst submission at unlock." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  ssr: false,
  component: RecoveryConsole,
});
