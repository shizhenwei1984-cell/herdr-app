const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const { createInterface } = require("node:readline");
const path = require("node:path");
const os = require("node:os");
const { summarizeLog } = require("./usage-hook.cjs");

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function quotaWindows(result) {
  const groups = Object.entries(result?.rateLimitsByLimitId ?? {});
  if (!groups.length && result?.rateLimits) groups.push(["codex", result.rateLimits]);
  const windows = [];
  for (const [id, group] of groups) {
    for (const key of ["primary", "secondary"]) {
      const window = group?.[key];
      if (!Number.isFinite(window?.usedPercent)) continue;
      const mins = window.windowDurationMins;
      let period = key;
      if (Number.isFinite(mins) && mins > 0) {
        if (mins % 1440 === 0) period = `${mins / 1440}d`;
        else if (mins % 60 === 0) period = `${mins / 60}h`;
        else period = `${mins}m`;
      }
      windows.push({
        label: id === "codex" ? period : `${group.limitName || id} ${period}`,
        remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)),
        ...(Number.isFinite(window.resetsAt) && { resetAt: window.resetsAt * 1000 }),
      });
    }
  }
  return windows;
}

const tokenFields = {
  total_tokens: "tokens", input_tokens: "inputTokens",
  output_tokens: "outputTokens", cached_input_tokens: "cacheTokens",
  cache_write_input_tokens: "cacheWriteTokens",
};
const rolloutName = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([a-f0-9-]{36})(?:_[a-f0-9-]{36})?\.jsonl$/i;
const toolItems = new Set(["function_call", "custom_tool_call", "tool_search_call", "local_shell_call"]);
const count = value => Number.isSafeInteger(value) && value >= 0;
const hasId = value => typeof value === "string" && value.length > 0;

function recordContext(session, latest, contextWindow) {
  if (count(contextWindow) && contextWindow > 0) session.contextWindow = contextWindow;
  // Codex can fill a context-only estimate into last_token_usage.
  if (latest?.input_tokens === 0 && latest.output_tokens === 0 && latest.total_tokens > 0) return;
  if (count(latest?.input_tokens)) session.contextInputTokens = latest.input_tokens;
}

function observeUsage(state, total) {
  if (!total) return;
  const changed = Object.entries(tokenFields).some(([field, key]) => count(total[field]) && state.session[key] !== total[field]);
  for (const [field, key] of Object.entries(tokenFields)) {
    if (count(total[field])) state.session[key] = total[field];
    else delete state.session[key];
  }
  if (!changed || (total.input_tokens === 0 && total.output_tokens === 0)) return;
  const model = state.session.model;
  if (!model || (state.pricingModel && state.pricingModel !== model)) state.ambiguousModel = true;
  else state.pricingModel = model;
  if (Object.keys(tokenFields).some(field => field !== "cache_write_input_tokens" && !count(total[field]))) {
    state.incompleteUsage = true;
  }
}

function reducer(id) {
  return {
    initial: () => ({ matched: false, session: { id }, turns: {}, responses: {}, tools: {} }),
    fold(state, row) {
      const p = row?.payload;
      if (!p) return;
      if (row.type === "session_meta") {
        state.matched = p.id === id;
        return;
      }
      if (!state.matched) return;
      const { session, turns, responses, tools } = state;
      if (row.type === "token_usage_record" && (!p.thread_id || p.thread_id === id)) {
        if (hasId(p.response_id)) responses["#" + p.response_id] = true;
        if (hasId(p.turn_id)) turns["#" + p.turn_id] = true;
        const total = p.thread_token_usage;
        if (total) {
          // An older session can gain token_usage_record after a CLI upgrade.
          // Keep the legacy totals if the new counter started partway through.
          state.useRecords ??= !count(session.tokens) || total.total_tokens >= session.tokens;
          if (state.useRecords) observeUsage(state, total);
        }
        recordContext(session, p.usage);
      } else if (row.type === "turn_context") {
        if (hasId(p.turn_id)) turns["#" + p.turn_id] = true;
        if (hasId(p.model)) session.model = p.model;
      } else if (row.type === "response_item" && toolItems.has(p.type) && hasId(p.call_id)) {
        tools["#" + p.call_id] = true;
      } else if (row.type === "event_msg") {
        if (p.type === "token_count" && p.info) {
          const total = p.info.total_token_usage;
          const consistent = !count(total?.input_tokens) || !count(total?.output_tokens) ||
            total.total_tokens === total.input_tokens + total.output_tokens;
          if (!state.useRecords && consistent) observeUsage(state, total);
          recordContext(session, p.info.last_token_usage, p.info.model_context_window);
        } else if (p.type === "raw_response_completed" && hasId(p.response_id)) {
          responses["#" + p.response_id] = true;
        } else if (p.type === "mcp_tool_call_end" && hasId(p.call_id)) {
          tools["#" + p.call_id] = true;
        } else if (p.type === "thread_settings_applied" && (!p.thread_id || p.thread_id === id)) {
          if (hasId(p.thread_settings?.model)) session.model = p.thread_settings.model;
        } else if (["task_started", "turn_started", "task_complete", "turn_complete"].includes(p.type)) {
          if (hasId(p.turn_id)) turns["#" + p.turn_id] = true;
          if (p.type.endsWith("_complete")) {
            if (count(p.time_to_first_token_ms)) session.ttftMs = p.time_to_first_token_ms;
            else delete session.ttftMs;
          } else {
            recordContext(session, null, p.model_context_window);
          }
        }
      }
    },
    result({ matched, session, turns, responses, tools, pricingModel, ambiguousModel, incompleteUsage }) {
      if (!matched) return null;
      const modelCalls = Object.keys(responses).length;
      return {
        ...session, turns: Object.keys(turns).length, toolCalls: Object.keys(tools).length,
        ...(modelCalls && { modelCalls }),
        ...(!ambiguousModel && !incompleteUsage && pricingModel && { pricingModel }),
      };
    },
  };
}

async function findRollout(dir, id) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  // Search recent dated directories first. Match the UUID, never the working directory.
  entries.sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) {
      const found = await findRollout(file, id);
      if (found) return found;
    } else if (entry.isFile() && rolloutName.exec(entry.name)?.[1].toLowerCase() === id) {
      return file;
    }
  }
  return null;
}

async function sample({ terminal, sessionId, appHome,
  home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex") } = {}) {
  if (!terminal || typeof sessionId !== "string" || !uuid.test(sessionId)) return { session: null };
  const id = sessionId.toLowerCase();
  const locate = async cached => {
    if (cached && (await fs.stat(cached).catch(() => null))?.isFile()) {
      // A rollback can create a replacement rollout with the same thread ID.
      return await findRollout(path.dirname(cached), id) || cached;
    }
    return await findRollout(path.join(home, "sessions"), id) ||
      await findRollout(path.join(home, "archived_sessions"), id);
  };
  return await summarizeLog("codex", locate, JSON.stringify([terminal, id]), appHome, reducer(id))
    .catch(() => null) || { session: null };
}

async function requestQuota(id) {
  const child = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  let thread;
  let limits;
  let receivedQuota = false;
  let receivedThread = !id;
  let initialized = false;

  // The provider owns this child. Never attach to, stop or mutate a running Codex session.
  await new Promise(resolve => {
    const timer = setTimeout(finish, 8000);
    function finish() {
      clearTimeout(timer);
      resolve();
    }
    function send(message) {
      child.stdin.write(JSON.stringify(message) + "\n");
    }
    child.once("error", finish);
    child.once("close", finish);
    child.stdin.on("error", finish);
    lines.on("line", line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg?.id === 1 && !initialized) {
        if (msg.error) return finish();
        initialized = true;
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        if (id) send({ id: 3, method: "thread/read", params: { threadId: id, includeTurns: false } });
      } else if (msg?.id === 2) {
        limits = msg.result;
        receivedQuota = true;
      } else if (msg?.id === 3) {
        thread = msg.result?.thread;
        receivedThread = true;
      }
      if (receivedQuota && receivedThread) finish();
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "herdr_workspace_status", title: "Herdr", version: "1" }, capabilities: null,
    } });
  });
  lines.close();
  child.stdin.destroy();
  child.kill();
  return { windows: quotaWindows(limits), thread };
}

async function quota() {
  const { windows } = await requestQuota(null);
  return { windows };
}

// Preserve the combined collector entry point for existing helper callers.
async function collect(options = {}) {
  const id = typeof options.sessionId === "string" && uuid.test(options.sessionId) ? options.sessionId : null;
  const [{ windows, thread }, local] = await Promise.all([requestQuota(id), sample(options)]);
  let session = local.session;
  if (!session && id && thread?.id === id) {
    const fallback = thread.path && await summarizeLog("codex", thread.path,
      JSON.stringify([options.terminal, id]), options.appHome, reducer(id)).catch(() => null);
    session = fallback?.session || { id };
    if (!session.model && typeof thread.model === "string") session.model = thread.model;
  }
  return { windows, session };
}

module.exports = { collect, quota, sample, quotaWindows };
