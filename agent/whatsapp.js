const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
require("dotenv").config();

const { parseTransactionMessage } = require("./llmParser");
const { ContractClient } = require("./contractClient");
const { LocalStore } = require("./store");
const { generateReceiptPdf } = require("./receiptPdf");
const { computeProfit, PERIOD_LABELS } = require("./profit");
const { startHealthServer } = require("./healthServer");

// Shared across reconnects — startAgent() calls itself again on a dropped
// connection, and the health server must only ever bind its port once, not
// restart on every reconnect attempt.
const agentStatus = { connected: false, startedAt: new Date().toISOString(), lastMessageAt: null };

const AUTH_DIR = "auth_info_baileys";
const MAX_MESSAGE_CHARS = 1000; // bounds prompt size/cost and blunts flood-style abuse
const PENDING_TTL_MS = 5 * 60 * 1000;
const BUYER_CONFIRM_TIMEOUT_MS = 15 * 60 * 1000; // real time for a real person to check their phone
const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL || "http://localhost:3000";

const isIdRequest = (text) => /^\/?(id|my ?id|score|my ?score)$/i.test(text.trim());
const isMenuRequest = (text) => /^\/?(menu|help)$/i.test(text.trim());
const isProfitRequest = (text) => /^\/?(check-)?profit\b/i.test(text.trim());
const isGreeting = (text) => /^(hi|hello|hey|hiya|yo|start)\b/i.test(text.trim());
const isGreetingOrCommand = (text) => isGreeting(text) || isMenuRequest(text) || isProfitRequest(text) || isIdRequest(text);

// In-memory only, per merchant JID. Fine for a single-process hackathon deployment;
// swap for Redis before scaling to multiple agent workers.
const pendingConfirmations = new Map(); // jid -> { kind: "sale"|"expense", record, expiresAt }
const pendingOnboarding = new Map(); // jid -> { stashedText: string | null }
const pendingCurrency = new Map(); // jid -> { parsed, expiresAt }
const pendingBuyerRequest = new Map(); // merchantJid -> { record, expiresAt } — "want buyer confirmation?"
const pendingBuyerConfirmation = new Map(); // buyerJid -> { merchantJid, merchant, record, buyerPhone, timer } — "please confirm"

// Both of the above are also mirrored to disk (agent/store.js) as they're set and
// cleared, so a restart can rehydrate them instead of silently dropping whoever was
// mid-flow. Rehydration itself only ever needs to run once per real process
// lifetime, not on every Baileys-level reconnect within that same process — those
// reconnects reuse this same module scope, so the in-memory Maps are already
// populated and re-running it would double up timers.
let hasRehydratedPendingState = false;

// Common ways people actually write a currency in chat, mapped to ISO codes. A raw
// 3-letter code (any of them, not just ones listed here) is also accepted directly —
// this table is for the words and symbols an ISO code alone wouldn't catch.
const CURRENCY_ALIASES = {
  NGN: ["ngn", "naira", "nairas", "₦"],
  USD: ["usd", "dollar", "dollars", "us dollar", "us dollars", "buck", "bucks", "$"],
  GHS: ["ghs", "cedi", "cedis"],
  KES: ["kes", "kenyan shilling", "kenyan shillings", "ksh"],
  UGX: ["ugx", "ugandan shilling", "ugandan shillings"],
  TZS: ["tzs", "tanzanian shilling", "tanzanian shillings"],
  ZAR: ["zar", "rand", "rands"],
  GBP: ["gbp", "pound", "pounds", "sterling", "£"],
  EUR: ["eur", "euro", "euros", "€"],
  XOF: ["xof", "cfa", "cfa franc", "cfa francs"],
  EGP: ["egp", "egyptian pound"],
};

function resolveCurrencyHint(text) {
  const t = text.trim().toLowerCase();
  if (/^(yes|y|ok|okay|default|sure)$/i.test(t)) return "USD"; // accepting the default we offered
  for (const [code, aliases] of Object.entries(CURRENCY_ALIASES)) {
    if (aliases.some((a) => t === a || t.includes(a))) return code;
  }
  if (/^[a-z]{3}$/i.test(t)) return t.toUpperCase(); // any raw ISO code typed directly
  return null;
}

/// Requires an explicit country code (a leading +). This is deliberate: a bare local
/// number like "08012345678" produces an invalid WhatsApp JID (JIDs are the full
/// international number, no leading 0, no +), and silently accepting one here was
/// the actual cause of a real bug, Baileys throwing cryptic internal session errors
/// when told to message a JID that doesn't correspond to any real WhatsApp account.
function looksLikePhoneNumber(text) {
  const t = text.trim();
  if (!t.startsWith("+")) return false;
  const digits = t.replace(/[^\d]/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

/// A number with enough digits to plausibly be a phone number, but missing the
/// leading + — the specific shape worth a "please include your country code" reply
/// instead of silently giving up on confirmation altogether.
function looksLikeNumberMissingCountryCode(text) {
  const t = text.trim();
  if (t.startsWith("+")) return false;
  const digits = t.replace(/[^\d]/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function toWhatsAppJid(rawPhone) {
  const digits = rawPhone.replace(/[^\d]/g, ""); // WhatsApp JIDs have no leading +
  return `${digits}@s.whatsapp.net`;
}

// IDs of messages the bot itself has sent, so a "fromMe" event can be told apart from
// a genuine self-chat test message (WhatsApp's "Message Yourself"). Both show up as
// fromMe: true — without this, testing via Message Yourself looks identical to the
// bot echoing its own reply, and gets silently dropped either way.
const sentMessageIds = new Set();
const MAX_TRACKED_IDS = 500;

const isConfirmation = (text) => /^(confirm|yes|y|ok|okay)$/i.test(text.trim());
const isCancellation = (text) => /^(cancel|no|n|stop)$/i.test(text.trim());

const MENU_TEXT =
  "Credora commands:\n\n" +
  'Describe a sale or expense in plain language, e.g.\n"Sold 2 bags of rice for 15000 naira"\n"Bought fuel for 3000 naira"\n\n' +
  "/profit [today|week|month|all] - net profit for a period (default: month)\n" +
  "/id - your Credora ID and dashboard link\n" +
  "/menu - this menu";

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    ""
  ).trim();
}

function formatAmount(amountMinor, currencyCode) {
  return `${currencyCode} ${(amountMinor / 100).toLocaleString()}`;
}

/// Factored out of handleMessage() so a rehydrated pending entry (reconstructed
/// from disk after a restart, with no live incoming message to close over) can get
/// the exact same reply() behavior — send text, track the outbound id so the bot's
/// own message doesn't get mistaken for a fresh incoming one.
function makeReplier(sock, jid) {
  return async (body) => {
    const sent = await sock.sendMessage(jid, { text: body });
    if (sent?.key?.id) {
      sentMessageIds.add(sent.key.id);
      if (sentMessageIds.size > MAX_TRACKED_IDS) {
        sentMessageIds.delete(sentMessageIds.values().next().value);
      }
    }
    return sent;
  };
}

async function startAgent() {
  const contractClient = new ContractClient();
  const store = new LocalStore(contractClient.network.name);
  console.log(`Contract:    ${contractClient.address}`);
  console.log(`Agent wallet: ${contractClient.wallet.address}`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  // A hosted log viewer (Render, etc.) timestamps every console.log line separately,
  // which breaks the ASCII QR's grid alignment the moment it's copied or reflowed —
  // each row arrives as its own log entry instead of one contiguous block. Pairing
  // code sidesteps that entirely: WHATSAPP_PHONE_NUMBER (digits only, country code,
  // no leading +, e.g. 2348012345678) gets a short code from WhatsApp itself, typed
  // in under Linked Devices → Link with phone number instead, no image involved.
  //
  // Requested from inside the first "qr" event, not right after makeWASocket() —
  // requestPairingCode() sends a live query over the socket's WebSocket, which
  // isn't open yet immediately after makeWASocket() returns (that call is
  // synchronous, the actual connection happens after). Calling it too early threw
  // "Connection Closed" and, worse, tore down the whole connection with a 401 that
  // then refused to reconnect. A "qr" event firing means the handshake that both
  // QR and pairing-code auth build on has already completed, so it's the right
  // signal to wait for instead of a guessed delay.
  let pairingRequested = false;

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      if (process.env.WHATSAPP_PHONE_NUMBER && !state.creds.registered && !pairingRequested) {
        pairingRequested = true;
        sock
          .requestPairingCode(process.env.WHATSAPP_PHONE_NUMBER.replace(/[^\d]/g, ""))
          .then((code) => {
            console.log(`\nWhatsApp pairing code: ${code}\nEnter it under Linked Devices → Link with phone number.\n`);
          })
          .catch((err) => {
            console.error("Could not request a pairing code, falling back to QR:", err.message);
            console.log("\nScan with WhatsApp → Linked Devices → Link a Device:\n");
            qrcode.generate(qr, { small: true });
          });
      } else if (!process.env.WHATSAPP_PHONE_NUMBER) {
        console.log("\nScan with WhatsApp → Linked Devices → Link a Device:\n");
        qrcode.generate(qr, { small: true });
      }
    }
    if (connection === "close") {
      agentStatus.connected = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startAgent();
    } else if (connection === "open") {
      agentStatus.connected = true;
      console.log("✅ WhatsApp connected — Credora agent is live.");
      if (!hasRehydratedPendingState) {
        hasRehydratedPendingState = true;
        rehydratePendingState(sock, contractClient, store).catch((err) => {
          console.error("Failed to rehydrate pending buyer-confirmation state:", err);
        });
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      agentStatus.lastMessageAt = new Date().toISOString();
      try {
        await handleMessage(sock, contractClient, store, msg);
      } catch (err) {
        console.error("Error handling message:", err);
      }
    }
  });
}

async function handleMessage(sock, contractClient, store, msg) {
  // Only skip fromMe events that are the bot's own tracked replies echoing back —
  // a real fromMe message the bot never sent (e.g. a Message Yourself test) still
  // gets processed normally.
  if (msg.key.fromMe && sentMessageIds.has(msg.key.id)) return;
  if (msg.key.remoteJid?.endsWith("@g.us")) return; // 1:1 merchant onboarding only
  if (msg.key.remoteJid === "status@broadcast") return;

  const jid = msg.key.remoteJid;
  const merchantPhone = jid.split("@")[0];
  const rawText = extractText(msg);
  if (!rawText) return;
  let text = rawText.slice(0, MAX_MESSAGE_CHARS);

  const reply = makeReplier(sock, jid);

  // ── Resolve a buyer's reply to a confirmation request FIRST, before anything
  //    else — including the onboarding gate, since a buyer may never have talked
  //    to this agent before and shouldn't be asked for a business name when
  //    they're just replying YES or NO to someone else's sale.
  const buyerEntry = pendingBuyerConfirmation.get(jid);
  if (buyerEntry) {
    await resolveBuyerConfirmation(sock, contractClient, store, jid, text, buyerEntry);
    return;
  }

  const merchantHash = contractClient.hashPhone(merchantPhone);

  // ── Onboarding gate — every unregistered merchant goes through this before
  //    anything else happens. A business name turns an anonymous hash into an
  //    identity a lender (or the merchant themselves) can actually recognize.
  let merchant = store.getMerchant(merchantHash);
  if (!merchant) {
    const awaiting = pendingOnboarding.get(jid);
    if (awaiting) {
      const name = text.trim();
      if (name.length < 2 || name.length > 80 || isGreetingOrCommand(name)) {
        await reply('That doesn\'t look like a business name. Send just the name, like "Amina\'s Rice and Grains".');
        return;
      }
      merchant = store.setMerchant(merchantHash, { businessName: name });
      pendingOnboarding.delete(jid);
      await reply(
        `You're all set, ${name}! I'll track your sales, expenses, and profit, and build your on-chain credit history automatically.\n\n` +
          `Just message me things like:\n"Sold 2 bags of rice for 15000 naira"\n"Bought fuel for 3000 naira"\n\n` +
          `Send /menu anytime to see everything I can do.`
      );
      if (awaiting.stashedText && !isGreetingOrCommand(awaiting.stashedText)) {
        text = awaiting.stashedText; // continue below and process their original message
      } else {
        return;
      }
    } else if (isConfirmation(text) || isCancellation(text)) {
      // A bare yes/no from a number we've never registered is far more likely to be
      // a stray reply to a buyer-confirmation request this process has no memory of
      // (its pending state lost some other way than the normal persisted path,
      // rare, but not impossible) than someone actually trying to sign up. Silently
      // starting onboarding here is how a real incident happened: a buyer's "Yes"
      // got treated as "hi", and their next message became a fabricated business
      // name. Doing nothing is a better failure mode than inventing a merchant.
      await reply(
        "I don't have anything pending for this number right now. If you're trying to confirm a sale, ask the merchant to resend the confirmation request."
      );
      return;
    } else {
      pendingOnboarding.set(jid, { stashedText: isGreetingOrCommand(text) ? null : text });
      await reply(
        "Welcome to Credora! I track your sales, expenses, and profit from WhatsApp, and build a portable on-chain credit history. No wallet, no app.\n\n" +
          "First, what's the name of your business?"
      );
      return;
    }
  } else if (isMenuRequest(text)) {
    await reply(MENU_TEXT);
    return;
  } else if (isGreeting(text)) {
    await reply(
      `Welcome back, ${merchant.businessName}!\n\n` +
        `Send a sale or expense anytime, e.g. "Sold 2 bags of rice for 15000 naira", or /menu for everything I can do.`
    );
    return;
  }

  // ── Self-serve "what's my Credora ID / score" command ────────────────────
  // This is the only way a merchant's phone number ever gets turned into their
  // Credora ID (merchantHash) and handed back to them — deliberately, on request,
  // never inferred or looked up by anyone else. They choose who they share it with.
  if (isIdRequest(text)) {
    pendingConfirmations.delete(jid);
    try {
      const summary = await contractClient.getMerchantSummary(merchantPhone);
      const link = `${DASHBOARD_BASE_URL}/dashboard.html?id=${summary.merchantHash}`;
      await reply(
        `${merchant.businessName}\nYour Credora ID:\n${summary.merchantHash}\n\n` +
          `Tier: ${summary.tier} | Credit score: ${summary.creditScore}/1000 | ${summary.receiptCount} receipts\n\n` +
          `This is your sales dashboard, track your own progress anytime, or share it with a lender to prove your history:\n${link}`
      );
    } catch (err) {
      console.error("Failed to build Credora ID reply:", err);
      await reply("Sorry, couldn't look that up right now. Please try again shortly.");
    }
    return;
  }

  // ── Net profit for a period — pure local bookkeeping, never touches the chain ──
  if (isProfitRequest(text)) {
    const p = computeProfit(store, merchantHash, text);
    const label = PERIOD_LABELS[p.period] || "This month";
    if (p.currencies.length === 0) {
      await reply(`${label}'s numbers for ${merchant.businessName}: nothing recorded yet for this period.`);
      return;
    }
    // Broken out per currency, never blended, mixing NGN and USD into one sum would
    // just be wrong.
    const lines = p.currencies.map(
      (c) =>
        `${c.currencyCode}\n` +
        `Revenue: ${formatAmount(c.revenueMinor, c.currencyCode)} (${c.receiptCount} sales)\n` +
        `Expenses: ${formatAmount(c.expensesMinor, c.currencyCode)} (${c.expenseCount} logged)\n` +
        `Net profit: ${formatAmount(c.netProfitMinor, c.currencyCode)}`
    );
    await reply(
      `${label}'s numbers for ${merchant.businessName}:\n\n` +
        lines.join("\n\n") +
        `\n\nNote: expenses are tracked locally for your own bookkeeping and are not part of your on-chain credit score.`
    );
    return;
  }

  // ── Resolve "do you want your buyer to confirm this?" ────────────────────
  const awaitingBuyerRequest = pendingBuyerRequest.get(jid);
  if (awaitingBuyerRequest) {
    pendingBuyerRequest.delete(jid);
    store.deletePendingBuyerRequest(jid);
    await resolveBuyerRequest(sock, contractClient, store, jid, merchant, merchantHash, text, awaitingBuyerRequest, reply);
    return;
  }

  // ── Resolve a pending "what currency was that" question ─────────────────
  const awaitingCurrency = pendingCurrency.get(jid);
  if (awaitingCurrency) {
    if (Date.now() > awaitingCurrency.expiresAt) {
      pendingCurrency.delete(jid);
    } else {
      const code = resolveCurrencyHint(text);
      if (!code) {
        await reply("Sorry, I didn't recognize that currency. Try NGN, USD, GHS, or reply YES to default to USD.");
        return;
      }
      pendingCurrency.delete(jid);
      await finalizeTransaction(
        { sock, jid, reply, contractClient, store, merchantHash, merchant, merchantPhone },
        awaitingCurrency.parsed,
        code
      );
      return;
    }
  }

  // ── Resolve a pending confirmation before treating this as a new message ──
  const pending = pendingConfirmations.get(jid);
  if (pending) {
    if (Date.now() > pending.expiresAt) {
      pendingConfirmations.delete(jid);
    } else if (isConfirmation(text)) {
      pendingConfirmations.delete(jid);
      if (pending.kind === "expense") {
        await submitExpense(reply, store, merchantHash, pending.record);
      } else {
        await offerBuyerConfirmation({ sock, jid, reply, contractClient, store, merchantHash, merchant }, pending.record);
      }
      return;
    } else if (isCancellation(text)) {
      pendingConfirmations.delete(jid);
      await reply("Cancelled. Nothing was recorded. Send it again whenever you're ready.");
      return;
    }
    // anything else: fall through and parse as a fresh message
  }

  // ── Pull recent history for anomaly context, then parse ──────────────────
  let recentAverageMinor = null;
  try {
    const profile = await contractClient.getMerchantSummary(merchantPhone);
    if (profile.receiptCount > 0n) {
      recentAverageMinor = Number(profile.totalVolume) / Number(profile.receiptCount);
    }
  } catch (err) {
    console.error("Could not read merchant profile (continuing without history context):", err.message);
  }

  let parsed;
  try {
    parsed = await parseTransactionMessage(text, { recentAverageMinor });
  } catch (err) {
    console.error("LLM parse failed:", err);
    await reply("Sorry, I couldn't process that just now. Please try again in a moment.");
    return;
  }

  if (parsed.transaction_type === "none") {
    await reply(
      "I record sales and expenses, or you can check your numbers. Try:\n" +
        '"Sold 2 bags of rice for 15000 naira"\n"Bought fuel for 3000 naira"\n\n' +
        "Or send /menu to see everything I can do."
    );
    return;
  }

  if (!parsed.amount || parsed.amount <= 0) {
    await reply("I couldn't find a valid amount in that. Could you resend it with the price included?");
    return;
  }

  // Currency wasn't identifiable from the text at all — ask rather than silently
  // assume one, and default to USD specifically if they just confirm.
  if (!parsed.currency_code) {
    pendingCurrency.set(jid, { parsed, expiresAt: Date.now() + PENDING_TTL_MS });
    await reply("What currency was that in? Reply with the currency (e.g. NGN, USD, GHS), or reply YES to default to USD.");
    return;
  }

  await finalizeTransaction({ sock, jid, reply, contractClient, store, merchantHash, merchant, merchantPhone }, parsed, parsed.currency_code);
}

/// Builds the sale or expense record from a resolved (parsed + currency-known)
/// transaction, then either submits it directly or routes to the CONFIRM/CANCEL gate
/// if anything about it needs a human look first. Shared by the normal parse path
/// and the "what currency was that" continuation, so both end up in exactly the same
/// place regardless of how the currency got resolved.
async function finalizeTransaction(ctx, parsed, rawCurrencyCode) {
  const { jid, reply, merchantHash, merchant } = ctx;
  const currencyCode = rawCurrencyCode.toUpperCase().slice(0, 3).padEnd(3, "D");
  const needsConfirmation =
    parsed.clarification_needed || parsed.confidence < 0.6 || (parsed.flags && parsed.flags.length > 0);
  const description = parsed.description || (parsed.transaction_type === "sale" ? "unspecified item" : "unspecified expense");

  if (parsed.transaction_type === "sale") {
    const record = {
      merchantPhone: ctx.merchantPhone,
      buyerPhone: null, // filled in later if the merchant provides one for confirmation
      amountMinor: Math.round(parsed.amount * 100), // *100 done here in code, never trusted to the LLM
      currencyCode,
      item: description,
      memo: parsed.counterparty_name ? `Buyer: ${parsed.counterparty_name}` : "",
    };

    if (needsConfirmation) {
      pendingConfirmations.set(jid, { kind: "sale", record, expiresAt: Date.now() + PENDING_TTL_MS });
      await reply(confirmationPrompt("Ready to record", description, record.amountMinor, currencyCode, parsed));
      return;
    }
    await offerBuyerConfirmation(ctx, record);
    return;
  }

  // transaction_type === "expense"
  const record = {
    description,
    counterpartyName: parsed.counterparty_name || null,
    amountMinor: Math.round(parsed.amount * 100), // *100 done here in code, never trusted to the LLM
    currencyCode,
  };

  if (needsConfirmation) {
    pendingConfirmations.set(jid, { kind: "expense", record, expiresAt: Date.now() + PENDING_TTL_MS });
    await reply(confirmationPrompt("Ready to log", description, record.amountMinor, currencyCode, parsed));
    return;
  }
  await submitExpense(reply, ctx.store, merchantHash, record);
}

function confirmationPrompt(verb, description, amountMinor, currencyCode, parsed) {
  const reasons = [parsed.clarification_needed, parsed.flags?.length ? `Flagged: ${parsed.flags.join(", ")}` : null]
    .filter(Boolean)
    .join(". ");
  return (
    `${verb}: ${description}, ${formatAmount(amountMinor, currencyCode)}.\n` +
    (reasons ? `⚠️ ${reasons}\n` : "") +
    `Reply CONFIRM to proceed, or CANCEL to discard.`
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Buyer-side confirmation — a second, independent attestation on top of the
// merchant's own report. See contracts/ReceiptLedger.sol's confirmReceipt() for
// the on-chain half of this.
// ─────────────────────────────────────────────────────────────────────────

/// Every sale that's otherwise ready to record gets offered this step before it
/// actually touches the chain — asking whether the merchant can get their buyer to
/// independently confirm it happened.
async function offerBuyerConfirmation(ctx, record) {
  const { jid, reply, merchantHash, merchant, store } = ctx;
  const expiresAt = Date.now() + PENDING_TTL_MS;
  pendingBuyerRequest.set(jid, { ctx, record, expiresAt });
  store.savePendingBuyerRequest(jid, { merchantHash, merchant, record, expiresAt });
  await reply(
    "Want your buyer to confirm this sale for extra credibility? Reply with their WhatsApp number, including the country code, e.g. +2348012345678, or reply SKIP to record it now without confirmation."
  );
}

async function resolveBuyerRequest(sock, contractClient, store, merchantJid, merchant, merchantHash, text, awaiting, reply) {
  const { record } = awaiting;
  const trimmed = text.trim();

  if (Date.now() > awaiting.expiresAt || /^skip$/i.test(trimmed) || isCancellation(trimmed)) {
    await submitReceipt(sock, merchantJid, reply, contractClient, store, merchantHash, merchant, record);
    return;
  }

  // Has enough digits to plausibly be a phone number, but no country code — this
  // exact shape used to silently build an invalid WhatsApp JID and surface as a
  // cryptic Baileys session error, rather than a clear ask to try again.
  if (looksLikeNumberMissingCountryCode(trimmed)) {
    await reply(
      "Please include the country code, starting with +, e.g. +2348012345678 for Nigeria. Reply again with the full number, or SKIP to record without confirmation."
    );
    const expiresAt = Date.now() + PENDING_TTL_MS;
    pendingBuyerRequest.set(merchantJid, { ctx: awaiting.ctx, record, expiresAt });
    store.savePendingBuyerRequest(merchantJid, { merchantHash, merchant, record, expiresAt });
    return;
  }

  if (!looksLikePhoneNumber(trimmed)) {
    await reply("I didn't recognize that as a phone number. Recording the sale now without buyer confirmation.");
    await submitReceipt(sock, merchantJid, reply, contractClient, store, merchantHash, merchant, record);
    return;
  }

  // A merchant naming themselves as the buyer would trivially defeat the entire
  // point of a second, independent party confirming anything.
  if (contractClient.hashPhone(trimmed) === merchantHash) {
    await reply(
      "That's your own number. I need the actual buyer's number for this to mean anything, or reply SKIP to record without confirmation."
    );
    const expiresAt = Date.now() + PENDING_TTL_MS;
    pendingBuyerRequest.set(merchantJid, { ctx: awaiting.ctx, record, expiresAt });
    store.savePendingBuyerRequest(merchantJid, { merchantHash, merchant, record, expiresAt });
    return;
  }

  const buyerJid = toWhatsAppJid(trimmed);
  const amountText = formatAmount(record.amountMinor, record.currencyCode);

  try {
    await sock.sendMessage(buyerJid, {
      text:
        `Hi! ${merchant.businessName} on Credora says they sold you "${record.item}" for ${amountText}.\n\n` +
        `Reply YES to confirm this happened, or NO if this isn't right.`,
    });
  } catch (err) {
    console.error("Could not message buyer number:", err.message);
    await reply("Couldn't reach that number on WhatsApp. Recording the sale now without buyer confirmation.");
    await submitReceipt(sock, merchantJid, reply, contractClient, store, merchantHash, merchant, record);
    return;
  }

  const createdAt = Date.now();
  const timer = setTimeout(async () => {
    if (!pendingBuyerConfirmation.has(buyerJid)) return; // already resolved by a reply
    pendingBuyerConfirmation.delete(buyerJid);
    store.deletePendingBuyerConfirmation(buyerJid);
    await reply("Your buyer hasn't responded yet, so I've recorded the sale without their confirmation. You can always ask again next time.");
    await submitReceipt(sock, merchantJid, reply, contractClient, store, merchantHash, merchant, record);
  }, BUYER_CONFIRM_TIMEOUT_MS);

  pendingBuyerConfirmation.set(buyerJid, { merchantJid, merchant, merchantHash, record, buyerPhone: trimmed, reply, timer });
  store.savePendingBuyerConfirmation(buyerJid, { merchantJid, merchant, merchantHash, record, buyerPhone: trimmed, createdAt });

  await reply(
    `Sent a confirmation request to ${trimmed}. I'll record the sale once they respond, or automatically in 15 minutes if they don't.`
  );
}

async function resolveBuyerConfirmation(sock, contractClient, store, buyerJid, text, entry) {
  const { merchantJid, merchant, merchantHash, record, buyerPhone, reply: merchantReply, timer } = entry;
  const buyerReply = (body) => sock.sendMessage(buyerJid, { text: body });

  if (isConfirmation(text)) {
    clearTimeout(timer);
    pendingBuyerConfirmation.delete(buyerJid);
    store.deletePendingBuyerConfirmation(buyerJid);
    await buyerReply("Thanks for confirming! I'll send you a copy of the receipt in a moment.");
    await submitReceipt(sock, merchantJid, merchantReply, contractClient, store, merchantHash, merchant, record, buyerPhone, [buyerJid]);
    return;
  }

  if (isCancellation(text) || /^no\b/i.test(text.trim())) {
    clearTimeout(timer);
    pendingBuyerConfirmation.delete(buyerJid);
    store.deletePendingBuyerConfirmation(buyerJid);
    await buyerReply("Got it, thanks for letting us know. Nothing was recorded on this one.");
    await merchantReply("Your buyer said this sale wasn't right, so I didn't record it. Double check the details and try again if needed.");
    return;
  }

  await buyerReply('Sorry, I didn\'t understand. Reply YES to confirm this sale happened, or NO if it isn\'t right.');
}

/// Runs once, right after the first successful connection of this process's
/// lifetime. Reconstructs pendingBuyerRequest and pendingBuyerConfirmation from
/// whatever agent/store.js still has on disk, so a restart mid-flow delays a
/// confirmation instead of losing it, or worse, having a stray "yes" mistaken for
/// a new merchant signup. reply()/timer/ctx don't survive a restart since they're
/// not serializable, they're rebuilt fresh here against the current sock.
async function rehydratePendingState(sock, contractClient, store) {
  const now = Date.now();
  let restoredCount = 0;

  const buyerRequests = store.allPendingBuyerRequests();
  for (const [merchantJid, data] of Object.entries(buyerRequests)) {
    if (now > data.expiresAt) {
      store.deletePendingBuyerRequest(merchantJid);
      continue;
    }
    const reply = makeReplier(sock, merchantJid);
    const ctx = {
      sock,
      jid: merchantJid,
      reply,
      contractClient,
      store,
      merchantHash: data.merchantHash,
      merchant: data.merchant,
    };
    pendingBuyerRequest.set(merchantJid, { ctx, record: data.record, expiresAt: data.expiresAt });
    restoredCount++;
  }

  const buyerConfirmations = store.allPendingBuyerConfirmations();
  for (const [buyerJid, data] of Object.entries(buyerConfirmations)) {
    const reply = makeReplier(sock, data.merchantJid);
    const elapsed = now - data.createdAt;

    if (elapsed >= BUYER_CONFIRM_TIMEOUT_MS) {
      // The original 15-minute timer would already have fired had the process not
      // restarted — run the same fallback now instead of leaving this stranded
      // forever with nothing left that will ever resolve it.
      store.deletePendingBuyerConfirmation(buyerJid);
      try {
        await reply("Your buyer hasn't responded yet, so I've recorded the sale without their confirmation. You can always ask again next time.");
        await submitReceipt(sock, data.merchantJid, reply, contractClient, store, data.merchantHash, data.merchant, data.record);
      } catch (err) {
        console.error(`Could not auto-record rehydrated pending confirmation for ${buyerJid}:`, err);
      }
      continue;
    }

    const remaining = BUYER_CONFIRM_TIMEOUT_MS - elapsed;
    const timer = setTimeout(async () => {
      if (!pendingBuyerConfirmation.has(buyerJid)) return;
      pendingBuyerConfirmation.delete(buyerJid);
      store.deletePendingBuyerConfirmation(buyerJid);
      await reply("Your buyer hasn't responded yet, so I've recorded the sale without their confirmation. You can always ask again next time.");
      await submitReceipt(sock, data.merchantJid, reply, contractClient, store, data.merchantHash, data.merchant, data.record);
    }, remaining);

    pendingBuyerConfirmation.set(buyerJid, {
      merchantJid: data.merchantJid,
      merchant: data.merchant,
      merchantHash: data.merchantHash,
      record: data.record,
      buyerPhone: data.buyerPhone,
      reply,
      timer,
    });
    restoredCount++;
  }

  if (restoredCount > 0) {
    console.log(`Rehydrated ${restoredCount} pending buyer-confirmation state(s) from disk after restart.`);
  }
}

async function submitReceipt(sock, jid, reply, contractClient, store, merchantHash, merchant, record, confirmedBuyerPhone, extraPdfRecipients = []) {
  await reply("Recording on-chain… ⛓️");
  const submitRecord = confirmedBuyerPhone ? { ...record, buyerPhone: confirmedBuyerPhone } : record;

  let result;
  try {
    result = await contractClient.issueReceipt(submitRecord);
  } catch (err) {
    console.error("issueReceipt failed:", err);
    await reply(`❌ Couldn't record that: ${err.message || "unknown error"}`);
    return;
  }

  // Buyer already said yes before this was ever recorded — mark it confirmed in the
  // same flow, so the very first time this receipt appears on-chain, it's already
  // carrying its second attestation, not upgraded later.
  let buyerConfirmed = false;
  if (confirmedBuyerPhone && result.receiptId) {
    try {
      await contractClient.confirmReceipt(result.receiptId, confirmedBuyerPhone);
      buyerConfirmed = true;
    } catch (err) {
      console.error("confirmReceipt failed (receipt is still recorded, just not marked confirmed):", err.message);
    }
  }

  const buyerName = record.memo?.startsWith("Buyer: ") ? record.memo.slice(7) : null;
  const timestamp = Math.floor(Date.now() / 1000);

  store.saveReceipt(result.receiptId, {
    merchantHash,
    item: record.item,
    buyerName,
    amountMinor: record.amountMinor,
    currencyCode: record.currencyCode,
    txHash: result.txHash,
    timestamp,
    buyerConfirmed,
  });

  await reply(
    `✅ Receipt #${result.receiptId} recorded${buyerConfirmed ? " (buyer confirmed)" : ""}.\n` +
      `${formatAmount(record.amountMinor, record.currencyCode)}, ${record.item}\n` +
      `Tier: ${result.tier}  |  Credit score: ${result.creditScore}/1000\n` +
      `${result.explorerUrl}`
  );

  // Convenience: hand back a real PDF receipt in the same chat, immediately —
  // no dashboard visit required to have proof of the sale in hand.
  try {
    const pdfBuffer = await generateReceiptPdf({
      receiptId: result.receiptId,
      businessName: merchant.businessName,
      merchantHash,
      item: record.item,
      buyerName,
      amountMinor: record.amountMinor,
      currencyCode: record.currencyCode,
      txHash: result.txHash,
      explorerTxUrl: result.explorerUrl,
      networkLabel: contractClient.network.name,
      timestamp,
      tier: result.tier,
      creditScore: result.creditScore,
      standingLabel: "Standing at time of sale",
      buyerConfirmed,
    });
    await sock.sendMessage(jid, {
      document: pdfBuffer,
      mimetype: "application/pdf",
      fileName: `Credora-Receipt-${result.receiptId}.pdf`,
    });

    // Buyer gets their own copy too, when this sale came through the confirmation
    // flow, since they're a party to the transaction, not just an approver of it.
    for (const extraJid of extraPdfRecipients) {
      if (extraJid === jid) continue;
      try {
        await sock.sendMessage(extraJid, {
          document: pdfBuffer,
          mimetype: "application/pdf",
          fileName: `Credora-Receipt-${result.receiptId}.pdf`,
        });
      } catch (extraErr) {
        console.error(`Could not send receipt copy to ${extraJid} (receipt is already recorded, this is cosmetic):`, extraErr);
      }
    }
  } catch (pdfErr) {
    console.error("PDF generation/send failed (receipt is already recorded on-chain, this is cosmetic):", pdfErr);
  }
}

async function submitExpense(reply, store, merchantHash, record) {
  store.saveExpense({
    merchantHash,
    description: record.description,
    counterpartyName: record.counterpartyName,
    amountMinor: record.amountMinor,
    currencyCode: record.currencyCode,
    timestamp: Math.floor(Date.now() / 1000),
  });

  await reply(
    `📉 Expense logged.\n${formatAmount(record.amountMinor, record.currencyCode)}, ${record.description}\n\n` +
      `Tracked locally for your own profit calculation, this is not written on-chain and does not affect your credit score.`
  );
}

// Started once, outside startAgent(), since reconnects call startAgent() again and
// a second attempt to bind the same port would crash the whole process.
startHealthServer(() => agentStatus);

startAgent().catch((err) => {
  console.error("Fatal agent error:", err);
  process.exit(1);
});

module.exports = { startAgent };
