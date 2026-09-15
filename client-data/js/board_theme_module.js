// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: shared canvas theme control after boot.
import {
  isBoardTheme,
  themeColor,
  THEME_SVG_RESOURCES,
} from "./board_theme.js";

export class ThemeModule {
  /** @param {() => import("../../types/app-runtime").AppToolsState} getTools */
  constructor(getTools) {
    this.getTools = getTools;
    /** @type {import("./board_theme.js").BoardTheme} */
    this.mode = "light";
    this.received = false;
    this.busy = false;
  }

  /** @param {unknown} input */
  receive(input) {
    const value = /** @type {{theme?: unknown} | null} */ (input);
    if (!value || !isBoardTheme(value.theme)) return;
    this.received = true;
    this.mode = value.theme;
    const Tools = this.getTools();
    this.sync();
    Tools.preferences.colorChangeHandlers.forEach((handler) =>
      handler(Tools.preferences.currentColor),
    );
  }

  /** @param {string} color */
  displayColor(color) {
    return themeColor(color, this.mode);
  }
  /** @param {string} color */
  storedColor(color) {
    return themeColor(color, this.mode, true);
  }

  sync() {
    const Tools = this.getTools();
    if (Tools.dom.status !== "attached") return;
    const button = document.getElementById("boardThemeToggle");
    if (button instanceof HTMLButtonElement) {
      button.hidden = !Tools.access.canBan;
      button.disabled = this.busy || !Tools.connection.socket?.connected;
      button.setAttribute("aria-pressed", String(this.mode === "dark"));
    }
    if (!this.received) return;
    const svg = Tools.dom.svg;
    if (this.mode === "dark" && !svg.querySelector("#wbo-theme-defs"))
      svg.insertAdjacentHTML("afterbegin", THEME_SVG_RESOURCES);
    svg.setAttribute("data-wbo-theme", this.mode);
    document.documentElement.dataset.boardTheme = this.mode;
    document
      .querySelectorAll(".colorPresetButton[data-color]")
      .forEach((element) => {
        if (!(element instanceof HTMLElement)) return;
        const color = this.displayColor(element.dataset.color || "");
        element.style.backgroundColor = color;
        element.setAttribute("aria-label", `${Tools.i18n.t("color")} ${color}`);
        element.title = element.title.replace(/#[0-9a-f]{6}/i, color);
      });
    if (Tools.preferences.colorChooser)
      Tools.preferences.colorChooser.value = this.displayColor(
        Tools.preferences.currentColor,
      );
  }

  init() {
    const Tools = this.getTools();
    this.receive({
      theme:
        Tools.dom.status === "attached"
          ? Tools.dom.svg.getAttribute("data-wbo-theme") || "light"
          : "light",
    });
    document
      .getElementById("boardThemeToggle")
      ?.addEventListener("click", () => void this.toggle());
  }

  async toggle() {
    const Tools = this.getTools();
    if (this.busy || !Tools.access.canBan) return;
    this.busy = true;
    this.sync();
    try {
      const url = new URL(
        `../theme/${encodeURIComponent(Tools.identity.boardName)}`,
        location.href,
      );
      if (Tools.identity.token)
        url.searchParams.set("token", Tools.identity.token);
      const response = await Tools.connection.fetchBoard(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WBO-Theme": "1" },
        body: new Blob(
          [JSON.stringify({ theme: this.mode === "dark" ? "light" : "dark" })],
          { type: "application/json" },
        ),
      });
      if (!response.ok) throw new Error("theme_update_failed");
      this.receive(await response.json());
    } catch {
      await Tools.ui.confirm({
        message: Tools.i18n.t("board_theme_failed"),
        confirmLabel: Tools.i18n.t("moderation_acknowledge"),
        cancelLabel: Tools.i18n.t("Cancel"),
      });
    } finally {
      this.busy = false;
      this.sync();
    }
  }
}
