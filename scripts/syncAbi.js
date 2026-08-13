// Keeps public/abi/ReceiptLedger.json (what the browser dashboard loads) in sync
// with the actually-compiled contract. Without this, a contract change compiles and
// deploys fine, tests all pass, and the dashboard silently keeps using a stale ABI
// that's just missing whatever changed — exactly the kind of bug that only shows up
// once you actually load the page and check, not from reading the code.
const fs = require("fs");
const path = require("path");

function syncAbi() {
  const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", "ReceiptLedger.sol", "ReceiptLedger.json");
  const outPath = path.join(__dirname, "..", "public", "abi", "ReceiptLedger.json");
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Contract not compiled — looked for ${artifactPath}`);
  }
  const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(abi, null, 2));
  return abi.length;
}

if (require.main === module) {
  const count = syncAbi();
  console.log(`Synced public/abi/ReceiptLedger.json (${count} ABI entries)`);
}

module.exports = { syncAbi };
