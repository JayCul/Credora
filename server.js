// Static server + small read API for the sales dashboard. Deliberately separate
// from agent/whatsapp.js — this process holds no private keys, so it has no
// business running alongside anything that signs transactions.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
// Pinned to this file's own directory, not process.cwd() — dotenv's default lookup
// breaks if this process is ever launched from a different working directory (e.g.
// a shared workspace launch config that runs commands from a parent folder).
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { resolveNetwork } = require("./agent/network");
const { LocalStore } = require("./agent/store");
const { generateReceiptPdf } = require("./agent/receiptPdf");
const { computeProfit, PERIOD_LABELS } = require("./agent/profit");

// Render (and most PaaS hosts) inject PORT and expect the app to bind to it
// specifically, ignoring it in favor of a fixed local default would fail the
// platform's health check. DASHBOARD_PORT stays the local-dev override.
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 4000;
const network = resolveNetwork();
const store = new LocalStore(network.name);
const TIER_NAMES = ["Unrated", "Bronze", "Silver", "Gold", "Platinum"];

const app = express();
app.get("/", (req, res) => res.redirect("/dashboard.html"));
app.use(express.static(path.join(__dirname, "public")));

/// Tells the browser which contract to read from, without hardcoding an address into
/// the static HTML — the dashboard always reflects whatever was last deployed on
/// whichever network NETWORK (.env) currently points at.
app.get("/api/config", (req, res) => {
  const deployment = readDeployment();
  const contractAddress = process.env.CONTRACT_ADDRESS || deployment?.address;
  if (!contractAddress) {
    return res.status(503).json({
      error:
        `No deployment found for network "${network.name}". Run "npm run deploy:testnet" ` +
        `(or "npm run deploy" for mainnet) first, or set CONTRACT_ADDRESS in .env.`,
    });
  }
  res.json({
    contractAddress,
    rpcUrl: network.rpcUrl,
    chainId: network.chainId,
    networkName: network.name,
    explorerUrl: `${network.explorerUrl}/address/${contractAddress}`,
    // Lets the dashboard scan ReceiptIssued events starting from the contract's
    // own deployment block instead of from genesis — null is fine, the client
    // falls back to a bounded recent-block window if it's missing.
    deployedAtBlock: deployment?.deployedAtBlock ?? null,
  });
});

/// Business names are self-reported at WhatsApp onboarding, stored locally, and
/// never written on-chain — this is what lets the dashboard show "Amina's Rice and
/// Grains" instead of a bare hash, without putting a business name on a public
/// ledger. Explicitly NOT part of the trust model: the credit score and tier are
/// still computed purely from on-chain history, this is display only.
app.get("/api/merchants", (req, res) => {
  res.json(store.allMerchants());
});

app.get("/api/receipts", (req, res) => {
  const merchantHash = req.query.merchant;
  if (!merchantHash) return res.status(400).json({ error: "merchant query param is required" });
  res.json(store.receiptsForMerchant(merchantHash));
});

/// Expenses, same off-chain caveat as everything else in the local store: logged by
/// the merchant over WhatsApp, never verified, never on-chain. Omit ?merchant= to get
/// every expense across all merchants (used for the dashboard-wide cash flow view).
app.get("/api/expenses", (req, res) => {
  const merchantHash = req.query.merchant;
  res.json(merchantHash ? store.expensesForMerchant(merchantHash) : Object.values(store.allExpenses()));
});

/// Reuses the exact same computeProfit() the WhatsApp /profit command uses, so the
/// dashboard and the chat bot can never disagree about a merchant's numbers.
app.get("/api/profit", (req, res) => {
  const merchantHash = req.query.merchant;
  if (!merchantHash) return res.status(400).json({ error: "merchant query param is required" });
  const period = req.query.period || "all";
  const p = computeProfit(store, merchantHash, period);
  res.json({ ...p, periodLabel: PERIOD_LABELS[p.period] || "All time" });
});

app.get("/api/receipt/:id/pdf", async (req, res) => {
  try {
    const receipt = store.getReceipt(req.params.id);
    if (!receipt) return res.status(404).send("Receipt not found");
    const merchant = store.getMerchant(receipt.merchantHash);

    const deployment = readDeployment();
    const contractAddress = process.env.CONTRACT_ADDRESS || deployment?.address;
    if (!contractAddress) return res.status(503).send("No deployment configured");

    const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "abi", "ReceiptLedger.json"), "utf8"));
    const provider = new ethers.JsonRpcProvider(network.rpcUrl);
    const contract = new ethers.Contract(contractAddress, abi, provider);
    const [profile, score] = await Promise.all([
      contract.getMerchantProfile(receipt.merchantHash),
      contract.creditScore(receipt.merchantHash),
    ]);

    const pdfBuffer = await generateReceiptPdf({
      receiptId: receipt.receiptId,
      businessName: merchant?.businessName,
      merchantHash: receipt.merchantHash,
      item: receipt.item,
      buyerName: receipt.buyerName,
      amountMinor: receipt.amountMinor,
      currencyCode: receipt.currencyCode,
      txHash: receipt.txHash,
      explorerTxUrl: `${network.explorerUrl}/tx/${receipt.txHash}`,
      networkLabel: network.name,
      timestamp: receipt.timestamp,
      tier: TIER_NAMES[Number(profile.tier)],
      creditScore: Number(score),
      standingLabel: "Current standing",
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Credora-Receipt-${receipt.receiptId}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("PDF generation failed:", err);
    res.status(500).send("Failed to generate PDF");
  }
});

function readDeployment() {
  const file = path.join(__dirname, "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

app.listen(PORT, () => {
  console.log(`Credora sales dashboard (${network.name}): http://localhost:${PORT}/dashboard.html`);
});
