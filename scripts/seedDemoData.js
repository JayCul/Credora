// Dev/demo utility: seeds a few merchants with varied sales history so the sales
// dashboard has something to show without needing a live WhatsApp flow first.
// Usage: npx hardhat run scripts/seedDemoData.js --network <localhost|botchainTestnet|botchain>
const hre = require("hardhat");
const path = require("path");
const fs = require("fs");
const { hashPhone, hashText, toBytes3 } = require("../agent/hashing");
const { NETWORKS } = require("../agent/network");
require("dotenv").config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const salt = process.env.PHONE_HASH_SALT;
  if (!salt) throw new Error("Set PHONE_HASH_SALT in .env first.");

  // This writes fake merchants and fake sales permanently on-chain. Fine on a
  // testnet or local node, a real problem on mainnet, where a lender could later
  // read "Amina's Rice & Grains" as if it were a genuine business. Require an
  // explicit opt-in rather than let `npm run seed` (which targets --network
  // botchain by default) fire real transactions at production by habit.
  if (hre.network.name === NETWORKS.mainnet.name && process.env.CONFIRM_MAINNET_SEED !== "yes") {
    throw new Error(
      "Refusing to seed demo data on mainnet. This permanently writes fake receipts to " +
        "production. If you really mean to do this (e.g. a live demo environment), re-run " +
        "with CONFIRM_MAINNET_SEED=yes set."
    );
  }

  const deploymentFile = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const { address } = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const ledger = await hre.ethers.getContractAt("ReceiptLedger", address);

  const merchants = [
    { phone: "+2348012340001", label: "Amina's Rice & Grains", sales: [15000, 22000, 9000, 30000, 18000, 27000] },
    { phone: "+2348012340002", label: "Musa Fabrics", sales: [45000, 60000] },
    { phone: "+2348012340003", label: "Chidi Electronics", sales: [82000, 95000, 88000, 76000, 91000, 84000, 79000] },
  ];

  const isLocal = hre.network.name === "hardhat" || hre.network.name === "localhost";

  // Real networks don't let us fast-forward the clock like Hardhat's in-memory node
  // does — the on-chain cooldown (minReceiptInterval) is a real 30s wait between
  // receipts for the same merchant. Rather than actually sleep that long for every
  // one of ~15 seed receipts, temporarily lower it (admin-only) for the duration of
  // seeding, then restore it — this is demo scaffolding, not a weakening of the real
  // deployed default, and it only works at all because this script assumes the
  // deployer also holds DEFAULT_ADMIN_ROLE (true for the hackathon setup in .env.example).
  let originalInterval = null;
  if (!isLocal) {
    try {
      originalInterval = await ledger.minReceiptInterval();
      const tx = await ledger.setMinReceiptInterval(2);
      await tx.wait();
      console.log(`Temporarily lowered minReceiptInterval ${originalInterval}s -> 2s for seeding.`);
    } catch (err) {
      console.warn(
        "Could not lower minReceiptInterval (signer may not hold DEFAULT_ADMIN_ROLE) — " +
          "falling back to real 31s waits between receipts. This will take a while."
      );
    }
  }

  try {
    for (const m of merchants) {
      const merchantHash = hashPhone(m.phone, salt);
      console.log(`\n${m.label} → ${merchantHash}`);
      for (const [i, naira] of m.sales.entries()) {
        const amountMinor = naira * 100;
        const itemHash = hashText(`demo item ${i}`);
        const buyerHash = hashText(`anon:${merchantHash}:${i}`);
        const tx = await ledger.issueReceipt(
          merchantHash,
          buyerHash,
          amountMinor,
          toBytes3("NGN"),
          itemHash,
          `demo sale ${i}`
        );
        await tx.wait();
        process.stdout.write(".");
        if (isLocal) {
          // jump a day forward so the streak logic has something interesting to show
          await hre.network.provider.send("evm_increaseTime", [60 * 60 * 24]);
          await hre.network.provider.send("evm_mine");
        } else {
          await sleep(originalInterval !== null ? 2500 : 31000);
        }
      }
    }
  } finally {
    if (originalInterval !== null) {
      const tx = await ledger.setMinReceiptInterval(originalInterval);
      await tx.wait();
      console.log(`\nRestored minReceiptInterval to ${originalInterval}s.`);
    }
  }

  console.log("\nDone. Paste any merchantHash above into the dashboard's search box.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
