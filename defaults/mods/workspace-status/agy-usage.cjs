const path = require("node:path");
const os = require("node:os");
const { readSnapshot, writeSnapshot, readHookInput, summarizeLog } = require("./usage-hook.cjs");

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

async function publish(data, terminal, appHome) {
  if (!terminal || typeof data?.session_id !== "string" || !UUID.test(data.session_id)) return;
  const session = { id: data.session_id };
  if (typeof data.model?.display_name === "string") session.model = data.model.display_name.slice(0, 120);
  const cost = data.cost?.total_usd;
  if (Number.isFinite(cost) && cost >= 0) session.providerCostUsd = cost;
  const context = data.context_window;
  if (Number.isFinite(context?.used_percentage) && context.used_percentage >= 0) session.contextPercent = context.used_percentage;
  const observedAt = Date.now();
  const windows = [];
  for (const [label, quota] of Object.entries(data.quota || {})) {
    const fraction = quota?.remaining_fraction;
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
    const resetAt = Date.parse(quota.reset_time);
    windows.push({ label, remaining: fraction * 100, observedAt, ...(Number.isFinite(resetAt) && { resetAt }) });
  }
  await writeSnapshot("agy", terminal, { session, windows }, appHome);
  await writeSnapshot("agy", null, { windows }, appHome);
}

const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const reducer = {
  initial: () => ({}),
  fold(steps, row) {
    if (!Number.isSafeInteger(row?.step_index)) return;
    if (row.type === "USER_INPUT") steps[row.step_index] = { turn: true };
    if (row.type === "PLANNER_RESPONSE" || row.type === "CHECKPOINT") {
      steps[row.step_index] = {
        input: tokenCount(row.input_tokens), output: tokenCount(row.output_tokens),
        cache: tokenCount(row.cache_read_tokens ?? 0),
        write: tokenCount(row.cache_creation_input_tokens ?? row.cache_write_tokens ?? 0),
        model: typeof row.model_name === "string" ? row.model_name : undefined,
      };
    }
  },
  result(steps) {
    const values = Object.values(steps);
    if (!values.length) return null;
    const usage = values.filter(step => !step.turn);
    const session = { turns: values.length - usage.length };
    if (!usage.length) return session;
    for (const [field, key] of [["input", "inputTokens"], ["output", "outputTokens"],
      ["cache", "cacheTokens"], ["write", "cacheWriteTokens"]]) {
      if (usage.every(step => step[field] !== undefined)) {
        session[key] = usage.reduce((total, step) => total + step[field], 0);
      }
    }
    const totals = [session.inputTokens, session.outputTokens, session.cacheTokens, session.cacheWriteTokens];
    if (totals.every(Number.isSafeInteger)) session.tokens = totals.reduce((total, n) => total + n, 0);
    const model = usage[0].model;
    if (model && usage.every(step => step.model === model)) session.pricingModel = model;
    return session;
  },
};

async function quota({ terminal, sessionId, appHome } = {}) {
  const bound = terminal && await readSnapshot("agy", terminal, appHome);
  const data = bound?.session && (!sessionId || bound.session.id === sessionId)
    ? bound : await readSnapshot("agy", null, appHome);
  return { windows: data?.windows || [] };
}

async function sample({ terminal, sessionId, home = os.homedir(), appHome } = {}) {
  if (!terminal) return { session: null };
  const data = await readSnapshot("agy", terminal, appHome);
  const binding = data?.session;
  const id = sessionId || binding?.id;
  if (typeof id !== "string" || !UUID.test(id)) return { session: null };
  const bound = binding?.id === id ? binding : null;
  for (const dir of ["antigravity-cli", "antigravity"]) {
    const file = path.join(home, ".gemini", dir, "brain", id, ".system_generated", "logs", "transcript.jsonl");
    const stats = await summarizeLog("agy", file, JSON.stringify([terminal, id]), appHome, reducer).catch(() => null);
    if (stats) return { ...stats, session: { id, ...bound, ...stats.session } };
  }
  return { session: bound };
}

async function collect(options) {
  const [{ windows }, { session }] = await Promise.all([quota(options), sample(options)]);
  return { windows, session };
}

module.exports = { collect, publish, quota, sample };
if (require.main === module) {
  readHookInput(process.argv.includes("--passthrough")).then(data => publish(data, process.env.HC_TERMINAL_ID, path.resolve(__dirname, "../.."))).catch(() => {});
}
