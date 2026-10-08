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
- Submission uses raw `fetch` POST to every configured Horizon in parallel with a pre-signed envelope gated by `minTime` = unlock, so early attempts fail free with `tx_too_early`.
