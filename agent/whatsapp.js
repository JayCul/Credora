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

const AUTH_DIR = "auth_info_baileys";
const MAX_MESSAGE_CHARS = 1000; // bounds prompt size/cost and blunts flood-style abuse
const PENDING_TTL_MS = 5 * 60 * 1000;
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

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\nScan with WhatsApp → Linked Devices → Link a Device:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startAgent();
    } else if (connection === "open") {
      console.log("✅ WhatsApp connected — Credora agent is live.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
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

  const reply = async (body) => {
    const sent = await sock.sendMessage(jid, { text: body });
    if (sent?.key?.id) {
      sentMessageIds.add(sent.key.id);
      if (sentMessageIds.size > MAX_TRACKED_IDS) {
        sentMessageIds.delete(sentMessageIds.values().next().value);
      }
    }
    return sent;
  };

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
        await submitReceipt(sock, jid, reply, contractClient, store, merchantHash, merchant, pending.record);
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
  const { sock, jid, reply, contractClient, store, merchantHash, merchant, merchantPhone } = ctx;
  const currencyCode = rawCurrencyCode.toUpperCase().slice(0, 3).padEnd(3, "D");
  const needsConfirmation =
    parsed.clarification_needed || parsed.confidence < 0.6 || (parsed.flags && parsed.flags.length > 0);
  const description = parsed.description || (parsed.transaction_type === "sale" ? "unspecified item" : "unspecified expense");

  if (parsed.transaction_type === "sale") {
    const record = {
      merchantPhone,
      buyerPhone: null, // buyers are rarely reachable on WhatsApp; hashed anonymously on-chain instead
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
    await submitReceipt(sock, jid, reply, contractClient, store, merchantHash, merchant, record);
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
  await submitExpense(reply, store, merchantHash, record);
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

async function submitReceipt(sock, jid, reply, contractClient, store, merchantHash, merchant, record) {
  await reply("Recording on-chain… ⛓️");
  let result;
  try {
    result = await contractClient.issueReceipt(record);
  } catch (err) {
    console.error("issueReceipt failed:", err);
    await reply(`❌ Couldn't record that: ${err.message || "unknown error"}`);
    return;
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
  });

  await reply(
    `✅ Receipt #${result.receiptId} recorded.\n` +
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
    });
    await sock.sendMessage(jid, {
      document: pdfBuffer,
      mimetype: "application/pdf",
      fileName: `Credora-Receipt-${result.receiptId}.pdf`,
    });
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

startAgent().catch((err) => {
  console.error("Fatal agent error:", err);
  process.exit(1);
});

module.exports = { startAgent };
