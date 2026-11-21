import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { setShared, shared, theme } from "herdr";

const displayPreference = "workspace.usage.quotaDisplay";
const staleAfter = 15 * 60_000;
const providersById = {
  codex: { icon: "codex", tint: false, short: "Codex", hint: "Sign in to Codex on this machine to read subscription limits." },
  cursor: { icon: "cursor", tint: true, short: "Cursor", hint: "Run cursor-agent login to read plan limits, or configure a Cursor billing snapshot." },
  agy: { icon: "antigravity", tint: true, short: "Agy", hint: "Set up the Agy status line and run an Agy session to collect quota." },
  claude: { icon: "claude", tint: false, short: "Claude", hint: "Sign in to Claude Code or set up its status line to collect quota." },
};

function displayMode() {
  return shared(displayPreference) === "used" ? "used" : "remaining";
}

function providerIcon(id, size, color) {
  const { icon = "agent", tint = true } = providersById[id] ?? {};
  const path = `icons/${icon}.svg`;
  return tint ? svg(path).size(size).flex_none().text_color(color) : image(path).w(size).h(size).flex_none();
}

function quotaState(row, now) {
  const at = Number.isFinite(row?.at) ? row.at : null;
  const windows = (row?.windows ?? []).map(w => {
    const observedAt = Number.isFinite(w.observedAt) ? w.observedAt : at;
    const resetAt = Number.isFinite(w.resetAt) ? w.resetAt : null;
    return {
      label: w.label, spentCents: w.spentCents, limitCents: w.limitCents,
      remaining: Number.isFinite(w.remaining) ? Math.max(0, Math.min(100, w.remaining)) : null,
      observedAt, resetAt,
      stale: Boolean(row.error) || (resetAt !== null && resetAt <= now)
        || (observedAt !== null && now - observedAt > staleAfter),
    };
  });
  const observed = windows.filter(w => w.observedAt !== null).map(w => w.observedAt);
  let status = "";
  if (!row) status = "Pending";
  else if (!windows.some(w => w.remaining !== null || Number.isFinite(w.spentCents))) status = row.error ? "Unavailable" : "Unknown";
  else if (windows.some(w => w.stale)) status = "Stale";
  return { windows, status, updatedAt: observed.length ? Math.max(...observed) : at };
}

function percentage(window, mode) {
  if (window.remaining === null) return null;
  const remaining = Math.round(window.remaining);
  return mode === "used" ? 100 - remaining : remaining;
}

function localTime(at) {
  if (at === null) return "";
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
}

function resetLabel(resetAt, now) {
  if (resetAt === null) return "Reset time unknown";
  if (resetAt <= now) return "Reset time passed";
  const minutes = Math.ceil((resetAt - now) / 60_000);
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Resets in ${hours}h ${minutes % 60}m`;
  return `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function quotaSegment({ id, name, row, onClick }) {
  const t = theme();
  const mode = displayMode();
  const { windows, status } = quotaState(row, Date.now());
  const label = providersById[id]?.short ?? name;
  const segment = h_flex().id(`quota-segment-${id}`).h(22).flex_none().px(5).gap(5)
    .items_center().rounded(5).whitespace_nowrap().cursor_pointer()
    .hover(s => s.bg(t.hover)).on_click(onClick)
    .child(providerIcon(id, 13, t.foreground))
    .child(div().font_semibold().text_color(t.foreground).child(label));

  const amounts = windows.filter(w => Number.isFinite(w.spentCents));
  const quotas = windows.filter(w => !Number.isFinite(w.spentCents));
  const summary = id === "agy" ? quotas : quotas.slice(0, 2);
  for (const window of summary) {
    const value = percentage(window, mode);
    segment.child(h_flex().flex_none().items_center().gap(3)
      .child(div().max_w(id === "agy" ? 120 : 70).truncate().text_color(t.muted).child(window.label))
      .child(div().text_color(window.stale ? t.muted : t.foreground).child(value === null ? "—" : `${value}%`)));
  }
  if (summary.some(w => w.remaining !== null)) {
    segment.child(div().text_color(t.muted).child(mode === "used" ? "used" : "left"));
  }
  for (const amount of amounts) {
    segment.child(div().text_color(t.muted).child(amount.label));
    segment.child(div().text_color(t.foreground).child(money(amount.spentCents)));
  }
  if (quotas.length > summary.length) {
    segment.child(div().text_color(t.muted).child(`+${quotas.length - summary.length}`));
  }
  if (status) segment.child(div().text_color(status === "Stale" ? t.working : t.muted).child(status));

  const readings = windows.map(w => {
    const value = percentage(w, mode);
    if (Number.isFinite(w.spentCents)) return `${w.label} ${amountDetail(w)}`;
    return `${w.label} ${value === null ? "unknown" : `${value}% ${mode}`}${w.stale ? " (stale)" : ""}`;
  });
  return segment.tooltip([name, ...readings, status, row?.error].filter(Boolean).join(" · "));
}

function control(t, id, label, active, onClick) {
  return h_flex().id(id).h(27).px(8).gap(5).items_center().justify_center()
    .flex_none().rounded(5).whitespace_nowrap().cursor_pointer().text_size(11.5)
    .text_color(active ? t.foreground : t.muted)
    .when(active, el => el.bg(t.selected).font_semibold())
    .hover(s => s.bg(active ? t.selected : t.hover).text_color(t.foreground))
    .on_click(onClick).child(label);
}

function money(cents) {
  return "$" + (cents / 100).toFixed(2);
}

function amountDetail(window) {
  return money(window.spentCents) + " spent · " + (Number.isFinite(window.limitCents)
    ? money(window.limitCents) + " limit" : "Limit not reported");
}

function windowDetail(t, window, mode, now) {
  const value = percentage(window, mode);
  const amount = Number.isFinite(window.spentCents);
  const fill = window.stale ? t.muted
    : window.remaining <= 5 ? t.blocked : window.remaining <= 20 ? t.working : t.accent;
  const track = div().w_full().h(5).flex_none().rounded_full().overflow_hidden().bg(t.border)
    .when(value > 0, el => el.child(div().h_full().w(`${value}%`).rounded_full().bg(fill)));
  const reset = div().text_size(11).text_color(t.muted).child(resetLabel(window.resetAt, now));
  const time = localTime(window.resetAt);
  if (time) reset.tooltip(time);

  return v_flex().gap(4).flex_none()
    .child(h_flex().min_w(0).gap(8).items_center()
      .child(div().flex_1().min_w(0).font_semibold().child(window.label))
      .when(window.stale, el => el.child(div().flex_none().text_size(11).text_color(t.working).child("Stale")))
      .child(div().flex_none().whitespace_nowrap().font_semibold().child(amount ? amountDetail(window) : value === null ? "Unknown" : `${value}% ${mode}`)))
    .when(!amount || value !== null, el => el.child(track))
    .child(reset);
}

function providerDetail(t, provider, mode, onToggle, onRefresh) {
  const { id, name, on, row } = provider;
  const now = Date.now();
  const { windows, status, updatedAt } = quotaState(row, now);
  const updated = localTime(updatedAt);
  let caption = "Tracking disabled";
  if (on) caption = updated ? `${windows.length ? "Updated" : "Last checked"} ${updated}` : "Update time unknown";
  const toggle = control(t, `quota-toggle-${id}`, on ? "Disable" : "Enable", !on, (_e, cx) => onToggle(id, cx));
  const content = v_flex().w_full().gap(11).p(12).rounded(8).border_1().border_color(t.border).bg(t.raised)
    .child(h_flex().items_center().gap(8)
      .child(providerIcon(id, 17, t.foreground))
      .child(div().flex_1().min_w(0).font_semibold().text_size(14).child(name))
      .when(on && Boolean(onRefresh), el => el.child(
        control(t, `quota-refresh-${id}`, "Refresh", false, (_e, cx) => onRefresh(id, cx))))
      .child(toggle))
    .child(div().text_size(11).text_color(t.muted).child(caption));

  if (!on) return content;
  if (status === "Stale" && row.error) {
    content.child(div().text_color(t.working).child(row.error));
  } else if (status === "Pending") {
    content.child(div().text_color(t.muted).child("Waiting for the first quota reading…"));
  } else if (status === "Unavailable" || status === "Unknown") {
    content.child(div().text_color(t.muted).child(row.error || "No quota data available."));
    const hint = providersById[id]?.hint;
    if (hint) content.child(div().text_color(t.muted).child(hint));
  }
  for (const window of windows) content.child(windowDetail(t, window, mode, now));
  return content;
}

export function quotaPanel({ providers, selectedId, onSelect, onToggle, onRefresh, onClose, sessionSummary, sessionDetail }) {
  const t = theme();
  const mode = displayMode();
  const selected = providers.find(p => p.id === selectedId) ?? providers.find(p => p.on) ?? providers[0];
  const tabs = h_flex().gap(4).flex_wrap().min_w(0);
  for (const provider of providers) {
    const tab = h_flex().gap(5).items_center()
      .child(providerIcon(provider.id, 12, provider.on ? t.foreground : t.muted))
      .child(providersById[provider.id]?.short ?? provider.name);
    tabs.child(control(t, `quota-tab-${provider.id}`, tab, provider === selected, (_e, cx) => onSelect(provider.id, cx))
      .tooltip(`${provider.name} · ${provider.on ? "Enabled" : "Disabled"}`));
  }

  const modes = h_flex().gap(2).p(2).rounded(6).bg(t.chrome);
  for (const value of ["remaining", "used"]) {
    const label = value === "used" ? "Used" : "Remaining";
    modes.child(control(t, `quota-display-${value}`, label, mode === value, () => setShared(displayPreference, value)));
  }

  const close = h_flex().id("quota-close").size(26).items_center().justify_center().rounded(5)
    .flex_none().cursor_pointer().text_color(t.muted)
    .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClose(cx))
    .tooltip("Close usage").child(svg("mods/workspace-chrome/x.svg").size(13));
  const header = v_flex().px(16).pt(12).pb(9).gap(8).flex_none().border_b(1).border_color(t.border)
    .child(h_flex().items_center().gap(8)
      .child(div().flex_1().font_semibold().text_size(15).child("Subscription usage"))
      .child(close))
    .child(h_flex().gap(6).items_center().justify_between().flex_wrap().child(tabs).child(modes));

  const content = v_flex().w_full().min_w(0).gap(12).p(16).whitespace_normal()
    .child(selected ? providerDetail(t, selected, mode, onToggle, onRefresh) : div().text_color(t.muted).child("No providers available."));
  if (sessionSummary || sessionDetail) {
    const session = v_flex().gap(4).px(1).pb(2)
      .child(div().font_semibold().child("Current session"))
      .when(Boolean(sessionSummary), el => el.child(div().text_color(t.foreground).child(sessionSummary)))
      .when(Boolean(sessionDetail), el => el.child(div().text_size(11).text_color(t.muted).child(sessionDetail)));
    content.child(session);
  }
  return v_flex().id("quota-panel").size_full().min_w(0).min_h(0).bg(t.popover)
    .text_size(12).text_color(t.foreground)
    .child(header)
    .child(v_flex().id("quota-scroll").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().child(content));
}
