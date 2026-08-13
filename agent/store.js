const fs = require("fs");
const path = require("path");

// A minimal, file-backed local store for data that deliberately never touches the
// chain: merchant display names (self-reported at onboarding, not attested by
// anyone) and human-readable receipt details (item, buyer name) needed to render a
// real receipt. The chain stays the actual trust anchor for anything the credit
// story depends on — amounts, tiers, credit scores. This store only adds
// convenience and identity on top of that, and is honest about not being verified.
//
// Deliberately a flat JSON file, not a database — write volume here is one
// registration and a handful of receipts a day for a hackathon deployment. Swap for
// a real datastore before this needs to survive concurrent writers or real scale.

function dataDir(networkName) {
  const dir = path.join(__dirname, "..", "data", networkName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class LocalStore {
  constructor(networkName) {
    this.dir = dataDir(networkName);
    this.merchantsFile = path.join(this.dir, "merchants.json");
    this.receiptsFile = path.join(this.dir, "receipts.json");
    this.expensesFile = path.join(this.dir, "expenses.json");
  }

  // ── Merchants ──────────────────────────────────────────────────────────
  getMerchant(merchantHash) {
    return readJson(this.merchantsFile, {})[merchantHash] || null;
  }

  setMerchant(merchantHash, { businessName }) {
    const all = readJson(this.merchantsFile, {});
    all[merchantHash] = {
      businessName,
      registeredAt: all[merchantHash]?.registeredAt || new Date().toISOString(),
    };
    writeJsonAtomic(this.merchantsFile, all);
    return all[merchantHash];
  }

  allMerchants() {
    return readJson(this.merchantsFile, {});
  }

  // ── Receipts ───────────────────────────────────────────────────────────
  saveReceipt(receiptId, record) {
    const all = readJson(this.receiptsFile, {});
    all[receiptId] = { ...record, receiptId: String(receiptId) };
    writeJsonAtomic(this.receiptsFile, all);
  }

  getReceipt(receiptId) {
    return readJson(this.receiptsFile, {})[String(receiptId)] || null;
  }

  receiptsForMerchant(merchantHash, sinceTimestamp = 0) {
    const all = readJson(this.receiptsFile, {});
    return Object.values(all)
      .filter(
        (r) => r.merchantHash?.toLowerCase() === merchantHash?.toLowerCase() && (r.timestamp || 0) >= sinceTimestamp
      )
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  // ── Expenses ───────────────────────────────────────────────────────────
  // Off-chain by design, same as business names: expenses are self-reported, there
  // is nothing to attest or verify, and they exist purely so a merchant can see
  // their own net profit. They never factor into the on-chain credit score.
  saveExpense(record) {
    const all = readJson(this.expensesFile, {});
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    all[id] = { ...record, id };
    writeJsonAtomic(this.expensesFile, all);
    return id;
  }

  expensesForMerchant(merchantHash, sinceTimestamp = 0) {
    const all = readJson(this.expensesFile, {});
    return Object.values(all)
      .filter(
        (e) => e.merchantHash?.toLowerCase() === merchantHash?.toLowerCase() && (e.timestamp || 0) >= sinceTimestamp
      )
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  allExpenses() {
    return readJson(this.expensesFile, {});
  }
}

module.exports = { LocalStore };
