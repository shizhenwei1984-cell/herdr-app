const fs = require("node:fs/promises");
const path = require("node:path");

// Standard API, short context, 30-minute cache writes. These are USD per
// million tokens, not a subscription charge or a provider billing statement.
const defaults = {
  "gpt-6.2-astra": { input: 8, cached_input: 0.40, output: 40, cache_write: 10 },
  "gpt-6.2-sol": { input: 2, cached_input: 0.10, output: 10, cache_write: 2.5 },
};
const count = n => Number.isSafeInteger(n) && n >= 0;
const price = n => Number.isFinite(n) && n >= 0;

async function rates(appHome, provider, model) {
  const file = path.join(appHome, "usage", "pricing.json");
  let configured;
  try {
    const stat = await fs.stat(file);
    if (stat.isFile() && stat.size <= 1024 * 1024) configured = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {}
  if (configured && Object.hasOwn(configured, model)) {
    return { row: configured[model], source: "configured" };
  }
  if (provider === "codex" && Object.hasOwn(defaults, model)) {
    return { row: defaults[model], source: "standard" };
  }
  return {};
}

async function priceSession(provider, session, appHome) {
  if (!session) return;
  let input = session.inputTokens;
  let cached = session.cacheTokens;
  let written = session.cacheWriteTokens ?? 0;
  // Codex input already includes reads and writes. Claude and Agy input
  // exclude the separate cache counters.
  if (provider === "codex") {
    input -= cached + written;
  } else if (provider === "claude") {
    cached = session.cacheReadTokens;
    written = session.cacheWriteTokens;
  }

  const allInput = provider === "codex" ? session.inputTokens
    : [input, cached, written].every(count) ? input + cached + written : undefined;
  if (count(cached) && count(allInput) && allInput > 0 && cached <= allInput) {
    session.cacheHitRate = 100 * cached / allInput;
  }

  if (price(session.providerCostUsd)) {
    session.costUsd = session.providerCostUsd;
    session.costSource = "provider";
    return;
  }
  if (!session.pricingModel || ![input, cached, written, session.outputTokens].every(count) ||
      allInput + session.outputTokens === 0) return;
  const { row, source } = await rates(appHome, provider, session.pricingModel);
  if (![row?.input, row?.cached_input, row?.output].every(price) || (written > 0 && !price(row.cache_write))) return;
  const dollars = (input * row.input + cached * row.cached_input + written * (row.cache_write ?? 0) +
    session.outputTokens * row.output) / 1_000_000;
  if (!price(dollars)) return;
  session.costUsd = dollars;
  session.costSource = source;
}

module.exports = { priceSession };
