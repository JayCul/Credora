const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { hashPhone, hashText, toBytes3 } = require("./hashing");
const { resolveNetwork } = require("./network");

const TIER_NAMES = ["Unrated", "Bronze", "Silver", "Gold", "Platinum"];

function loadDeployment(networkName) {
  if (process.env.CONTRACT_ADDRESS) {
    return { address: process.env.CONTRACT_ADDRESS };
  }
  const file = path.join(__dirname, "..", "deployments", `${networkName}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment found at ${file}. Run "npm run deploy" (mainnet) or "npm run deploy:testnet" first, ` +
        `or set CONTRACT_ADDRESS in .env.`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadAbi() {
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "ReceiptLedger.sol",
    "ReceiptLedger.json"
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Contract not compiled — run "npx hardhat compile" first (looked in ${artifactPath}).`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")).abi;
}

/// Best-effort decode of a Solidity custom error into a message a merchant can read
/// over WhatsApp, instead of a raw 0x-prefixed revert blob.
function describeRevert(contract, err) {
  const data = err?.data ?? err?.error?.data ?? err?.info?.error?.data;
  if (!data || typeof data !== "string") return null;
  try {
    const parsed = contract.interface.parseError(data);
    if (!parsed) return null;
    switch (parsed.name) {
      case "TooSoon": {
        const nextAllowedAt = Number(parsed.args[0]);
        const waitSec = Math.max(nextAllowedAt - Math.floor(Date.now() / 1000), 1);
        return `Please wait ~${waitSec}s before recording another sale (anti-spam cooldown).`;
      }
      case "ReceiptTooLarge":
        return `That amount is above the current per-receipt limit. An admin can raise it if this is a legitimate large sale.`;
      case "InvalidInput":
        return `That sale is missing required details (item, amount, or currency).`;
      case "SignatureExpired":
        return `That request expired before it reached the chain. Please try again.`;
      case "InvalidSignature":
        return `That request's signature didn't check out. Please try again.`;
      default:
        return `Contract rejected this: ${parsed.name}`;
    }
  } catch {
    return null;
  }
}

class ContractClient {
  constructor() {
    if (!process.env.AGENT_PRIVATE_KEY) {
      throw new Error("AGENT_PRIVATE_KEY is not set in .env — the agent has no wallet to sign with.");
    }
    if (!process.env.PHONE_HASH_SALT) {
      throw new Error("PHONE_HASH_SALT is not set in .env — refusing to hash phone numbers without a pepper.");
    }

    this.network = resolveNetwork();
    const deployment = loadDeployment(this.network.name);
    const abi = loadAbi();

    // Static chainId here is intentional (unlike the dashboard's auto-detect): this
    // client signs and pays for real transactions, so a hard mismatch between
    // .env's NETWORK and whatever the RPC actually answers with should fail loudly
    // rather than silently signing for the wrong chain.
    this.provider = new ethers.JsonRpcProvider(this.network.rpcUrl, this.network.chainId);
    this.wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, this.provider);
    this.contract = new ethers.Contract(deployment.address, abi, this.wallet);
    this.address = deployment.address;
    this.salt = process.env.PHONE_HASH_SALT;

    console.log(`ContractClient: network=${this.network.name} (chainId ${this.network.chainId})`);
  }

  hashPhone(phone) {
    return hashPhone(phone, this.salt);
  }

  /// Reads a merchant's on-chain profile without spending gas — used both to feed
  /// recent-average context into the fraud check and to report tier/credit score
  /// back to the merchant after a successful write.
  async getMerchantSummary(merchantPhone) {
    const merchantHash = this.hashPhone(merchantPhone);
    const [profile, score] = await Promise.all([
      this.contract.getMerchantProfile(merchantHash),
      this.contract.creditScore(merchantHash),
    ]);
    return {
      merchantHash,
      totalVolume: profile.totalVolume,
      receiptCount: profile.receiptCount,
      currentStreakDays: profile.currentStreakDays,
      longestStreakDays: profile.longestStreakDays,
      tier: TIER_NAMES[Number(profile.tier)],
      creditScore: Number(score),
    };
  }

  /// Submits one attested sale. Runs a free `staticCall` preflight first so guard-clause
  /// reverts (cooldown, cap, bad input) surface instantly as a friendly WhatsApp reply
  /// instead of costing gas and waiting a full block for a mined failure.
  async issueReceipt({ merchantPhone, buyerPhone, amountMinor, currencyCode, item, memo }) {
    const merchantHash = this.hashPhone(merchantPhone);
    // Buyers usually aren't reachable on WhatsApp at all. Rather than leave buyerHash
    // at bytes32(0) — which would silently collide every anonymous buyer into one
    // bucket and make later per-buyer analytics meaningless — derive a hash unique to
    // this transaction instead.
    const buyerHash = buyerPhone
      ? this.hashPhone(buyerPhone)
      : hashText(`anon:${merchantHash}:${item}:${Math.floor(Date.now() / 60000)}`);
    const itemHash = hashText(item || "");
    const currencyBytes3 = toBytes3(currencyCode);
    const amount = BigInt(amountMinor);

    const args = [merchantHash, buyerHash, amount, currencyBytes3, itemHash, memo || ""];

    try {
      await this.contract.issueReceipt.staticCall(...args);
    } catch (err) {
      const friendly = describeRevert(this.contract, err);
      throw new Error(friendly || err.shortMessage || err.message);
    }

    let receipt;
    try {
      const tx = await this.contract.issueReceipt(...args);
      receipt = await tx.wait();
    } catch (err) {
      const friendly = describeRevert(this.contract, err);
      throw new Error(friendly || err.shortMessage || err.message);
    }

    let receiptId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed?.name === "ReceiptIssued") {
          receiptId = parsed.args.receiptId.toString();
          break;
        }
      } catch {
        // not one of our events, ignore
      }
    }

    const summary = await this.getMerchantSummary(merchantPhone);

    return {
      txHash: receipt.hash,
      receiptId,
      tier: summary.tier,
      creditScore: summary.creditScore,
      explorerUrl: `${this.network.explorerUrl}/tx/${receipt.hash}`,
    };
  }
}

module.exports = { ContractClient };
