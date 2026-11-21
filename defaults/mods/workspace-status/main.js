import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, props, checking } from "herdr";

import { Usage, details } from "./usage.js";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    if (checking()) return;
    if (props()?.details) {
      cx.timer.every(60000, cx => cx.notify());
      return;
    }
    this.usage = new Usage();
    this.usage.refresh(cx);
    cx.timer.every(2500, cx => this.usage.refresh(cx));
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    if (props()?.details) return details(props(), this);
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().flex_none().gap(6).items_center().whitespace_nowrap()
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const scroll = h_flex().id("workspace-status-scroll").flex_1().min_w(0).h_full()
      .overflow_x_scrollbar().mode("always").items_center().pb(5).gap(16)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().flex_none().gap(6).items_center().whitespace_nowrap()
        .child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} ${list.length === 1 ? "agent" : "agents"}`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} ${needs === 1 ? "needs" : "need"} you`))))
      .child(div().flex_1())
      .when(Boolean(this.usage), el => el.child(this.usage.button()));
    return h_flex().size_full().min_w(0).px(14).gap(16).items_center().bg(t.chrome).border_t(1)
      .border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(scroll)
      .child(div().id("palette").flex_none().whitespace_nowrap().text_color(t.dim)
        .on_click(() => run("app.palette")).child(this.hint()));
  }
}
