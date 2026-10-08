# Stellar Guardian

Build a production-ready, full-stack Web Application for Stellar-based Time-Locked Asset Recovery & Transaction Automation using React, TypeScript, Tailwind CSS, and @stellar/stellar-sdk.

### Core Problem & Objective:
I have time-locked Claimable Balances on the Stellar/Pi network. When the unlock time predicate is reached, standard transactions with standard network fees (0.02 native asset) are constantly losing because competing transactions with higher priority fees get picked up by network validators first. Furthermore, if a balance is claimed into an account without an immediate transfer, it remains vulnerable.

I need an automated tool that solves two critical problems:
1. Atomic Execution: It must combine claiming the balance and sending/sweeping 100% of the funds to my secure cold storage destination into ONE SINGLE atomic transaction, ensuring zero delay between claim and transfer.
2. Priority & Speed: It must overcome the issue where standard 0.02 fee transactions get delayed or beaten. Provide full support for high-priority transaction submission and fee-bumping so my transaction wins validator inclusion at the exact unlock block.

### What I Need You To Build & Architect:

1. Interactive Configuration Panel:
   - Inputs for Claimable Balance ID, Claimant credentials (private key/mnemonic with secure client-side signing), and Vault Destination Address (supporting standard G... and Muxed M... addresses).
   - Auto-fetch the on-chain balance details, amount, asset code, and exact predicate unlock timestamp.

2. Atomic Transaction Construction:
   - Build a unified Stellar transaction that executes both Operation.claimClaimableBalance and Operation.payment together in a single envelope.

3. Priority Fee & Congestion Handling:
   - The default network fee is 0.02, but I need the ability to bid higher priority fees (e.g. through fee-bump transactions or custom max fee settings) to guarantee top priority in the validator mempool.
   - Design a smart fee configuration interface where I can set standard, high, or custom priority fees.

4. High-Performance Execution Logic (Design Your Best Architecture):
   - Design and implement the most optimal submission and scheduling mechanism to ensure the transaction hits the network at the exact second it unlocks.
   - Implement your own best practices for network latency reduction, RPC connection handling, and reliable execution so the transaction doesn't fail due to timing errors or congestion.

5. Real-Time Dashboard & Status Logs:
   - Countdown timer to the unlock event.
   - Live execution console showing submission lifecycle, transaction hash, explorer link, and final ledger status.
   - Clear diagnostic feedback for any Stellar network error codes.

Please deliver a clean, modular, and fully functional codebase with an intuitive modern UI.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://stellar-claim-keeper.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/e25e2a02-571d-4467-bc3e-94eb456910ee).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
