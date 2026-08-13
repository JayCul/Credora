// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ReceiptLedger — Credora's on-chain reputation ledger for informal commerce
/// @author Credora (BOT Chain Africa Builder Challenge 2026)
/// @notice A WhatsApp-driven AI agent attests to off-chain sales on behalf of merchants
///         who have no crypto wallet and no prior credit history, building a portable,
///         tamper-evident sales/reputation record that a microlender can treat as an
///         alternative-credit signal.
/// @dev Deliberate design decision: NO VALUE EVER MOVES THROUGH THIS CONTRACT. It is a
///      pure attestation/reputation ledger, not a payments or escrow system. That keeps
///      the trust boundary small and auditable — the worst a compromised agent key can do
///      is write bogus attestations, and that blast radius is itself bounded on-chain by
///      `maxReceiptAmount` and `minReceiptInterval` (both admin-tunable and pausable),
///      not left to off-chain hope. Phone numbers are never stored on-chain — callers pass
///      salted keccak256 hashes (see agent/ for the hashing scheme) so no PII is public.
contract ReceiptLedger is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;

    // ─────────────────────────────────────────────────────────────────────
    // Roles
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Holders may submit receipts directly (`issueReceipt`) or sign them
    ///         off-chain for a third party to relay (`issueReceiptWithSig`). Multiple
    ///         agent workers can hold this role simultaneously, and it can be revoked
    ///         instantly by DEFAULT_ADMIN_ROLE if a key is ever compromised.
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    // ─────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────

    enum Tier {
        Unrated,
        Bronze,
        Silver,
        Gold,
        Platinum
    }

    struct MerchantProfile {
        uint128 totalVolume; // cumulative amountMinor across all receipts (e.g. kobo)
        uint64 receiptCount;
        uint64 lastReceiptAt; // unix timestamp of the last accepted receipt
        uint64 lastReceiptDay; // lastReceiptAt / 1 days, used for streak accounting
        uint32 currentStreakDays;
        uint32 longestStreakDays;
        uint32 confirmedCount; // subset of receiptCount independently confirmed by the buyer
        Tier tier;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────

    mapping(bytes32 => MerchantProfile) public merchants;
    mapping(bytes32 => uint256) public nonces; // replay protection, keyed per merchantHash
    uint64 public receiptCounter;

    // Per-receipt data needed to independently verify and record a buyer's later
    // confirmation. Populated once at issuance, never mutated afterward.
    mapping(uint64 => bytes32) public receiptBuyerHash;
    mapping(uint64 => bytes32) public receiptMerchantHash;
    mapping(uint64 => bool) public receiptConfirmed;

    /// @notice Upper bound on a single receipt's declared value. Caps the damage a
    ///         compromised or malfunctioning agent can do in one transaction.
    uint128 public maxReceiptAmount = 10_000_000; // e.g. NGN 100,000.00 in kobo

    /// @notice Minimum seconds between two receipts for the same merchant. Blocks
    ///         rapid-fire wash-trading of the reputation score.
    uint32 public minReceiptInterval = 30;

    // Tier thresholds, exposed as public constants (not just inlined in _computeTier)
    // so any off-chain dashboard reads the exact same numbers the contract enforces —
    // no duplicated magic numbers to drift out of sync between chain and UI.
    uint64 public constant BRONZE_MIN_RECEIPTS = 5;
    uint64 public constant SILVER_MIN_RECEIPTS = 20;
    uint128 public constant SILVER_MIN_VOLUME = 500_000;
    uint64 public constant GOLD_MIN_RECEIPTS = 50;
    uint128 public constant GOLD_MIN_VOLUME = 2_000_000;
    uint64 public constant PLATINUM_MIN_RECEIPTS = 150;
    uint128 public constant PLATINUM_MIN_VOLUME = 10_000_000;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event ReceiptIssued(
        uint64 indexed receiptId,
        bytes32 indexed merchantHash,
        bytes32 indexed buyerHash,
        uint128 amountMinor,
        bytes3 currencyCode,
        bytes32 itemHash,
        string memo,
        uint64 timestamp
    );
    event TierUpgraded(bytes32 indexed merchantHash, Tier oldTier, Tier newTier);
    event MaxReceiptAmountUpdated(uint128 oldMax, uint128 newMax);
    event MinReceiptIntervalUpdated(uint32 oldInterval, uint32 newInterval);
    /// @notice A second, independent attestation: the buyer confirmed this sale
    ///         actually happened, separately from and after the merchant's original
    ///         report. Its own timestamp is itself part of the signal — a real
    ///         confirmation takes real time to arrive.
    event ReceiptConfirmed(uint64 indexed receiptId, bytes32 indexed merchantHash, bytes32 indexed buyerHash, uint64 timestamp);

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error InvalidInput();
    error ReceiptTooLarge(uint128 amount, uint128 max);
    error TooSoon(uint64 nextAllowedAt);
    error SignatureExpired();
    error InvalidSignature();
    error ReceiptDoesNotExist();
    error AlreadyConfirmed();
    error BuyerHashMismatch();

    // ─────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────

    /// @param admin Address holding DEFAULT_ADMIN_ROLE. In production this MUST be a
    ///        multisig, never a single hot key — grant it separately from `initialAgent`.
    /// @param initialAgent The first WhatsApp-agent wallet authorized to submit receipts.
    constructor(address admin, address initialAgent) EIP712("Credora-ReceiptLedger", "1") {
        if (admin == address(0) || initialAgent == address(0)) revert InvalidInput();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, initialAgent);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Agent-submitted receipts — the path the live WhatsApp agent uses
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Record a sale attested by the calling agent. Reverts under any of the
    ///         guard conditions documented on `_recordReceipt`.
    function issueReceipt(
        bytes32 merchantHash,
        bytes32 buyerHash,
        uint128 amountMinor,
        bytes3 currencyCode,
        bytes32 itemHash,
        string calldata memo
    ) external onlyRole(AGENT_ROLE) whenNotPaused nonReentrant returns (uint64) {
        return _recordReceipt(merchantHash, buyerHash, amountMinor, currencyCode, itemHash, memo);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Signature-based receipts — gasless relay path
    // ─────────────────────────────────────────────────────────────────────
    //
    // Lets an agent SIGN an attestation off-chain (e.g. on a machine that never holds
    // gas funds) while ANY relayer submits and pays for the transaction. This separates
    // "who is authorized to attest" from "who pays gas", which is the pattern that would
    // let Credora later sponsor gas for merchants entirely — they never need to know a
    // blockchain is involved. Nonce + deadline together close the standard replay holes:
    // a captured signature cannot be resubmitted later, on another chain, or twice.

    bytes32 private constant RECEIPT_TYPEHASH = keccak256(
        "Receipt(bytes32 merchantHash,bytes32 buyerHash,uint128 amountMinor,bytes3 currencyCode,bytes32 itemHash,uint256 nonce,uint256 deadline)"
    );

    function issueReceiptWithSig(
        bytes32 merchantHash,
        bytes32 buyerHash,
        uint128 amountMinor,
        bytes3 currencyCode,
        bytes32 itemHash,
        string calldata memo,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant returns (uint64) {
        if (block.timestamp > deadline) revert SignatureExpired();

        uint256 nonce = nonces[merchantHash]++;
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIPT_TYPEHASH, merchantHash, buyerHash, amountMinor, currencyCode, itemHash, nonce, deadline
            )
        );
        address signer = _hashTypedDataV4(structHash).recover(signature);
        if (!hasRole(AGENT_ROLE, signer)) revert InvalidSignature();

        return _recordReceipt(merchantHash, buyerHash, amountMinor, currencyCode, itemHash, memo);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internal accounting
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Applies, in order: input validation, the per-merchant cooldown, the
    ///      per-receipt cap, then updates volume/streak/tier and emits events.
    ///      Both public entry points funnel through here so the guards can never
    ///      be bypassed by one of the two paths drifting out of sync with the other.
    function _recordReceipt(
        bytes32 merchantHash,
        bytes32 buyerHash,
        uint128 amountMinor,
        bytes3 currencyCode,
        bytes32 itemHash,
        string calldata memo
    ) internal returns (uint64 receiptId) {
        if (merchantHash == bytes32(0) || amountMinor == 0 || currencyCode == bytes3(0)) {
            revert InvalidInput();
        }
        if (amountMinor > maxReceiptAmount) revert ReceiptTooLarge(amountMinor, maxReceiptAmount);

        MerchantProfile storage m = merchants[merchantHash];
        uint64 nowTs = uint64(block.timestamp);

        if (m.lastReceiptAt != 0 && nowTs < m.lastReceiptAt + minReceiptInterval) {
            revert TooSoon(m.lastReceiptAt + minReceiptInterval);
        }

        uint64 today = nowTs / 1 days;
        if (m.lastReceiptAt == 0) {
            m.currentStreakDays = 1;
        } else if (today == m.lastReceiptDay) {
            // Same UTC day as the last sale — volume still counts, streak unchanged.
        } else if (today == m.lastReceiptDay + 1) {
            m.currentStreakDays += 1;
        } else {
            m.currentStreakDays = 1; // streak broken, restart
        }
        if (m.currentStreakDays > m.longestStreakDays) {
            m.longestStreakDays = m.currentStreakDays;
        }

        m.totalVolume += amountMinor;
        m.receiptCount += 1;
        m.lastReceiptAt = nowTs;
        m.lastReceiptDay = today;

        Tier newTier = _computeTier(m.receiptCount, m.totalVolume);
        if (newTier != m.tier) {
            emit TierUpgraded(merchantHash, m.tier, newTier);
            m.tier = newTier;
        }

        receiptId = ++receiptCounter;
        receiptBuyerHash[receiptId] = buyerHash;
        receiptMerchantHash[receiptId] = merchantHash;
        emit ReceiptIssued(receiptId, merchantHash, buyerHash, amountMinor, currencyCode, itemHash, memo, nowTs);
    }

    /// @notice Records the buyer's own confirmation that a sale actually happened —
    ///         a second, independent attestation on top of the merchant's original
    ///         report. Callable only by AGENT_ROLE, after the agent has separately
    ///         verified this directly with the buyer (e.g. messaging their own
    ///         WhatsApp number and getting an affirmative reply).
    /// @dev This contract cannot verify a real-world conversation happened — that
    ///      trust still runs through the agent. What it CAN guarantee: the
    ///      confirmation is bound to the exact buyerHash recorded at issuance (an
    ///      agent can't confirm a receipt against an unrelated hash), it can only
    ///      happen once per receipt, and it leaves a second, separately-timestamped
    ///      on-chain event a one-sided fabrication does not have. `confirmedCount`
    ///      is tracked but deliberately NOT folded into `creditScore()` — it's
    ///      surfaced as its own transparent signal so a lender can weigh it
    ///      themselves rather than trust an opaque blend.
    function confirmReceipt(uint64 receiptId, bytes32 buyerHash) external onlyRole(AGENT_ROLE) whenNotPaused nonReentrant {
        if (receiptId == 0 || receiptId > receiptCounter) revert ReceiptDoesNotExist();
        if (receiptConfirmed[receiptId]) revert AlreadyConfirmed();
        if (receiptBuyerHash[receiptId] != buyerHash) revert BuyerHashMismatch();

        receiptConfirmed[receiptId] = true;
        bytes32 merchantHash = receiptMerchantHash[receiptId];
        merchants[merchantHash].confirmedCount += 1;

        emit ReceiptConfirmed(receiptId, merchantHash, buyerHash, uint64(block.timestamp));
    }

    function _computeTier(uint64 count, uint128 volume) internal pure returns (Tier) {
        if (count >= PLATINUM_MIN_RECEIPTS && volume >= PLATINUM_MIN_VOLUME) return Tier.Platinum;
        if (count >= GOLD_MIN_RECEIPTS && volume >= GOLD_MIN_VOLUME) return Tier.Gold;
        if (count >= SILVER_MIN_RECEIPTS && volume >= SILVER_MIN_VOLUME) return Tier.Silver;
        if (count >= BRONZE_MIN_RECEIPTS) return Tier.Bronze;
        return Tier.Unrated;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────

    function getMerchantProfile(bytes32 merchantHash) external view returns (MerchantProfile memory) {
        return merchants[merchantHash];
    }

    /// @notice A single composite score (0–1000) blending volume, frequency and
    ///         consistency — designed to be legible to a microlender as an
    ///         alternative-credit signal for someone with no bank credit history.
    function creditScore(bytes32 merchantHash) external view returns (uint256) {
        MerchantProfile memory m = merchants[merchantHash];
        if (m.receiptCount == 0) return 0;

        uint256 volumeScore = m.totalVolume > 10_000_000 ? 400 : (uint256(m.totalVolume) * 400) / 10_000_000;
        uint256 freqScore = m.receiptCount > 150 ? 300 : (uint256(m.receiptCount) * 300) / 150;
        uint256 streakScore = m.longestStreakDays > 60 ? 300 : (uint256(m.longestStreakDays) * 300) / 60;

        return volumeScore + freqScore + streakScore;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────

    function setMaxReceiptAmount(uint128 newMax) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMax == 0) revert InvalidInput();
        emit MaxReceiptAmountUpdated(maxReceiptAmount, newMax);
        maxReceiptAmount = newMax;
    }

    function setMinReceiptInterval(uint32 newInterval) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MinReceiptIntervalUpdated(minReceiptInterval, newInterval);
        minReceiptInterval = newInterval;
    }

    /// @notice Emergency stop. Halts both `issueReceipt` and `issueReceiptWithSig`
    ///         instantly — e.g. if an agent key is suspected compromised — without
    ///         touching already-recorded history, which remains fully readable.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
