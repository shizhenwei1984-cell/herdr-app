const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { readSnapshot, writeSnapshot, readHookInput, summarizeLog } = require("./usage-hook.cjs");

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

async function publish(data, terminal, appHome) {
  const id = data?.conversation_id;
  if (!terminal || typeof id !== "string" || !UUID.test(id)) return;
  const session = { id };
  if (typeof data.model === "string") session.model = data.model.slice(0, 120);
  await writeSnapshot("cursor", terminal, session, appHome);
}

function windowsFrom(summary, observedAt) {
  const plan = summary?.individualUsage?.plan;
  const windows = [];
  const resetAt = Date.parse(summary?.billingCycleEnd);
  for (const [label, field] of [["Plan", "totalPercentUsed"], ["Auto", "autoPercentUsed"], ["API", "apiPercentUsed"]]) {
    const used = plan?.[field];
    if (Number.isFinite(used) && used >= 0) {
      windows.push({ label, remaining: Math.max(0, 100 - used), observedAt, ...(Number.isFinite(resetAt) && { resetAt }) });
    }
  }
  const demand = summary?.individualUsage?.onDemand;
  if (demand?.enabled === true && Number.isFinite(demand.used) && demand.used >= 0) {
    const limit = Number.isFinite(demand.limit) && demand.limit >= 0 ? demand.limit : null;
    windows.push({
      label: "On-demand", spentCents: demand.used, limitCents: limit,
      remaining: limit > 0 ? Math.max(0, 100 * (1 - demand.used / limit)) : null,
      observedAt, ...(Number.isFinite(resetAt) && { resetAt }),
    });
  }
  return windows;
}

async function readBillingFile(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) return [];
  return windowsFrom(JSON.parse(await fs.readFile(file, "utf8")), stat.mtimeMs);
}

async function cliCookie(configDir) {
  let auth;
  try {
    auth = JSON.parse(await fs.readFile(path.join(configDir, "auth.json"), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const token = auth?.accessToken;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  if (typeof payload.sub !== "string" || !payload.sub.trim()) return null;
  if (Number.isFinite(payload.exp) && payload.exp * 1000 <= Date.now()) {
    throw new Error("Cursor login expired. Run cursor-agent login.");
  }
  return "WorkosCursorSessionToken=" + encodeURIComponent(payload.sub + "::" + token);
}

function cliConfigDir(home) {
  if (process.platform === "darwin") return path.join(home, ".cursor");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor");
}

async function readQuota({ appHome, home = os.homedir(), configDir = cliConfigDir(home) }) {
  if (process.env.HERDR_CURSOR_USAGE_FILE) return readBillingFile(process.env.HERDR_CURSOR_USAGE_FILE);
  const cookie = process.env.HERDR_CURSOR_USAGE_COOKIE || await cliCookie(configDir);
  if (!cookie) return appHome ? readBillingFile(path.join(appHome, "usage", "cursor", "billing.json")) : [];
  if (!/^WorkosCursorSessionToken=[^;\s]+$/.test(cookie)) return [];
  const response = await fetch("https://cursor.com/api/usage-summary", {
    headers: { Accept: "application/json", Cookie: cookie, Origin: "https://cursor.com", Referer: "https://cursor.com/dashboard" },
    redirect: "error", signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return [];
  return windowsFrom(await response.json(), Date.now());
}

const reducer = {
  initial: () => ({ turns: 0, matched: false }),
  fold(state, row) {
    if (row?.role === "user") state.turns++;
    if (row?.role === "user" || row?.role === "assistant") state.matched = true;
  },
  result: state => state.matched ? { turns: state.turns } : null,
};

async function sample({ terminal, sessionId, home = os.homedir(), appHome } = {}) {
  if (!terminal) return { session: null };
  const snapshot = await readSnapshot("cursor", terminal, appHome);
  const id = sessionId || snapshot?.id;
  if (typeof id !== "string" || !UUID.test(id)) return { session: null };
  const bound = snapshot?.id === id ? snapshot : null;
  const root = path.join(home, ".cursor", "projects");
  for (const dir of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, "agent-transcripts", id, id + ".jsonl");
    const stats = await summarizeLog("cursor", file, JSON.stringify([terminal, id]), appHome, reducer).catch(() => null);
    if (stats) return { ...stats, session: { id, ...bound, ...stats.session } };
  }
  return { session: bound };
}

async function quota(options = {}) {
  return { windows: await readQuota(options).catch(() => []) };
}

async function collect(options) {
  const [{ windows }, { session }] = await Promise.all([quota(options), sample(options)]);
  return { windows, session };
}

module.exports = { collect, publish, quota, sample };
if (require.main === module) {
  readHookInput().then(data => publish(data, process.env.HC_TERMINAL_ID, path.resolve(__dirname, "../..")))
    .catch(() => {}).finally(() => process.stdout.write("{}\n"));
}
