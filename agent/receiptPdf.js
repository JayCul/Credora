const PDFDocument = require("pdfkit");

// Same palette as public/dashboard.html — the PDF is meant to look like it came
// from the same product, not a bolted-on afterthought.
const COLORS = {
  brand: "#0e9f6e",
  brandDark: "#0a7a54",
  brandTint: "#ecfdf3",
  text: "#101828",
  muted: "#667085",
  mutedLight: "#98a2b3",
  border: "#eaecf0",
  card: "#f9fafb",
};

const TIER_FG = { Unrated: "#667085", Bronze: "#b54708", Silver: "#475467", Gold: "#92650a", Platinum: "#0e9384" };
const TIER_BG = { Unrated: "#f2f4f7", Bronze: "#fdf1e7", Silver: "#eef2f6", Gold: "#fef9e7", Platinum: "#e6fbf7" };

/// Builds a single-page receipt PDF in memory and resolves with a Buffer. Used by
/// both the WhatsApp agent (sent back in-chat immediately after a sale is recorded)
/// and the dashboard (downloaded on demand) — one rendering path, so a receipt looks
/// identical no matter where it came from.
function generateReceiptPdf({
  receiptId,
  businessName,
  merchantHash,
  item,
  buyerName,
  amountMinor,
  currencyCode,
  txHash,
  explorerTxUrl,
  networkLabel,
  timestamp,
  tier,
  creditScore,
  standingLabel,
  buyerConfirmed,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 0 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width;
    const PAD = 36;
    const amount = (amountMinor / 100).toLocaleString();
    const date = new Date((timestamp || Math.floor(Date.now() / 1000)) * 1000);

    // ── Header band ──────────────────────────────────────────────────────
    doc.rect(0, 0, W, 96).fill(COLORS.brand);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(22).text("Credora", PAD, 26);
    doc.font("Helvetica").fontSize(11).fillColor("#e7fbf1").text("Sales Receipt", PAD, 52);
    doc.fontSize(9).fillColor("#c8f3e0").text(`#${receiptId}  ·  ${date.toLocaleString()}`, PAD, 70);

    let y = 122;

    // ── Business name + tier badge ──────────────────────────────────────
    doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(16).text(businessName || "Unregistered merchant", PAD, y);
    y += 26;

    if (tier) {
      const label = tier.toUpperCase();
      doc.font("Helvetica-Bold").fontSize(9);
      const badgeW = doc.widthOfString(label) + 20;
      doc.roundedRect(PAD, y, badgeW, 18, 9).fill(TIER_BG[tier] || TIER_BG.Unrated);
      doc.fillColor(TIER_FG[tier] || TIER_FG.Unrated).text(label, PAD + 10, y + 5);

      if (buyerConfirmed) {
        const confirmLabel = "BUYER CONFIRMED";
        const confirmX = PAD + badgeW + 8;
        const confirmW = doc.widthOfString(confirmLabel) + 20;
        doc.roundedRect(confirmX, y, confirmW, 18, 9).fill(COLORS.brandTint);
        doc.fillColor(COLORS.brandDark).text(confirmLabel, confirmX + 10, y + 5);
      }
      y += 30;
    }

    // ── Amount card ──────────────────────────────────────────────────────
    doc.roundedRect(PAD, y, W - PAD * 2, 64, 12).fill(COLORS.brandTint);
    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9).text("AMOUNT", PAD + 18, y + 14);
    doc.fillColor(COLORS.brandDark).font("Helvetica-Bold").fontSize(24).text(`${currencyCode} ${amount}`, PAD + 18, y + 28);
    y += 84;

    // ── Item / buyer ─────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(COLORS.text).text("Item", PAD, y);
    doc.font("Helvetica").fillColor(COLORS.muted).text(item, PAD + 60, y, { width: W - PAD * 2 - 60 });
    y = Math.max(y + 16, doc.y + 4);

    if (buyerName) {
      doc.font("Helvetica-Bold").fillColor(COLORS.text).text("Buyer", PAD, y);
      doc.font("Helvetica").fillColor(COLORS.muted).text(buyerName, PAD + 60, y, { width: W - PAD * 2 - 60 });
      y = Math.max(y + 16, doc.y + 4);
    }

    y += 12;
    doc.moveTo(PAD, y).lineTo(W - PAD, y).strokeColor(COLORS.border).stroke();
    y += 18;

    // ── Verification details ─────────────────────────────────────────────
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted);
    if (tier) {
      doc.text(`${standingLabel || "Merchant standing"}: ${tier} tier, score ${creditScore}/1000`, PAD, y);
      y += 14;
    }
    doc.fillColor(COLORS.mutedLight);
    doc.text(`Credora ID`, PAD, y);
    doc.text(merchantHash, PAD, y + 11, { width: W - PAD * 2 });
    y += 30;
    doc.text(`Transaction`, PAD, y);
    doc.text(txHash, PAD, y + 11, { width: W - PAD * 2 });
    y += 30;
    doc.text(`Network: ${networkLabel}`, PAD, y);
    y += 26;

    // ── Footer ────────────────────────────────────────────────────────────
    doc
      .fontSize(8)
      .fillColor(COLORS.mutedLight)
      .text(
        "This receipt reflects an immutable on-chain record and cannot be altered after issuance. The business name above is self-reported at onboarding and is not independently verified. Verify the transaction directly at:",
        PAD,
        y,
        { width: W - PAD * 2 }
      );
    y = doc.y + 3;
    doc.fillColor(COLORS.brand).fontSize(8.5).text(explorerTxUrl, PAD, y, { link: explorerTxUrl, underline: true });

    doc.end();
  });
}

module.exports = { generateReceiptPdf };
