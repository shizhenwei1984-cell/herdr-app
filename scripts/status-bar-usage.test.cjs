const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const mod = path.join(__dirname, "../defaults/mods/workspace-status");
const load = file => fs.readFileSync(path.join(mod, file), "utf8")
  .replace(/^import .*;\r?$/gm, "").replace(/^export (default )?/gm, "");
const source = load("quota-view.js") + "\n" + load("usage.js");
const explicit = "49F35021-99A9-454A-A029-8EEDDDE44C6B";
const bound = "f5655cd7-6208-47a3-a710-c6a003e86538";

function element() {
  const children = [];
  const node = new Proxy({ children, attributes: {} }, {
    get(target, method) {
      if (method in target) return target[method];
      return (value, callback) => {
        if (method === "child") children.push(value);
        else if (method === "on_click") target.click = value;
        else if (method === "when") {
          if (value) callback(node);
        } else target.attributes[method] = value ?? true;
        return node;
      };
    },
  });
  return node;
}

function renderedText(node) {
  return typeof node === "string" ? [node] : node.children.flatMap(renderedText);
}

function statusBar(terminal, providers, respond = () => ({ windows: [] })) {
  let dialog;
  let now = 100000;
  const requests = [];
  const terminals = [terminal];
  const calls = [];
  const preferences = new Map();
  const detailView = {};
  const api = {
    div: element, v_flex: element, h_flex: element,
    focused: () => ({ terminal: terminal.address }),
    terminals: () => terminals,
    Date: class extends Date { static now() { return now; } },
    appHome: () => "/app",
    shared: key => key === "workspace.usage.providers" ? providers : preferences.get(key),
    setShared: (key, value) => preferences.set(key, value),
    exec: async (_command, [, action, provider, ...selection]) => {
      requests.push([action, provider, ...selection]);
      return { code: 0, stdout: JSON.stringify(await respond(action, provider, ...selection)) };
    },
    openOverlay: ({ props }) => { dialog = props; },
    theme: () => ({}), svg: element, image: element,
    View: class {}, spaces: () => [{ active: true, branch: "main" }], agents: () => [],
    props: () => ({}), checking: () => false, keys: () => [], window: () => ({}), run: name => calls.push(name),
  };
  const code = source + "\n" + load("main.js") + "\nreturn { WorkspaceStatus, details };";
  const { WorkspaceStatus, details } = new Function(...Object.keys(api), code)(...Object.values(api));
  const view = new WorkspaceStatus();
  const tasks = [];
  const cx = { spawn: run => tasks.push(run({ notify() {} })), notify() {} };
  view.init({}, { ...cx, timer: { every(ms, tick) { view.interval = ms; view.tick = tick; } } });
  return {
    requests, calls, interval: view.interval,
    flush: () => Promise.all(tasks.splice(0)),
    tick(at) { now = at; view.tick(cx); },
    focus(next) { terminal = next; terminals.push(next); },
    button: () => renderedText(view.usage.button()),
    render: () => view.render(),
    openDetails: () => view.usage.button().children[0].click(),
    openProvider: id => view.usage.button().children.find(n => n.attributes.id === "quota-segment-" + id).click(),
    details: () => renderedText(details(dialog, detailView)),
    detailTree: () => details(dialog, detailView),
    cx,
  };
}

const selectionCases = [
  ["Codex resume", "codex", ["codex", "resume", explicit], explicit],
  ["Cursor resume", "cursor", ["cursor-agent", "--resume", explicit], explicit],
  ["Agy conversation", "antigravity", ["agy", "--conversation", explicit], explicit],
  ["Claude resume", "claude", ["claude", "--resume", explicit], explicit],
  ["Claude session ID", "claude", ["claude", "--session-id", explicit], explicit],
  ["inline resume ID", "cursor", ["cursor-agent", "--resume=" + explicit], explicit],
  ["inline resume with extra equals", "cursor", ["cursor-agent", "--resume=" + explicit + "=extra"], bound],
  ["bare resume", "cursor", ["cursor-agent", "--resume"], bound],
  ["resume followed by a flag", "claude", ["claude", "--resume", "--verbose"], bound],
  ["non-UUID conversation", "antigravity", ["agy", "--conversation", "conversation-name"], bound],
  ["non-UUID Codex thread without a binding", "codex", ["codex", "resume", "thread-name"], "", { labels: {} }],
  ["empty foreground arguments", "cursor", [], explicit, { argv: ["cursor-agent", "--resume", explicit] }],
];

for (const [name, program, argv, expected, overrides] of selectionCases) {
  test(`selects the session for ${name}`, async () => {
    const provider = program === "antigravity" ? "agy" : program;
    const bar = statusBar({
      address: "t1",
      program: { key: program },
      foreground: { argv },
      labels: { "workspace.usage": provider + "/" + bound },
      ...overrides,
    }, [provider]);
    await bar.flush();
    assert.deepEqual(bar.requests[0], ["sample", provider, "t1", expected]);
  });
}

test("the shipped bar shows exactly four session metrics, keeps quota, and scrolls without hiding commands", async () => {
  const bar = statusBar({ address: "t1", program: { key: "codex" } }, ["codex"], action => action === "sample" ? {
    session: { id: bound, model: "Fixture model", turns: 9, tokens: 100, inputTokens: 78, outputTokens: 22,
      cacheTokens: 25, cacheHitRate: 32, costUsd: 0.125, costSource: "standard",
      modelCalls: 7, toolCalls: 2, contextInputTokens: 50, contextWindow: 100, ttftMs: 22 },
  } : { windows: [{ label: "5h", remaining: 87 }] });
  await bar.flush();
  const tree = bar.render();
  const scroller = tree.children.find(node => node.attributes.id === "workspace-status-scroll");
  assert.equal(scroller.attributes.overflow_x_scrollbar, true);
  assert.equal(scroller.attributes.min_w, 0);
  assert.ok(renderedText(scroller).includes("100 tokens · Standard API est. $0.125 · Cache hit 32.0% · — tok/s"));
  assert.match(renderedText(scroller).join(" "), /Codex 5h 87% left/);
  const command = tree.children.find(node => node.attributes.id === "palette");
  command.click();
  assert.deepEqual(bar.calls, ["app.palette"]);
  bar.openDetails();
  assert.ok(bar.details().some(line => line.includes("Fixture model · 9 turns") &&
    line.includes("Model calls 7 · Tool calls 2 · Context 50/100 (50%) · TTFT 22 ms")));
});

test("an unsupported or unfetched metric stays unknown, including session cost", async () => {
  for (const [key, name] of [["cursor", "Cursor"], ["antigravity", "Agy"], ["claude", "Claude Code"]]) {
    const provider = key === "antigravity" ? "agy" : key;
    const bar = statusBar({ address: "t1", program: { key } }, [provider], action =>
      action === "sample" ? { session: { id: bound, model: "Fixture model", turns: 2, inputTokens: 12 } } : {});
    await bar.flush();
    assert.equal(bar.button()[0], "— tokens · USD — · Cache hit — · — tok/s");
    assert.ok(bar.button().includes("Unknown"));
  }
});

test("local output advances while the quota request is pending, uses observed timing, and expires to idle", async () => {
  let finishQuota;
  let id = bound, output = 700, input = 1000, generation = "one";
  const quota = new Promise(resolve => { finishQuota = resolve; });
  const bar = statusBar({ address: "t1", program: { key: "codex" } }, ["codex"], action =>
    action === "quota" ? quota : { generation, session: { id, outputTokens: output, inputTokens: input } });
  const pending = bar.flush();
  await new Promise(setImmediate);
  assert.equal(bar.interval, 2500);
  assert.match(bar.button()[0], /— tok\/s/);
  input += 5000;
  bar.tick(102600);
  await bar.flush();
  assert.match(bar.button()[0], /idle tok\/s/);
  output += 110;
  bar.tick(105500);
  await bar.flush();
  assert.match(bar.button()[0], /20\.0 tok\/s/);
  for (const at of [108000, 110500, 113000, 115500, 118000]) {
    bar.tick(at);
    await bar.flush();
  }
  assert.match(bar.button()[0], /idle tok\/s/);
  output += 900;
  generation = "two";
  bar.tick(120500);
  await bar.flush();
  assert.match(bar.button()[0], /— tok\/s/);
  id = explicit;
  output += 800;
  bar.tick(123000);
  await bar.flush();
  assert.match(bar.button()[0], /— tok\/s/);
  finishQuota({ windows: [{ label: "5h", remaining: 25 }] });
  await pending;
  assert.equal(bar.requests.filter(([action]) => action === "quota").length, 1);
  assert.match(bar.button().join(" "), /Codex 5h 25% left/);
});

test("same-directory terminal switches discard stale samples and never overlap readers", async () => {
  let finish;
  const slow = new Promise(resolve => { finish = resolve; });
  const providers = ["claude"];
  const terminal = address => ({ address, cwd: "/same/repo", program: { key: "claude" } });
  const bar = statusBar(terminal("t1"), providers, (action, _provider, selected) => {
    if (action === "quota") return { windows: [] };
    return selected === "t1" ? slow : {
      session: { id: explicit, model: "Second", tokens: 12, costUsd: 1.5, costSource: "provider" },
    };
  });
  const pending = bar.flush();
  bar.focus(terminal("t2"));
  bar.tick(102500);
  assert.equal(bar.requests.filter(([action]) => action === "sample").length, 1);
  finish({ session: { id: bound, model: "First", tokens: 3 } });
  await pending;
  assert.match(bar.button()[0], /— tokens/);
  bar.tick(105000);
  await bar.flush();
  assert.equal(bar.button()[0], "12 tokens · Reported $1.50 · Cache hit — · — tok/s");
  bar.openDetails();
  providers.pop();
  bar.tick(107500);
  assert.deepEqual(bar.button(), ["Usage"]);
  assert.ok(bar.details().every(line => !line.includes("Second")));
});

test("provider segments open the matching windows and switch remaining and used together", async () => {
  const windows = [
    { label: "5h", remaining: 0, resetAt: 200000 },
    { label: "Weekly", remaining: 100 },
    { label: "gemini-5h", remaining: 35 },
    { label: "gemini-weekly", remaining: 95 },
  ];
  const bar = statusBar({ address: "t1", program: { key: "codex" } }, ["codex", "agy"],
    (_action, id) => id === "agy" ? { windows } : {});
  await bar.flush();
  assert.ok(bar.button().includes("gemini-5h"));
  assert.ok(bar.button().includes("gemini-weekly"));
  assert.ok(!bar.button().includes("+2"));
  bar.openProvider("agy");
  assert.ok(bar.details().includes("0% remaining"));
  assert.ok(bar.details().includes("100% remaining"));
  function byId(tree, id) {
    if (typeof tree !== "object") return;
    if (tree.attributes.id === id) return tree;
    for (const child of tree.children) {
      const found = byId(child, id);
      if (found) return found;
    }
  }
  byId(bar.detailTree(), "quota-display-used").click(null, bar.cx);
  assert.ok(bar.details().includes("100% used"));
  assert.ok(bar.button().includes("used"));
  byId(bar.detailTree(), "quota-tab-codex").click(null, bar.cx);
  assert.ok(bar.details().includes("No quota data available."));
});

test("Cursor on-demand spend stays visible when no limit is reported", async () => {
  const windows = [{ label: "On-demand", spentCents: 7206, limitCents: null, remaining: null }];
  const bar = statusBar({ address: "t1", program: { key: "cursor" } }, ["cursor"], () => ({ windows }));
  await bar.flush();
  assert.ok(bar.button().includes("$72.06"));
  bar.openProvider("cursor");
  assert.ok(bar.details().includes("$72.06 spent · Limit not reported"));
  assert.ok(!bar.details().includes("No quota data available"));
});

test("bind labels only UUID-shaped session IDs from argv or hook input", {
  skip: process.platform === "win32" && "the fixture uses a Unix executable script",
}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-bar-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const labels = path.join(dir, "labels");
  fs.writeFileSync(path.join(dir, "hc"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$USAGE_TEST_LABELS"\n', { mode: 0o700 });
  const env = { ...process.env, PATH: dir, HC_TERMINAL_ID: "t1", USAGE_TEST_LABELS: labels };
  const bind = (args, input) => spawnSync(process.execPath, [path.join(mod, "usage.cjs"), "bind", "codex", ...args], { env, input });
  assert.equal(bind(["thread-name"]).status, 1);
  assert.equal(bind([], JSON.stringify({ session_id: "--verbose" })).status, 1);
  assert.equal(bind([], JSON.stringify({ session_id: [bound] })).status, 1);
  assert.equal(fs.existsSync(labels), false);
  assert.equal(bind([explicit]).status, 0);
  assert.equal(bind([], JSON.stringify({ session_id: bound })).status, 0);
  assert.equal(fs.readFileSync(labels, "utf8"),
    `label\nt1\nworkspace.usage=codex/${explicit}\nlabel\nt1\nworkspace.usage=codex/${bound}\n`);
});
