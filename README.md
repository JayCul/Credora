# Credora

**A WhatsApp accounting agent for informal market vendors. Sales, expenses, net profit, and a portable on-chain credit history. No wallet, no app, no literacy barrier. Just chat.**

Built for the [BOT Chain Africa Builder Challenge 2026](https://luma.com/sd9re1ll).

---

## The problem

Millions of market vendors across Nigeria run real, profitable businesses entirely in cash and word of mouth. They have no bank credit history, so when they need a loan to restock or expand, there's nothing to show a lender. Not because their business is risky, but because it's *invisible*. Meanwhile they already live on WhatsApp for everything else.

## What Credora does

A merchant messages the WhatsApp agent for the first time:

> "Hi"

Credora asks one question, the merchant's business name, and remembers them from then on. No forms, no app install, no wallet setup. From there they just describe what happened in plain language:

> "Sold 2 bags of rice to Musa for 15000 naira"

An AI agent figures out whether that's a sale or an expense, resolves shorthand ("270k" becomes 270,000, "2M" becomes 2,000,000), identifies the currency if one is mentioned, and runs a fraud and anomaly check. Anything ambiguous gets a human confirmation step before it's recorded. Sales get written as a tamper-evident receipt to `ReceiptLedger.sol` on BOT Chain; expenses are logged to a local ledger for the merchant's own bookkeeping. Every sale gets a real PDF receipt back in the same chat, instantly, and `/profit` gives a net profit summary anytime, split out by currency so nothing gets blended together that shouldn't be.

Over weeks, the on-chain sales record becomes a running reputation score and tier (Bronze through Platinum) that any microlender can check without taking the merchant's word for it. It's an alternative credit signal for someone who's never had one. No wallet, no seed phrase, no gas token to buy. The agent handles all of that; the merchant just chats.

## Architecture

```
Merchant's WhatsApp
        │  free-text message
        ▼
Baileys socket (agent/whatsapp.js), a WebSocket link to WhatsApp, no Meta approval needed
        │
        ▼
Onboarding gate. First-ever message? Ask for a business name, save it locally,
        │  then continue with whatever they originally sent
        ▼
Command router. /menu, /id, /profit handled directly, no LLM call needed.
        │  Anything else falls through to the parser
        ▼
LLM tool-call extraction (agent/llmParser.js, Groq or Claude)
        │  schema-constrained JSON: {transaction_type: sale|expense|none,
        │  description, amount, currency_code, flags, confidence, ...}
        ▼
Risk gate. Flagged, low-confidence, or ambiguous? Ask the merchant to reply CONFIRM first.
        │
        ├── sale ──▶ agent/contractClient.js hashes the phone, does a staticCall
        │            preflight, sends the tx (amount × 100 happens here in code,
        │            never trusted to the LLM)
        │              ▼
        │            ReceiptLedger.sol on BOT Chain (testnet 968 / mainnet 677)
        │              ▼
        │            WhatsApp reply (receipt id, tx hash, tier/score) plus a PDF receipt
        │
        └── expense ─▶ agent/store.js logs it locally only, never touches the chain
                          ▼
                        WhatsApp reply confirming the expense was tracked

agent/profit.js: /profit sums cached on-chain receipts and local expenses for a
                  period, broken out per currency, entirely from the local cache
```

## Onboarding, expenses, and receipts

A few small pieces make Credora feel like a proper accounting agent instead of a database with a chat frontend bolted on.

**Onboarding** (`agent/whatsapp.js`) means the very first message from any phone number, whatever it says, triggers "what's the name of your business?" before anything else happens. If that first message was actually a sale or an expense and not just "hi", it's held and processed automatically right after they answer, so nothing gets lost. Returning merchants who say "hi" get greeted by name with a quick reminder of what to do next, instead of a generic "I didn't understand that."

**One classifier handles both sales and expenses** (`agent/llmParser.js`). A single LLM call per message returns `transaction_type: "sale" | "expense" | "none"`, plus a description, an amount, and any anomaly flags. Sales go on chain through `contractClient.js`; expenses are logged locally through `store.js`. The same risk gate (confidence, flags, ambiguity) applies to both before anything is recorded, and either can be flagged for a human CONFIRM.

**Numbers and currency are handled carefully, because this is money.** The LLM only ever resolves shorthand ("15k" to 15000, "twenty thousand" to 20000); the ×100 conversion to minor units always happens afterward in plain code, so it can never be silently skipped the way an LLM instruction occasionally can be. Currency is identified from words or symbols in the text (naira, ₦, dollars, $, cedis, pounds, and more). If there's genuinely no hint of which currency is meant, the agent asks instead of guessing, and only defaults to USD if the merchant confirms it.

**Slash commands** (`agent/whatsapp.js`) skip the LLM call entirely, so they're instant and free: `/menu` lists everything the agent can do, `/id` returns a merchant's Credora ID and dashboard link, `/profit [today|week|month|all]` returns a net profit summary.

**Net profit** (`agent/profit.js`) sums revenue from cached on-chain receipts and expenses from the local ledger for whichever period was asked for, broken out per currency actually used rather than blended into one number (adding NGN and USD together would just be wrong). This is explicitly a bookkeeping convenience and not a credit signal. Expenses are self-reported and unverified, and the reply says so every time.

**PDF receipts** (`agent/receiptPdf.js`) are generated server-side with `pdfkit`, styled to match the dashboard's palette, and built from one code path used two ways: sent back as a WhatsApp document immediately after every recorded sale, and downloadable on demand from the dashboard's merchant drawer.

Expenses and receipt details live in `agent/store.js`, a small local JSON store mapping `merchantHash` to business name, `receiptId` to sale details, and `expenseId` to expense details. This is a deliberate, honest split in the trust model: the chain remains the only source of truth for anything the credit score depends on (sale amounts, tiers, streaks), while business names, item descriptions, and all expense data live off-chain because they're self-reported and not attested, and putting them on a public ledger would be a privacy loss for no real benefit. Every surface that shows this data labels it clearly rather than implying it carries the same weight as on-chain history.

## Sales dashboard

Not a "lender dashboard," on purpose. Everything it shows (volume, receipt history, PDF downloads, tier progress) is exactly what a merchant wants to see about their own business first. A lender uses the same read-only view for the same reason a merchant does: to see the sales record. One dashboard, two audiences, no separate lender-only product to build or explain.

```bash
npm run dashboard
```
It opens at `http://localhost:4000/dashboard.html` with three views (Overview, Merchants, How it works) that switch client-side without a reload.

- It reads `deployments/<network>.json` for the contract address, whichever network `.env`'s `NETWORK` selects, or `CONTRACT_ADDRESS` to override, so it always reflects whatever's actually deployed, nothing hardcoded.
- It talks to BOT Chain directly through a vendored `ethers.js` bundle (`public/vendor/`), with zero external CDN calls, so it works offline once loaded.
- It takes a Credora ID (a merchant's `merchantHash`), never a phone number. There's no lookup-by-phone path anywhere in this dashboard; a merchant has to deliberately hand their ID to a lender (via the WhatsApp agent's `/id` command) for it to ever be checked.
- It reads the tier thresholds (`BRONZE_MIN_RECEIPTS`, `SILVER_MIN_VOLUME`, and so on) as public constants straight from the contract instead of duplicating those numbers in JS, so the "progress to next tier" bars can never drift out of sync with what the contract actually enforces.
- It shows business names next to each Credora ID where a merchant has registered one, pulled from the local store via `/api/merchants`, clearly labeled as self-reported and not part of the credit score itself.
- Volume everywhere is broken out per currency, computed directly from each `ReceiptIssued` event's own `amountMinor` and `currencyCode`, not from the contract's blended `totalVolume` (which has no currency dimension at all and would silently sum NGN and USD together as if they were the same unit). A merchant who only ever used one currency just sees a single number, exactly as before.
- Opening a merchant's detail drawer shows a Cash flow breakdown: revenue (inbound) versus expenses (outbound) versus net, per currency, via `/api/profit`, which is the same `agent/profit.js` function the WhatsApp `/profit` command uses, so the two surfaces can never disagree. Below that, recent receipts (`/api/receipts`) with a Download PDF link on each one (`/api/receipt/:id/pdf`), generated on demand with the merchant's current on-chain standing.

Message the WhatsApp agent `/id` anytime to get a shareable link back. That's the intended distribution path, not sending the dashboard URL around blind.

See **Setup** below for deploying and seeding demo data. Testnet first, mainnet once you're ready.

## Security design

This is an attestation ledger, not a payments or escrow system. No value ever moves through the contract. That one decision shrinks the entire trust boundary: the worst a compromised agent key can do is write a bogus sales record, and even that is bounded on-chain, not left to hope.

| Guard | Where | Why |
|---|---|---|
| `AccessControl` (`AGENT_ROLE` / `DEFAULT_ADMIN_ROLE`) | contract | Only authorized agent wallets can write; instantly revocable if a key leaks |
| `Pausable` | contract | Emergency stop halts all writes without touching existing history |
| `ReentrancyGuard` | contract | Defense in depth on every state-changing entry point |
| Per-receipt amount cap (`maxReceiptAmount`) | contract, admin-tunable | Bounds damage from a compromised or malfunctioning agent |
| Per-merchant cooldown (`minReceiptInterval`) | contract | Blocks rapid-fire wash-trading of the reputation score |
| Custom errors, not require-strings | contract | Gas-efficient, and machine-readable back through `contractClient.js` |
| EIP-712 signed relay path plus per-merchant nonce and deadline | contract | Lets the signing key differ from the gas-paying key; replay-proof |
| Salted `keccak256` phone hashing | agent | Phone numbers never touch the chain in plaintext; the pepper is stored only in `.env` |
| Schema-constrained tool-call extraction | agent | The merchant's raw text is only ever *extracted from* by the LLM, never concatenated into a system prompt or given tool access. This closes off "message contains hidden instructions for the AI" prompt injection at the API level |
| Deterministic amount conversion | agent | The LLM only resolves shorthand; the ×100 minor-unit multiplication happens in plain code afterward, so it can't be silently skipped the way an LLM step occasionally can be |
| History-aware anomaly flags plus a human CONFIRM step | agent | AI flags anything unusual *for this specific merchant*; a human is in the loop before it ever reaches the chain, on top of the hard on-chain cap |
| 14 passing tests including attack paths | `test/ReceiptLedger.test.js` | Unauthorized caller, wrong signer, replayed signature, expired signature, paused state, cap and cooldown breach all asserted to revert |
| HTML-escaped free text | `public/dashboard.html` | Business names, item descriptions, and buyer names are all self-reported over WhatsApp; every one of those fields is escaped before insertion into the DOM, since the dashboard renders them via `innerHTML` |
| Business names never touch the chain | `agent/store.js` | Kept in a local off-chain store instead, so self-reported, unverified identity data is never confused with the attested on-chain credit history |

## Setup

```bash
npm install
cp .env.example .env    # fill in the values below
npx hardhat compile
npx hardhat test        # 14 passing
```

Fill in `.env`:
- `NETWORK`: `testnet` or `mainnet`. Defaults to `testnet` so a fresh checkout can't accidentally fire a transaction at mainnet before you've deliberately opted in. Test everything on testnet first, and only flip to `mainnet` once you're ready for the real submission.
- `DEPLOYER_PRIVATE_KEY` / `AGENT_PRIVATE_KEY`: wallet(s) funded with BOT on whichever network `NETWORK` selects. Testnet BOT is free from [faucet.botchain.ai/basic](https://faucet.botchain.ai/basic). Mainnet BOT has no faucet; it's swap-only via [dex.botchain.ai](https://dex.botchain.ai).
- `GROQ_API_KEY` (recommended, free, no card) or `ANTHROPIC_API_KEY` (paid): powers the WhatsApp message parser. `agent/llmParser.js` uses Groq if it's present, otherwise falls back to Claude.
- `PHONE_HASH_SALT`: any long random string. Generate once, never reuse, never commit.

Deploy, testnet first:
```bash
npm run deploy:testnet     # writes deployments/botchainTestnet.json
npm run deploy             # mainnet, once you're ready, writes deployments/botchain.json
```
`agent/contractClient.js` and `server.js` both read `deployments/<network>.json` automatically, based on whatever `NETWORK` in `.env` currently says, so switching networks is a one-line `.env` edit, not a code change.

Optionally seed a few sample merchants so the dashboard has something to show right away:
```bash
npm run seed:testnet
```
Real chains don't let you fast-forward the clock the way a local Hardhat node does, so this respects the real 30-second per-merchant cooldown (temporarily relaxed via an admin call for the duration of seeding, then restored). Expect it to take a couple of minutes on testnet, not instant like on a local node.

Run the agent:
```bash
npm run agent
```
Scan the printed QR code with WhatsApp (Linked Devices, then Link a Device). Message the linked number to test.

## Demo script (for judges)

1. From a fresh phone number, message the agent's WhatsApp number: *"Hi"*. Show it asking for a business name, answer it, and show the welcome message.
2. Send *"Sold 2 bags of rice to Musa for 15000 naira"*. Watch the WhatsApp reply (parsed, recorded on-chain, tx hash, tier and credit score) and the PDF receipt arriving as a document in the same chat, seconds later.
3. Send *"Bought fuel for 3000 naira"* to show an expense being logged locally, no on-chain transaction, and the reply saying so explicitly.
4. Send `/profit` to show the net profit summary combining the sale and the expense. Try `/profit today` and `/profit all` to show period switching.
5. Send `/menu` to show the full command list.
6. Open the tx on the explorer link from step 2 (`scan.bohr.life` on testnet, `scan.botchain.ai` on mainnet) to show the `ReceiptIssued` event live on chain.
7. Send a second, larger sale to show a `TierUpgraded` event and the credit score climbing.
8. Send an ambiguous message with no amount to show the clarification flow, then send an unusually large amount to show the CONFIRM gate.
9. Message `/id` to get the merchant's shareable Credora ID and dashboard link.
10. Open that link with `npm run dashboard` running: business name, tier badge, credit-score gauge, progress to next tier, all read live from chain, plus the receipt list with a Download PDF button. Switch to the Merchants view to show the full list discovered from chain, and to About for the onboarding and PDF explainer.
11. Optionally, show a test file assertion failing on purpose, like an unauthorized wallet trying to call `issueReceipt`, to demonstrate the access-control guard live.

## Roadmap (beyond the hackathon)

- Bring expenses and net profit into the dashboard itself (currently WhatsApp-only), with the same "self-reported, not on-chain" labeling
- Buyer-side confirmation (two-sided attestation) to further harden against fabricated receipts
- A gas-sponsored relayer using the existing `issueReceiptWithSig` path, so merchants never need BOT at all
- Admin-configurable tier thresholds via governance rather than hardcoded constants
- Multiple concurrent `AGENT_ROLE` workers for horizontal scaling, each independently revocable
- The dashboard already reads `creditScore()` and `getMerchantProfile()` directly from chain; next up is a merchant-only authenticated view alongside the public sales view
