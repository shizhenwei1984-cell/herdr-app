const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFile } = require("node:child_process");
const exec = require("node:util").promisify(execFile);
const mod = path.join(__dirname, "../defaults/mods/workspace-status");
const { quotaWindows } = require("../defaults/mods/workspace-status/codex-usage.cjs");

test("Codex preserves exhausted windows, meter names, and backend periods", () => {
  const primary = { usedPercent: 100, windowDurationMins: 300, resetsAt: 1000 };
  const regular = { primary, secondary: { usedPercent: 23, windowDurationMins: 10080 } };
  const result = { rateLimits: regular, rateLimitsByLimitId: {
    codex: regular, extra: { limitName: "Reserve", primary: { ...primary, usedPercent: 0 } },
  } };
  assert.deepEqual(quotaWindows(result), [
    { label: "5h", remaining: 0, resetAt: 1000000 },
    { label: "7d", remaining: 77 },
    { label: "Reserve 5h", remaining: 100, resetAt: 1000000 },
  ]);
  assert.deepEqual(quotaWindows({ rateLimits: regular }), quotaWindows(result).slice(0, 2));
  assert.deepEqual(quotaWindows({ rateLimits: { primary: {} } }), []);
});

const id = "01010101-0101-0101-0101-010101010101";
const other = "02020202-0202-0202-0202-020202020202";
const row = (type, payload) => ({ timestamp: "2026-10-10T12:34:00.000Z", type, payload });
const meta = id => row("session_meta", { id, cwd: "/same/project", instructions: "private fixture text" });
const event = (type, data) => row("event_msg", { type, ...data });
const context = (turn_id, model = "gpt-6.2-astra") => row("turn_context", { turn_id, model });
const call = (type, call_id) => row("response_item", { type, call_id, arguments: "private fixture text" });
const counts = (input, output, cache, write = 0) => ({
  input_tokens: input, output_tokens: output, total_tokens: input + output,
  cached_input_tokens: cache, cache_write_input_tokens: write,
});
const usage = (response_id, turn_id, total, latest = total) => row("token_usage_record", {
  thread_id: id, turn_id, response_id, thread_token_usage: total, usage: latest,
});
const line = data => JSON.stringify(data) + "\n";

async function installed(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const appHome = path.join(dir, "app");
  const copied = path.join(appHome, "mods", "workspace-status");
  await fs.mkdir(copied, { recursive: true });
  for (const file of ["usage.cjs", "usage-pricing.cjs", "codex-usage.cjs", "usage-hook.cjs"]) {
    await fs.copyFile(path.join(mod, file), path.join(copied, file));
  }
  const home = path.join(dir, "codex-home");
  const date = path.join(home, "sessions", "2026", "10", "10");
  await fs.mkdir(date, { recursive: true });
  const file = path.join(date, "rollout-2026-10-10T12-34-00-" + id + ".jsonl");
  const append = (...rows) => fs.appendFile(file, rows.map(line).join(""));
  const sample = async (sessionId = id, terminal = "t1") => {
    // PATH contains no Codex. Sampling must work even if the app-server cannot start.
    const { stdout } = await exec(process.execPath, [path.join(copied, "usage.cjs"), "sample", "codex", terminal, sessionId],
      { env: { ...process.env, PATH: dir, CODEX_HOME: home } });
    return JSON.parse(stdout);
  };
  return { dir, appHome, date, file, append, sample };
}

test("the installed Codex sample reads session-wide metrics, follows appends, and ignores other terminals' rollouts", async t => {
  const f = await installed(t);
  const initial = counts(10000, 1000, 4000, 3000);
  await f.append(meta(id), context("a"), event("task_started", { turn_id: "a", model_context_window: 100000 }),
    call("function_call", "shared"), usage("first", "a", initial), call("function_call_output", "output-only"));
  await fs.appendFile(f.file, "x".repeat(3 * 1024 * 1024) + "\n");
  await f.append(context("a"), call("custom_tool_call", "shared"), call("tool_search_call", "next"),
    usage("first", "a", initial), event("task_complete", { turn_id: "a", time_to_first_token_ms: 342 }));
  const second = path.join(f.date, "rollout-2026-10-10T12-34-00-" + other + ".jsonl");
  await fs.writeFile(second, line(meta(other)) + line(context("other", "gpt-6.2-sol")));
  const first = await f.sample();
  assert.equal(typeof first.observedAt, "number");
  assert.deepEqual(first.session, {
    id, model: "gpt-6.2-astra", turns: 1, modelCalls: 1, toolCalls: 2, tokens: 11000,
    inputTokens: 10000, outputTokens: 1000, cacheTokens: 4000, cacheWriteTokens: 3000,
    contextInputTokens: 10000, contextWindow: 100000, ttftMs: 342, pricingModel: "gpt-6.2-astra",
    cacheHitRate: 40, costUsd: 0.0956, costSource: "standard",
  });
  assert.equal((await f.sample(other, "t2")).session.model, "gpt-6.2-sol");
  assert.equal((await f.sample("../escape", "t2")).session, null);
  const total = counts(20000, 1200, 10000, 3000);
  const pending = line(usage("second", "b", total, counts(8000, 200, 6000)));
  await f.append(context("b"));
  await fs.appendFile(f.file, pending.slice(0, -3));
  assert.equal((await f.sample()).session.modelCalls, 1);
  await fs.appendFile(f.file, pending.slice(-3));
  await f.append(event("token_count", { info: {
    total_token_usage: total, last_token_usage: counts(8000, 200, 6000), model_context_window: 80000,
  }}), event("task_complete", { turn_id: "b", time_to_first_token_ms: 150 }));
  const updated = await f.sample();
  assert.equal(updated.generation, first.generation);
  assert.deepEqual([updated.session.turns, updated.session.modelCalls, updated.session.toolCalls], [2, 2, 2]);
  assert.deepEqual([updated.session.outputTokens, updated.session.contextInputTokens, updated.session.contextWindow,
    updated.session.ttftMs, updated.session.cacheHitRate], [1200, 8000, 80000, 150, 50]);
  const contextOnly = { ...counts(0, 0, 0), total_tokens: 80000 };
  await f.append(event("token_count", { info: {
    total_token_usage: contextOnly, last_token_usage: contextOnly, model_context_window: 80000,
  }}));
  assert.deepEqual((await f.sample()).session, updated.session);
  for (const name of await fs.readdir(path.join(f.appHome, "usage", "codex"))) {
    assert.ok(!(await fs.readFile(path.join(f.appHome, "usage", "codex", name), "utf8")).includes("private fixture text"));
  }

  await f.append(context("c", "gpt-6.2-sol"), usage("third", "c", counts(30000, 2000, 11000)),
    event("task_complete", { turn_id: "c" }));
  const mixed = (await f.sample()).session;
  assert.equal(mixed.model, "gpt-6.2-sol");
  assert.equal(mixed.costUsd, undefined);
  assert.equal(mixed.ttftMs, undefined);
});

test("legacy Codex token_count snapshots keep measured output and exclude context-only estimates", async t => {
  const f = await installed(t);
  const recorded = counts(100, 50, 25);
  const synthetic = { ...counts(0, 0, 0), total_tokens: 1000 };
  const tokenCount = (total_token_usage, last_token_usage) => event("token_count", { info: {
    total_token_usage, last_token_usage, model_context_window: 1000,
  } });
  await f.append(meta(id), context("a"), tokenCount(recorded, recorded), tokenCount(synthetic, synthetic));
  const { session } = await f.sample();
  assert.deepEqual([session.tokens, session.outputTokens, session.contextInputTokens, session.cacheHitRate],
    [150, 50, 100, 25]);
  assert.equal(session.modelCalls, undefined);
});

test("a Codex truncation or replacement starts a fresh summary and preserves only current counts", async t => {
  const f = await installed(t);
  await f.append(meta(id), context("a"), usage("first", "a", counts(10, 20, 0)),
    call("function_call", "old"), context("b"), usage("second", "b", counts(20, 40, 1)));
  const first = await f.sample();
  await fs.truncate(f.file, 0);
  await f.append(meta(id), context("c"), usage("third", "c", counts(12, 32, 4)));
  const truncated = await f.sample();
  assert.notEqual(truncated.generation, first.generation);
  assert.deepEqual([truncated.session.turns, truncated.session.modelCalls, truncated.session.toolCalls,
    truncated.session.outputTokens], [1, 1, 0, 32]);

  const replacement = path.join(f.date, "rollout-2026-10-10T12-35-00-" + id + "_" + other + ".jsonl");
  await fs.writeFile(replacement, [meta(id), context("d"), call("custom_tool_call", "new")].map(line).join(""));
  const rotated = await f.sample();
  assert.notEqual(rotated.generation, truncated.generation);
  assert.deepEqual([rotated.session.turns, rotated.session.modelCalls, rotated.session.toolCalls,
    rotated.session.outputTokens], [1, undefined, 1, undefined]);
});

test("Codex applies exact configured rates when available, including treatment of cache writes", async t => {
  const f = await installed(t);
  await f.append(meta(id), context("a", "custom"), usage("first", "a", counts(1000, 100, 200, 100)));
  await fs.mkdir(path.join(f.appHome, "usage"), { recursive: true });
  const file = path.join(f.appHome, "usage", "pricing.json");
  const rate = { input: 1, cached_input: 0.5, output: 2, cache_write: 3 };
  await fs.writeFile(file, JSON.stringify({ customish: rate }));
  assert.equal((await f.sample()).session.costUsd, undefined);
  await fs.writeFile(file, JSON.stringify({ custom: rate }));
  const { session } = await f.sample();
  assert.equal(session.costUsd, 0.0013);
  assert.equal(session.costSource, "configured");
  assert.equal(session.cacheHitRate, 20);
});

test("the collector negotiates stdio and keeps session metrics when quota fails", {
  skip: process.platform === "win32" && "the fixture uses a Unix executable script",
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-rpc-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = "01010101-0101-0101-0101-010101010101";
  const fake = `#!/usr/bin/env node
const { createInterface } = require("node:readline");
let ready = false;
createInterface({input: process.stdin}).on("line", line => {
    const packet = JSON.parse(line);
    if (packet.method === "initialized") { ready = true; return; }
    let result;
    if (packet.method === "initialize") result = {};
    else if (ready && packet.method === "thread/read") {
      result = {thread: {id: packet.params.threadId, model: "fixture-model"}};
    }
    console.log(JSON.stringify({ id: packet.id, result, error: result ? undefined : {code: -1} }));
});
`;
  await fs.writeFile(path.join(dir, "codex"), fake, { mode: 0o700 });
  const helper = path.resolve(__dirname, "../defaults/mods/workspace-status/usage.cjs");
  const { stdout } = await exec(process.execPath, [helper, "read", "codex", "t1", id],
    { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, CODEX_HOME: dir } });
  assert.deepEqual(JSON.parse(stdout), { windows: [], session: { id, model: "fixture-model" } });
});
