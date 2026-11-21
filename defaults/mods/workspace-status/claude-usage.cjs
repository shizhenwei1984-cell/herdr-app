const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readSnapshot, writeSnapshot, readHookInput, summarizeLog } = require("./usage-hook.cjs");

const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const isCount = n => Number.isSafeInteger(n) && n >= 0;
const windowNames = [["five_hour", "5h"], ["seven_day", "7d"], ["seven_day_opus", "Opus 7d"], ["spend_limit", "Spend"]];

async function readJson(file) {
  try { return JSON.parse(await fs.promises.readFile(file, "utf8")); } catch { return null; }
}

function windows(limits, observedAt, source) {
  const result = [];
  for (const [key, label] of windowNames) {
    const entry = limits?.[key];
    const used = source === "hook" ? entry?.used_percentage : entry?.utilization;
    if (!Number.isFinite(used) || used < 0 || used > 100) continue;
    const resetAt = source === "hook" ? (Number.isFinite(entry.resets_at) ? entry.resets_at * 1000 : NaN) : Date.parse(entry.resets_at);
    result.push({ label, remaining: 100 - used, observedAt, ...(Number.isFinite(resetAt) && { resetAt }) });
  }
  return result;
}

async function defaultQuota(home) {
  const profile = await readJson(path.join(home, ".claude.json"));
  const cached = profile?.cachedUsageUtilization;
  if (!profile?.oauthAccount?.accountUuid || cached?.accountUuid !== profile.oauthAccount.accountUuid ||
      !Number.isFinite(cached.fetchedAtMs) || cached.fetchedAtMs <= 0) return [];
  return windows(cached.utilization, cached.fetchedAtMs, "cache");
}

// Called inside Claude's terminal. Only allowlisted status-line fields leave stdin.
async function publish(data, terminal, appHome) {
  if (!terminal || !UUID.test(data?.session_id)) return;
  const transcript = data.transcript_path;
  const id = data.session_id;
  const snapshot = { id, windows: windows(data.rate_limits, Date.now(), "hook") };
  if (typeof transcript === "string" && path.isAbsolute(transcript) && path.basename(transcript) === id + ".jsonl") {
    snapshot.transcript = transcript;
  }
  if (typeof data.model?.display_name === "string") snapshot.model = data.model.display_name;
  const cost = data.cost?.total_cost_usd;
  if (Number.isFinite(cost) && cost >= 0) snapshot.providerCostUsd = cost;
  const context = data.context_window;
  const size = context?.context_window_size;
  const latest = context?.current_usage;
  const input = [latest?.input_tokens, latest?.cache_creation_input_tokens, latest?.cache_read_input_tokens];
  if (isCount(size) && size > 0 && input.every(isCount)) {
    snapshot.contextWindow = size;
    snapshot.contextInputTokens = input.reduce((total, n) => total + n, 0);
  } else if (Number.isFinite(context?.used_percentage) && context.used_percentage >= 0) {
    snapshot.contextPercent = context.used_percentage;
  }
  await writeSnapshot("claude", terminal, snapshot, appHome);
}

function reducer(id) {
  return {
    initial: () => ({ summary: { id, turns: 0 }, messages: {}, prompts: {}, responses: {}, tools: {}, matched: false }),
    fold(state, row) {
      if (row?.sessionId !== id || row.isSidechain) return;
      const { summary, messages, prompts, responses, tools } = state;
      state.matched = true;
      const msg = row.message;
      if (row.type === "user" && !row.isMeta && !row.toolUseResult && !prompts["#" + row.uuid]) {
        const content = msg?.content;
        if (typeof content === "string" || (Array.isArray(content) && content.some(b => b?.type === "text"))) {
          summary.turns++;
          if (row.uuid) prompts["#" + row.uuid] = true;
        }
      }
      if (row.type !== "assistant" || !msg || msg.model === "<synthetic>") return;
      if (typeof msg.model === "string" && msg.model) summary.model = msg.model;
      const key = msg.id ? JSON.stringify([msg.id, row.requestId]) : row.uuid;
      if (typeof msg.id === "string" && msg.id) responses["#" + key] = true;
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item?.type === "tool_use" && typeof item.id === "string" && item.id) tools["#" + item.id] = true;
        }
      }
      if (!msg.usage || !key) return;
      const counts = {};
      for (const [field, key] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"],
        ["cache_creation_input_tokens", "cacheWriteTokens"], ["cache_read_input_tokens", "cacheReadTokens"]]) {
        const n = msg.usage[field];
        if (isCount(n)) counts[key] = n;
      }
      if (Object.keys(counts).length) messages["#" + key] = { ...messages["#" + key], ...counts, model: msg.model };
    },
    result({ matched, summary, messages, responses, tools }) {
      if (!matched) return null;
      const modelCalls = Object.keys(responses).length;
      const toolCalls = Object.keys(tools).length;
      const session = { ...summary, ...(modelCalls && { modelCalls }), ...((modelCalls || toolCalls) && { toolCalls }) };
      const usage = Object.values(messages);
      if (usage.length) {
        for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
          if (usage.every(message => isCount(message[field]))) {
            session[field] = usage.reduce((total, message) => total + message[field], 0);
          }
        }
        // Keep the combined cache count visible for older logs with one cache field.
        const cache = usage.flatMap(message => [message.cacheReadTokens, message.cacheWriteTokens]).filter(isCount);
        if (cache.length) session.cacheTokens = cache.reduce((total, n) => total + n, 0);
        if (isCount(session.inputTokens) && isCount(session.outputTokens)) {
          session.tokens = session.inputTokens + session.outputTokens + (session.cacheTokens ?? 0);
        }
        const model = usage[0].model;
        if (typeof model === "string" && model && usage.every(message => message.model === model) &&
            Object.keys(messages).length >= modelCalls) session.pricingModel = model;
      }
      return session;
    },
  };
}

async function sample({ terminal, sessionId, home = os.homedir(), appHome,
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude") } = {}) {
  const snapshot = terminal ? await readSnapshot("claude", terminal, appHome) : null;
  const bound = snapshot && (!sessionId || snapshot.id === sessionId) ? snapshot : null;
  const id = sessionId || bound?.id;
  if (typeof id !== "string" || !UUID.test(id)) return { session: null };
  const readSession = filename => summarizeLog("claude", filename, JSON.stringify([terminal, id]), appHome, reducer(id))
    .catch(() => null);
  let current;
  if (bound?.transcript) {
    current = await readSession(bound.transcript);
  } else {
    const projects = path.join(configDir, "projects");
    for (const dir of await fs.promises.readdir(projects, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory()) continue;
      current = await readSession(path.join(projects, dir.name, id + ".jsonl"));
      if (current) break;
    }
  }
  const hook = {};
  if (bound) {
    for (const field of ["id", "model", "contextWindow", "contextInputTokens", "contextPercent", "providerCostUsd"]) {
      if (bound[field] !== undefined) hook[field] = bound[field];
    }
  }
  if (current) return { ...current, session: { ...hook, ...current.session } };
  return { session: bound ? hook : null };
}

async function quota({ terminal, sessionId, home = os.homedir(), appHome,
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude") } = {}) {
  const snapshot = terminal ? await readSnapshot("claude", terminal, appHome) : null;
  if (snapshot && (!sessionId || snapshot.id === sessionId)) return { windows: snapshot.windows || [] };
  const isDefault = path.resolve(configDir) === path.resolve(home, ".claude");
  return { windows: isDefault ? await defaultQuota(home) : [] };
}

async function collect(options) {
  const [{ windows }, { session }] = await Promise.all([quota(options), sample(options)]);
  return { windows, session };
}

if (require.main === module && process.argv[2] === "status-line") {
  (async () => {
    const passthrough = process.argv.includes("--passthrough");
    const data = await readHookInput(passthrough);
    if (process.env.HC_TERMINAL_ID) await publish(data, process.env.HC_TERMINAL_ID, path.resolve(__dirname, "../.."));
  })().catch(() => {}); // A status-line integration must let the user's own command run.
}

module.exports = { collect, quota, sample };
