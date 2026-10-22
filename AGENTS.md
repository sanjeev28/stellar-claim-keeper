<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- All signing and Stellar network calls run in the browser (`src/lib/stellar/*`); no server ever sees keys — keeps the tool non-custodial.
- The index route uses `ssr: false` because the engine depends on browser crypto/fetch and holds secrets in memory only.
- Network presets live in `src/lib/stellar/networks.ts`; add networks there rather than hardcoding Horizon URLs elsewhere.
- Submission signs at fire time in the browser and broadcasts the same minTime-gated envelope on an independent cadence to all endpoints; preserve the signed inner transaction when escalating fee bumps so pending sequences are not changed.
- History stores only whitelisted execution metadata behind owner-scoped RLS; signing and execution never depend on history writes so storage failures cannot delay a claim.
- Horizon inclusion receipts are authoritative for success and actual charged fees; uncertain network outcomes stay unconfirmed rather than being labelled successful or safely cancelled.

- Recovery settings use local tab state within the recovery workspace, while execution status remains mounted alongside — changing presentation tabs must not interrupt an armed engine or clear form values.
