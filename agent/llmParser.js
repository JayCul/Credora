// Provider-agnostic transaction-message parser. Picks whichever API key is present
// in .env: GROQ_API_KEY (free, no card, recommended) or ANTHROPIC_API_KEY (paid).
// Both are used purely for structured extraction via forced tool/function calling,
// never given free-form output or any ability to act beyond filling this schema.
const PROVIDER = process.env.GROQ_API_KEY ? "groq" : process.env.ANTHROPIC_API_KEY ? "anthropic" : null;

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const SYSTEM_PROMPT =
  "You classify and extract structured transaction data from short, informal WhatsApp messages sent by small market vendors, who may be anywhere, not only Nigeria. Messages mix English and local languages/pidgin, use casual number formats ('15k' -> 15000, '2M' or '2m' -> 2000000, '2,500naira', 'twenty thousand'), and are often terse. A message is a 'sale' if money came in (something was sold), an 'expense' if money went out (stock, supplies, transport, rent, fuel, etc. was paid for), or 'none' if it's not a transaction at all (a greeting, question, or unrelated chat). Be conservative: if it's ambiguous whether this is a transaction at all, prefer 'none' over guessing. Never invent an amount that isn't stated or clearly implied by the text. " +
  "Identify the currency ONLY from an explicit hint in the text itself: a currency word (naira, dollars, cedis, shillings, pounds, euros, rand, francs), a symbol ($, £, €, ₦), or an explicit code. Map whatever hint is present to the correct ISO code (naira/₦ -> NGN, dollars/$ -> USD, cedis -> GHS, kenyan shillings -> KES, pounds/£ -> GBP, euros/€ -> EUR, rand -> ZAR, etc). " +
  "IMPORTANT: if the message states a bare number with no currency word, symbol, or code anywhere in it, you MUST set currency_code to the JSON value null. Do not assume Nigeria, do not assume naira, do not assume any default currency, even if earlier examples in this prompt used naira. A bare number like '20000' or '15k' with nothing else has NO currency information in it and currency_code must be null in that case. Only ever fill in a currency when the text itself names or symbolizes one.";

// JSON Schema shared by both providers — Anthropic's Messages API and Groq's
// OpenAI-compatible chat completions API both accept this shape (Anthropic wraps it
// in `input_schema`, Groq/OpenAI wraps it in `parameters`).
const TRANSACTION_SCHEMA = {
  type: "object",
  properties: {
    transaction_type: {
      type: "string",
      enum: ["sale", "expense", "none"],
      description: "'sale' if money came in, 'expense' if money went out, 'none' if this message isn't a transaction at all.",
    },
    description: {
      type: ["string", "null"],
      description: "Short description of what was sold (sale) or what was paid for (expense). Null if transaction_type is 'none'.",
    },
    counterparty_name: {
      type: ["string", "null"],
      description: "Buyer's name for a sale, or vendor/payee name for an expense, if mentioned. Else null.",
    },
    amount: {
      type: "number",
      description:
        "The plain stated amount, with shorthand resolved to a real number and nothing else done to it. '15k' -> 15000, '270k' -> 270000, '2M' -> 2000000, 'fifty' -> 50, '50' -> 50. Do NOT multiply by 100 or apply any other unit conversion, that happens separately in code. Must be a positive number, 0 if no amount is stated at all.",
    },
    currency_code: {
      type: ["string", "null"],
      description: "3-letter ISO currency code identified from the text. Null if there is no hint at all of which currency is meant, never guess.",
    },
    confidence: { type: "number", description: "0-1 confidence that the extraction is complete and unambiguous." },
    flags: {
      type: "array",
      items: { type: "string" },
      description:
        "Anomaly flags worth a second look before recording, e.g. 'amount_unusually_high_vs_history', 'round_number_suspicious', 'vague_description', 'possible_duplicate_of_recent_message'. Empty array if nothing stands out.",
    },
    clarification_needed: {
      type: ["string", "null"],
      description:
        "If the message is too ambiguous to record safely (e.g. no amount, no description), a short WhatsApp-ready follow-up question. Null otherwise.",
    },
  },
  required: ["transaction_type", "amount", "currency_code", "confidence", "flags"],
};

function historyContext(recentAverageMinor) {
  // recentAverageMinor comes from on-chain data (minor units, e.g. kobo). Convert to
  // a plain stated-amount figure here so it matches what `amount` actually means now.
  return recentAverageMinor
    ? `This merchant's recent average recorded sale is about ${Math.round(recentAverageMinor / 100)} — flag amounts wildly above that as 'amount_unusually_high_vs_history'.`
    : "This merchant has no sale history yet, so judge amount plausibility on general market-stall pricing norms.";
}

async function parseWithGroq(text, recentAverageMinor) {
  const Groq = require("groq-sdk");
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const response = await client.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: `${SYSTEM_PROMPT} ${historyContext(recentAverageMinor)}` },
      { role: "user", content: text },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "record_transaction",
          description: "Extract a structured sale or expense record from a merchant's free-text WhatsApp message.",
          parameters: TRANSACTION_SCHEMA,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "record_transaction" } },
  });

  const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Groq did not return a structured record_transaction call.");
  return JSON.parse(toolCall.function.arguments);
}

async function parseWithAnthropic(text, recentAverageMinor) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 512,
    system: `${SYSTEM_PROMPT} ${historyContext(recentAverageMinor)}`,
    tools: [
      { name: "record_transaction", description: "Extract a structured sale or expense record.", input_schema: TRANSACTION_SCHEMA },
    ],
    tool_choice: { type: "tool", name: "record_transaction" },
    messages: [{ role: "user", content: text }],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a structured record_transaction call.");
  return toolUse.input;
}

/// Parses one WhatsApp message into a structured sale-or-expense record.
/// `recentAverageMinor` — this merchant's historical average sale, read from-chain by
/// the caller — is passed back into the prompt so the model can flag amounts that are
/// wildly out of character for THIS merchant, not just large in the abstract.
async function parseTransactionMessage(text, { recentAverageMinor = null } = {}) {
  if (!PROVIDER) {
    throw new Error("Set GROQ_API_KEY (free) or ANTHROPIC_API_KEY in .env — neither is present.");
  }
  return PROVIDER === "groq" ? parseWithGroq(text, recentAverageMinor) : parseWithAnthropic(text, recentAverageMinor);
}

module.exports = { parseTransactionMessage, PROVIDER };
