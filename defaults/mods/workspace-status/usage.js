import { div } from "gpui-kit";
import { quotaSegment, quotaPanel } from "./quota-view.js";
import { h_flex } from "gpui-base";
import { focused, terminals, appHome, exec, shared, setShared, openOverlay, closeOverlay } from "herdr";

export const names = { codex: "Codex", cursor: "Cursor", agy: "Agy", claude: "Claude Code" };
const preference = "workspace.usage.providers";
const localQuotas = new Set(["agy", "claude"]);
const quotaInterval = 60000;
const outputWindow = 12000;
const resumeFlags = { codex: ["resume"], cursor: ["--resume"], agy: ["--conversation"], claude: ["--resume", "--session-id"] };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function selection() {
  const terminal = focused()?.terminal;
  if (!terminal || terminal.includes("/")) return {};
  const t = terminals().find(row => row.address === terminal);
  const provider = t?.program?.key === "antigravity" ? "agy" : t?.program?.key;
  if (!Object.prototype.hasOwnProperty.call(names, provider)) return {};
  const foreground = t.foreground?.argv;
  const argv = Array.isArray(foreground) && foreground.length ? foreground : t.argv;
  const args = Array.isArray(argv) ? argv : [];
  let explicit;
  for (const [index, arg] of args.entries()) {
    const equal = typeof arg === "string" && arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equal === -1 ? arg : arg.slice(0, equal);
    if (!resumeFlags[provider].includes(flag)) continue;
    explicit = equal === -1 ? args[index + 1] : arg.slice(equal + 1);
    break;
  }
  const binding = t.labels?.["workspace.usage"];
  const prefix = provider + "/";
  const bound = binding?.startsWith(prefix) ? binding.slice(prefix.length) : "";
  const id = [explicit, bound].find(id => typeof id === "string" && UUID.test(id)) ?? "";
  return { provider, terminal, id };
}

function enabled() {
  const value = shared(preference);
  return Array.isArray(value) ? value.filter(key => Object.prototype.hasOwnProperty.call(names, key)) : [];
}

function selectionKey({ provider, terminal, id }) {
  return provider ? JSON.stringify([provider, terminal, id]) : "";
}

function quotaTarget(provider, selected) {
  return localQuotas.has(provider) && provider === selected.provider ? selected : {};
}

function selectedSession(sample, selected, active) {
  return active.includes(selected.provider) && sample?.key === selectionKey(selected) ? sample.session : null;
}

const unknown = "—";
function number(n) {
  return Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : unknown;
}

function detailText(s) {
  const context = Number.isFinite(s.contextInputTokens) && s.contextWindow > 0
    ? number(s.contextInputTokens) + "/" + number(s.contextWindow) + " (" + Math.round(100 * s.contextInputTokens / s.contextWindow) + "%)"
    : Number.isFinite(s.contextPercent) ? number(s.contextPercent) + "%" : unknown;
  return [
    s.model || "Model " + unknown,
    number(s.turns) + (s.turns === 1 ? " turn" : " turns"),
    "Total " + number(s.tokens) + " tokens",
    "In " + number(s.inputTokens),
    "Out " + number(s.outputTokens),
    "Cached " + number(s.cacheTokens),
    "Model calls " + number(s.modelCalls),
    "Tool calls " + number(s.toolCalls),
    "Context " + context,
    "TTFT " + (Number.isFinite(s.ttftMs) ? number(s.ttftMs) + " ms" : unknown),
  ].join(" · ");
}

function inlineMetrics(session) {
  const amount = session?.costUsd;
  const source = { provider: "Reported", standard: "Standard API est.", configured: "Configured est." }[session?.costSource];
  let cost = "USD " + unknown;
  if (Number.isFinite(amount) && source) {
    const dollars = amount > 0 && amount < 0.0001
      ? "<$0.0001" : "$" + amount.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, "$1");
    cost = source + " " + dollars;
  }
  const hit = session?.cacheHitRate;
  const rate = session?.outputRate;
  return [
    number(session?.tokens) + " tokens",
    cost,
    "Cache hit " + (Number.isFinite(hit) ? hit.toFixed(1) + "%" : unknown),
    (rate === 0 ? "idle" : Number.isFinite(rate) ? rate.toFixed(1) : unknown) + " tok/s",
  ].join(" · ");
}

// Compare observed cumulative output across a short window. Reset on a
// discontinuity, including a different transcript for the same session ID.
function observeOutput(previous, session, generation, at) {
  if (!Number.isFinite(session?.outputTokens)) return null;
  const sample = { at, tokens: session.outputTokens };
  const series = previous?.id === session.id && previous.generation === generation ? previous : null;
  const last = series?.samples.at(-1);
  if (!last || at <= last.at || at - last.at >= outputWindow || sample.tokens < last.tokens) {
    return { id: session.id, generation, samples: [sample], lastGrowth: null };
  }
  const samples = series.samples.filter(point => at - point.at < outputWindow);
  const first = samples[0] ?? last;
  const lastGrowth = sample.tokens > last.tokens ? at : series.lastGrowth;
  const rate = lastGrowth != null && at - lastGrowth < outputWindow
    ? (sample.tokens - first.tokens) * 1000 / (at - first.at) : 0;
  return { ...series, samples: [...samples, sample], lastGrowth, rate };
}

async function collect(action, provider, selected) {
  const args = [appHome() + "/mods/workspace-status/usage.cjs", action, provider];
  if (selected.terminal) args.push(selected.terminal, selected.id);
  const response = await exec("node", args, { timeout: 22000 });
  if (response.code !== 0) throw Error();
  return JSON.parse(response.stdout);
}

export class Usage {
  constructor() {
    this.quotas = {};
    this.quotaBusy = new Set();
    this.session = null;
    this.sessionBusy = false;
    this.key = "";
  }

  refresh(cx) {
    const active = enabled();
    const selected = selection();
    const key = active.includes(selected.provider) ? selectionKey(selected) : "";
    if (this.key !== key) {
      this.key = key;
      this.session = null;
      cx.notify();
    }
    const current = this.session?.output;
    if (current?.rate > 0 && Date.now() - current.lastGrowth >= outputWindow) {
      current.rate = 0;
      this.session.session.outputRate = 0;
      cx.notify();
    }
    if (key && !this.sessionBusy) {
      this.sessionBusy = true;
      cx.spawn(async cx => {
        let value;
        try {
          value = await collect("sample", selected.provider, selected);
        } catch {
          value = { session: null };
        } finally {
          this.sessionBusy = false;
        }
        if (selectionKey(selection()) !== key || this.key !== key || !enabled().includes(selected.provider)) return;
        const output = observeOutput(this.session?.output, value.session, value.generation, value.observedAt ?? Date.now());
        this.session = {
          key, output,
          session: value.session && { ...value.session, outputRate: output?.rate },
        };
        cx.notify();
      });
    }

    for (const provider of Object.keys(names)) {
      if (!active.includes(provider)) {
        delete this.quotas[provider];
        continue;
      }
      const target = quotaTarget(provider, selected);
      const quotaKey = selectionKey(target);
      const previous = this.quotas[provider];
      if (this.quotaBusy.has(provider) || (previous?.key === quotaKey && Date.now() - previous.at < quotaInterval)) continue;
      this.quotaBusy.add(provider);
      cx.spawn(async cx => {
        let value;
        try {
          value = await collect("quota", provider, target);
        } catch {
          value = { windows: [], error: "Collector unavailable. Check Node.js and provider setup." };
        } finally {
          this.quotaBusy.delete(provider);
        }
        if (!enabled().includes(provider)) return;
        if (selectionKey(quotaTarget(provider, selection())) !== quotaKey) return;
        this.quotas[provider] = { ...value, at: Date.now(), key: quotaKey };
        cx.notify();
      });
    }
  }

  button() {
    const selected = selection();
    const active = enabled();
    const session = selectedSession(this.session, selected, active);
    const open = provider => openOverlay({
      mod: "workspace-status", kind: "dialog", width: 500, height: 425,
      props: { details: true, provider, quotas: this.quotas, sample: this.session, selected },
    });
    const bar = h_flex().flex_none().gap(14).items_center();
    if (active.includes(selected.provider) || !active.length) {
      const text = active.includes(selected.provider) ? inlineMetrics(session) : "Usage";
      bar.child(div().id("workspace-usage").cursor_pointer().whitespace_nowrap()
        .tooltip("Session usage · output tokens/s updates as new usage is reported")
        .on_click(() => open(selected.provider)).child(text));
    }
    for (const id of active) {
      const row = this.quotas[id];
      bar.child(quotaSegment({ id, name: names[id], row: row?.key === selectionKey(quotaTarget(id, selected)) ? row : null,
        onClick: () => open(id) }));
    }
    return bar;
  }
}

export function details({ provider, quotas = {}, sample, selected = {}, overlay }, view = {}) {
  const active = enabled();
  const session = selectedSession(sample, selected, active);
  const selectedId = view.selectedProvider || provider || active[0] || "codex";
  const providers = Object.entries(names).map(([id, name]) => {
    const row = view.freshQuotas?.[id] ?? quotas[id];
    return { id, name, on: active.includes(id), row: row?.key === selectionKey(quotaTarget(id, selected)) ? row : null };
  });
  function refresh(id, cx) {
    view.pendingQuotas ??= new Set();
    if (view.pendingQuotas.has(id)) return;
    view.pendingQuotas.add(id);
    cx.spawn(async cx => {
      const target = quotaTarget(id, selected);
      let value;
      try { value = await collect("quota", id, target); }
      catch { value = { windows: [], error: "Collector unavailable" }; }
      view.pendingQuotas.delete(id);
      view.freshQuotas ??= {};
      view.freshQuotas[id] = { ...value, at: Date.now(), key: selectionKey(target) };
      cx.notify();
    });
  }
  return quotaPanel({
    providers, selectedId, onRefresh: refresh,
    sessionSummary: session ? inlineMetrics(session) : selected.provider ? "Session unavailable" : "No local agent focused",
    sessionDetail: session ? detailText(session) : "",
    onSelect: (id, cx) => { view.selectedProvider = id; cx.notify(); },
    onToggle: (id, cx) => {
      const ids = enabled();
      if (ids.includes(id)) {
        setShared(preference, ids.filter(p => p !== id));
        cx.notify();
        return;
      }
      setShared(preference, [...ids, id]);
      cx.notify();
      refresh(id, cx);
    },
    onClose: () => closeOverlay(overlay),
  });
}
