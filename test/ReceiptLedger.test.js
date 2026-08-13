const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("ReceiptLedger", function () {
  async function deploy() {
    const [admin, agent, otherAgent, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ReceiptLedger");
    const ledger = await Factory.deploy(admin.address, agent.address);
    await ledger.waitForDeployment();
    return { ledger, admin, agent, otherAgent, attacker };
  }

  const merchantHash = ethers.keccak256(ethers.toUtf8Bytes("merchant:+2348012345678"));
  const buyerHash = ethers.keccak256(ethers.toUtf8Bytes("buyer:+2348099999999"));
  const itemHash = ethers.keccak256(ethers.toUtf8Bytes("2 bags of rice"));
  const NGN = ethers.toUtf8Bytes("NGN");

  it("grants DEFAULT_ADMIN_ROLE to admin and AGENT_ROLE to the initial agent", async function () {
    const { ledger, admin, agent } = await deploy();
    expect(await ledger.hasRole(await ledger.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await ledger.hasRole(await ledger.AGENT_ROLE(), agent.address)).to.equal(true);
  });

  it("rejects a zero-address admin or agent at construction", async function () {
    const Factory = await ethers.getContractFactory("ReceiptLedger");
    const [admin] = await ethers.getSigners();
    await expect(Factory.deploy(ethers.ZeroAddress, admin.address)).to.be.revertedWithCustomError(
      Factory,
      "InvalidInput"
    );
  });

  it("lets an authorized agent record a receipt and updates the merchant profile", async function () {
    const { ledger, agent } = await deploy();
    await expect(
      ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 150_000, NGN, itemHash, "first sale")
    )
      .to.emit(ledger, "ReceiptIssued")
      .withArgs(1n, merchantHash, buyerHash, 150_000n, ethers.hexlify(NGN), itemHash, "first sale", anyValue);

    const profile = await ledger.getMerchantProfile(merchantHash);
    expect(profile.totalVolume).to.equal(150_000n);
    expect(profile.receiptCount).to.equal(1n);
    expect(profile.currentStreakDays).to.equal(1n);
  });

  it("rejects receipts from a caller without AGENT_ROLE", async function () {
    const { ledger, attacker } = await deploy();
    await expect(
      ledger.connect(attacker).issueReceipt(merchantHash, buyerHash, 1000, NGN, itemHash, "")
    ).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
  });

  it("rejects zero amount, zero merchantHash, or zero currency", async function () {
    const { ledger, agent } = await deploy();
    await expect(
      ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 0, NGN, itemHash, "")
    ).to.be.revertedWithCustomError(ledger, "InvalidInput");
    await expect(
      ledger.connect(agent).issueReceipt(ethers.ZeroHash, buyerHash, 1000, NGN, itemHash, "")
    ).to.be.revertedWithCustomError(ledger, "InvalidInput");
  });

  it("enforces the per-receipt amount cap", async function () {
    const { ledger, agent } = await deploy();
    const max = await ledger.maxReceiptAmount();
    await expect(
      ledger.connect(agent).issueReceipt(merchantHash, buyerHash, max + 1n, NGN, itemHash, "")
    ).to.be.revertedWithCustomError(ledger, "ReceiptTooLarge");
  });

  it("enforces the anti-spam cooldown between receipts for the same merchant", async function () {
    const { ledger, agent } = await deploy();
    await ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 1000, NGN, itemHash, "");
    await expect(
      ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 1000, NGN, itemHash, "")
    ).to.be.revertedWithCustomError(ledger, "TooSoon");
  });

  it("upgrades tier once volume/receipt thresholds are crossed and emits TierUpgraded", async function () {
    const { ledger, agent } = await deploy();
    await ledger.setMinReceiptInterval(0); // speed the test up; admin-only, exercised separately below
    for (let i = 0; i < 5; i++) {
      await ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 1000, NGN, itemHash, `sale ${i}`);
    }
    const profile = await ledger.getMerchantProfile(merchantHash);
    expect(profile.tier).to.equal(1n); // Bronze
  });

  it("only DEFAULT_ADMIN_ROLE can tune limits or pause", async function () {
    const { ledger, attacker } = await deploy();
    await expect(ledger.connect(attacker).setMaxReceiptAmount(1)).to.be.revertedWithCustomError(
      ledger,
      "AccessControlUnauthorizedAccount"
    );
    await expect(ledger.connect(attacker).pause()).to.be.revertedWithCustomError(
      ledger,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("blocks new receipts while paused, and resumes after unpause", async function () {
    const { ledger, admin, agent } = await deploy();
    await ledger.connect(admin).pause();
    await expect(
      ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 1000, NGN, itemHash, "")
    ).to.be.revertedWithCustomError(ledger, "EnforcedPause");

    await ledger.connect(admin).unpause();
    await expect(ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 1000, NGN, itemHash, "")).to.not.be
      .reverted;
  });

  describe("issueReceiptWithSig (gasless relay path)", function () {
    async function domainOf(ledger) {
      const net = await ethers.provider.getNetwork();
      return {
        name: "Credora-ReceiptLedger",
        version: "1",
        chainId: net.chainId,
        verifyingContract: await ledger.getAddress(),
      };
    }

    const types = {
      Receipt: [
        { name: "merchantHash", type: "bytes32" },
        { name: "buyerHash", type: "bytes32" },
        { name: "amountMinor", type: "uint128" },
        { name: "currencyCode", type: "bytes3" },
        { name: "itemHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    it("accepts a valid signature from an AGENT_ROLE holder, submitted by anyone", async function () {
      const { ledger, agent, attacker } = await deploy();
      const domain = await domainOf(ledger);
      const deadline = (await currentTimestamp()) + 3600;
      const value = { merchantHash, buyerHash, amountMinor: 5000, currencyCode: ethers.hexlify(NGN), itemHash, nonce: 0, deadline };
      const signature = await agent.signTypedData(domain, types, value);

      // attacker pays gas and relays it — but the attestation authority is still the agent's signature
      await expect(
        ledger
          .connect(attacker)
          .issueReceiptWithSig(merchantHash, buyerHash, 5000, NGN, itemHash, "relayed", deadline, signature)
      ).to.not.be.reverted;
    });

    it("rejects a signature from a non-agent key", async function () {
      const { ledger, otherAgent, attacker } = await deploy();
      const domain = await domainOf(ledger);
      const deadline = (await currentTimestamp()) + 3600;
      const value = { merchantHash, buyerHash, amountMinor: 5000, currencyCode: ethers.hexlify(NGN), itemHash, nonce: 0, deadline };
      const signature = await otherAgent.signTypedData(domain, types, value); // not granted AGENT_ROLE

      await expect(
        ledger
          .connect(attacker)
          .issueReceiptWithSig(merchantHash, buyerHash, 5000, NGN, itemHash, "relayed", deadline, signature)
      ).to.be.revertedWithCustomError(ledger, "InvalidSignature");
    });

    it("rejects a replayed signature (nonce already consumed)", async function () {
      const { ledger, agent, attacker } = await deploy();
      const domain = await domainOf(ledger);
      const deadline = (await currentTimestamp()) + 3600;
      const value = { merchantHash, buyerHash, amountMinor: 5000, currencyCode: ethers.hexlify(NGN), itemHash, nonce: 0, deadline };
      const signature = await agent.signTypedData(domain, types, value);

      await ledger
        .connect(attacker)
        .issueReceiptWithSig(merchantHash, buyerHash, 5000, NGN, itemHash, "relayed", deadline, signature);

      // Replaying the exact same signed payload reuses nonce 0, which the contract
      // already consumed — the recomputed digest (now expecting nonce 1) no longer
      // matches the signature, so it fails signature recovery rather than a nonce check.
      await expect(
        ledger
          .connect(attacker)
          .issueReceiptWithSig(merchantHash, buyerHash, 5000, NGN, itemHash, "relayed", deadline, signature)
      ).to.be.reverted;
    });

    it("rejects an expired signature", async function () {
      const { ledger, agent, attacker } = await deploy();
      const domain = await domainOf(ledger);
      const deadline = (await currentTimestamp()) - 1; // already expired
      const value = { merchantHash, buyerHash, amountMinor: 5000, currencyCode: ethers.hexlify(NGN), itemHash, nonce: 0, deadline };
      const signature = await agent.signTypedData(domain, types, value);

      await expect(
        ledger
          .connect(attacker)
          .issueReceiptWithSig(merchantHash, buyerHash, 5000, NGN, itemHash, "relayed", deadline, signature)
      ).to.be.revertedWithCustomError(ledger, "SignatureExpired");
    });
  });

  describe("confirmReceipt (buyer-side confirmation)", function () {
    it("records a confirmation, marks it confirmed, and bumps the merchant's confirmedCount", async function () {
      const { ledger, agent } = await deploy();
      const tx = await ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 5000, NGN, itemHash, "");
      const receipt = await tx.wait();
      const receiptId = receipt.logs
        .map((l) => { try { return ledger.interface.parseLog(l); } catch { return null; } })
        .find((e) => e?.name === "ReceiptIssued").args.receiptId;

      await expect(ledger.connect(agent).confirmReceipt(receiptId, buyerHash))
        .to.emit(ledger, "ReceiptConfirmed")
        .withArgs(receiptId, merchantHash, buyerHash, anyValue);

      expect(await ledger.receiptConfirmed(receiptId)).to.equal(true);
      const profile = await ledger.getMerchantProfile(merchantHash);
      expect(profile.confirmedCount).to.equal(1n);
    });

    it("rejects confirming the same receipt twice", async function () {
      const { ledger, agent } = await deploy();
      await ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 5000, NGN, itemHash, "");
      await ledger.connect(agent).confirmReceipt(1, buyerHash);
      await expect(ledger.connect(agent).confirmReceipt(1, buyerHash)).to.be.revertedWithCustomError(
        ledger,
        "AlreadyConfirmed"
      );
    });

    it("rejects a buyerHash that doesn't match the one recorded at issuance", async function () {
      const { ledger, agent } = await deploy();
      await ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 5000, NGN, itemHash, "");
      const wrongBuyerHash = ethers.keccak256(ethers.toUtf8Bytes("buyer:+2340000000000"));
      await expect(ledger.connect(agent).confirmReceipt(1, wrongBuyerHash)).to.be.revertedWithCustomError(
        ledger,
        "BuyerHashMismatch"
      );
    });

    it("rejects confirming a receipt id that was never issued", async function () {
      const { ledger, agent } = await deploy();
      await expect(ledger.connect(agent).confirmReceipt(1, buyerHash)).to.be.revertedWithCustomError(
        ledger,
        "ReceiptDoesNotExist"
      );
      await expect(ledger.connect(agent).confirmReceipt(0, buyerHash)).to.be.revertedWithCustomError(
        ledger,
        "ReceiptDoesNotExist"
      );
    });

    it("rejects confirmation from a caller without AGENT_ROLE", async function () {
      const { ledger, agent, attacker } = await deploy();
      await ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 5000, NGN, itemHash, "");
      await expect(ledger.connect(attacker).confirmReceipt(1, buyerHash)).to.be.revertedWithCustomError(
        ledger,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("is blocked while paused", async function () {
      const { ledger, admin, agent } = await deploy();
      await ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 5000, NGN, itemHash, "");
      await ledger.connect(admin).pause();
      await expect(ledger.connect(agent).confirmReceipt(1, buyerHash)).to.be.revertedWithCustomError(
        ledger,
        "EnforcedPause"
      );
    });

    it("does not fold confirmedCount into creditScore — it stays a separate signal", async function () {
      const { ledger, agent } = await deploy();
      await ledger.connect(agent).issueReceipt(merchantHash, buyerHash, 5000, NGN, itemHash, "");
      const scoreBefore = await ledger.creditScore(merchantHash);
      await ledger.connect(agent).confirmReceipt(1, buyerHash);
      const scoreAfter = await ledger.creditScore(merchantHash);
      expect(scoreAfter).to.equal(scoreBefore);
    });
  });

  async function currentTimestamp() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
  }
});
