// Net profit = on-chain revenue (from cached receipts, which mirror the real
// on-chain amounts) minus off-chain expenses (self-reported, unverified). This is
// deliberately a bookkeeping convenience for the merchant, not a credit signal —
// nothing here feeds back into the contract's credit score.
//
// Broken out per currency rather than blended into one number: summing NGN and USD
// amounts together would be meaningless, the same trap the contract's on-chain
// totalVolume falls into by design (it has no currency dimension at all). A merchant
// who only ever uses one currency just sees a single-entry breakdown, which reads
// exactly like a plain total.

const DAY = 24 * 60 * 60;

function periodStart(key) {
  const now = Math.floor(Date.now() / 1000);
  switch (key) {
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    }
    case "week":
      return now - 7 * DAY;
    case "all":
      return 0;
    case "month":
    default:
      return now - 30 * DAY;
  }
}

/// Pulls a period keyword out of free text like "/profit week" or "check profit for
/// this month" — defaults to "month" when none is found, since that's the most
/// useful single number for a merchant checking in occasionally.
function resolvePeriod(text) {
  const match = (text || "").toLowerCase().match(/\b(today|week|month|all)\b/);
  const key = match ? match[1] : "month";
  return { key, sinceTimestamp: periodStart(key) };
}

function computeProfit(store, merchantHash, periodText) {
  const { key, sinceTimestamp } = resolvePeriod(periodText);
  const receipts = store.receiptsForMerchant(merchantHash, sinceTimestamp);
  const expenses = store.expensesForMerchant(merchantHash, sinceTimestamp);

  const byCurrency = {};
  const bucket = (code) =>
    (byCurrency[code] ||= { currencyCode: code, revenueMinor: 0, expensesMinor: 0, receiptCount: 0, expenseCount: 0 });

  for (const r of receipts) {
    const b = bucket(r.currencyCode || "NGN");
    b.revenueMinor += r.amountMinor || 0;
    b.receiptCount += 1;
  }
  for (const e of expenses) {
    const b = bucket(e.currencyCode || "NGN");
    b.expensesMinor += e.amountMinor || 0;
    b.expenseCount += 1;
  }

  const currencies = Object.values(byCurrency).map((b) => ({ ...b, netProfitMinor: b.revenueMinor - b.expensesMinor }));

  return {
    period: key,
    sinceTimestamp,
    currencies, // one entry per currency actually used in this period, empty array if none
    receiptCount: receipts.length,
    expenseCount: expenses.length,
  };
}

const PERIOD_LABELS = { today: "Today", week: "This week", month: "This month", all: "All time" };

module.exports = { computeProfit, resolvePeriod, PERIOD_LABELS };
