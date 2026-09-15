// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: presentation controls after viewport boot.
import {
  DEFAULT_CHUNKS,
  GRID_CHANGE_EVENT,
  chunkRect,
  isActivityPoint,
  validateChunkState,
} from "./board_chunks.js";

export class ChunksModule {
  /** @param {() => import("../../types/app-runtime").AppToolsState} getTools */
  constructor(getTools) {
    this.getTools = getTools;
    /** @type {import("./board_chunks.js").ChunkState} */
    this.state = { ...DEFAULT_CHUNKS };
    this.following = false;
    this.received = false;
    /** @type {HTMLElement | null} */
    this.panel = null;
    /** @type {SVGPatternElement | null} */
    this.pattern = null;
    /** @type {SVGRectElement | null} */
    this.grid = null;
    this.frameKey = "";
    this.frameDeferred = false;
  }

  storageKey() {
    return `wbo-follow-chunk-v1:${location.pathname}`;
  }
  isLocked() {
    return this.state.locked && !this.getTools().access.canBan;
  }

  /** @param {unknown} input */
  receive(input) {
    const state = validateChunkState(input);
    if (!state) return;
    const changed = this.state.revision !== state.revision;
    this.state = state;
    if (!this.received) {
      this.following = state.follow;
      try {
        const saved = JSON.parse(
          localStorage.getItem(this.storageKey()) || "null",
        );
        if (
          saved?.revision === state.revision &&
          typeof saved.follow === "boolean"
        )
          this.following = saved.follow;
      } catch {
        /* Storage is optional. */
      }
    } else if (changed && !this.getTools().access.canBan)
      this.following = state.follow;
    this.received = true;
    this.sync();
  }

  /** @param {unknown} point @param {string} [sourceSocketId] */
  activity(point, sourceSocketId) {
    if (!isActivityPoint(point)) return;
    this.state = { ...this.state, point };
    this.syncFrame(
      !!sourceSocketId &&
        sourceSocketId === this.getTools().connection.socket?.id,
    );
  }

  /** @param {boolean} value */
  setFollowing(value) {
    if (this.isLocked()) return;
    this.following = value;
    this.sync();
  }

  sync() {
    if (!this.received) return;
    if (this.isLocked()) this.following = this.state.follow;
    try {
      localStorage.setItem(
        this.storageKey(),
        JSON.stringify({
          revision: this.state.revision,
          follow: this.following,
        }),
      );
    } catch {
      /* Optional. */
    }
    const button = document.getElementById("chunkFollowToggle");
    button?.setAttribute("aria-pressed", String(this.following));
    if (button instanceof HTMLButtonElement) button.disabled = this.isLocked();
    const settings = document.getElementById("chunkSettingsToggle");
    if (settings) settings.hidden = !this.getTools().access.canBan;
    const lock = document.getElementById("chunkFollowLocked");
    if (lock) lock.hidden = !this.isLocked();
    if (this.panel && !this.getTools().access.canBan) this.panel.remove();
    this.syncGrid();
    this.syncFrame();
  }

  /** @param {boolean} [deferUntilStrokeEnd] */
  syncFrame(deferUntilStrokeEnd = false) {
    const Tools = this.getTools();
    if (!this.received || Tools.replay.awaitingSnapshot) return;
    const rect = chunkRect(this.state, this.state.point);
    const key = this.following
      ? `${rect.x},${rect.y},${rect.width},${rect.height},${this.state.margin}`
      : "";
    if (key === this.frameKey && !(this.frameDeferred && !deferUntilStrokeEnd))
      return;
    this.frameKey = key;
    this.frameDeferred = deferUntilStrokeEnd;
    Tools.viewportState.controller.setFollowFrame(
      this.following ? { ...rect, margin: this.state.margin } : null,
      deferUntilStrokeEnd,
    );
  }

  syncGrid() {
    const Tools = this.getTools();
    if (Tools.dom.status !== "attached") return;
    if (!this.pattern && !this.state.revision && !this.following) return;
    if (!this.pattern) {
      const ns = "http://www.w3.org/2000/svg";
      this.pattern = document.createElementNS(ns, "pattern");
      this.pattern.id = "activityChunkGrid";
      this.pattern.setAttribute("patternUnits", "userSpaceOnUse");
      const line = document.createElementNS(ns, "path");
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "#b8c0cc");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("vector-effect", "non-scaling-stroke");
      this.pattern.append(line);
      Tools.dom.svg.querySelector("defs")?.append(this.pattern);
      this.grid = document.createElementNS(ns, "rect");
      this.grid.id = "activityChunkGridContainer";
      this.grid.setAttribute("width", "100%");
      this.grid.setAttribute("height", "100%");
      this.grid.setAttribute("fill", "url(#activityChunkGrid)");
      this.grid.setAttribute("pointer-events", "none");
      Tools.dom.svg.insertBefore(this.grid, Tools.dom.drawingArea);
    }
    const { width, height, revision } = this.state;
    this.pattern.setAttribute("width", String(width));
    this.pattern.setAttribute("height", String(height));
    this.pattern.firstElementChild?.setAttribute(
      "d",
      `M ${width} 0 H 0 V ${height}`,
    );
    const fill = Tools.dom.svg
      .querySelector("#gridContainer")
      ?.getAttribute("fill");
    const highlighted = !!fill && fill !== "none";
    this.pattern.firstElementChild?.setAttribute(
      "stroke-width",
      highlighted ? "8" : "1",
    );
    this.pattern.firstElementChild?.setAttribute(
      "stroke",
      highlighted ? "#475569" : "#b8c0cc",
    );
    if (this.grid)
      this.grid.style.display = revision || this.following ? "" : "none";
  }

  init() {
    const Tools = this.getTools();
    if (Tools.dom.status === "attached")
      Tools.dom.svg.addEventListener(GRID_CHANGE_EVENT, () => this.syncGrid());
    document
      .getElementById("chunkFollowToggle")
      ?.addEventListener("click", () => this.setFollowing(!this.following));
    document
      .getElementById("chunkSettingsToggle")
      ?.addEventListener("click", () => this.openSettings());
  }

  openSettings() {
    const Tools = this.getTools();
    if (!Tools.access.canBan || this.panel?.isConnected) return;
    const dialog = document.createElement("dialog");
    dialog.className = "wbo-dialog chunk-settings-dialog";
    this.panel = dialog;
    const form = document.createElement("form");
    const title = document.createElement("h2");
    title.id = "chunkSettingsTitle";
    title.textContent = Tools.i18n.t("chunk_settings");
    dialog.setAttribute("aria-labelledby", title.id);
    form.append(title);

    const inputs =
      /** @type {Record<"width" | "height" | "margin" | "follow" | "locked", HTMLInputElement>} */ ({});
    for (const key of /** @type {const} */ ([
      "width",
      "height",
      "margin",
      "follow",
      "locked",
    ])) {
      const label = document.createElement("label");
      const text = document.createElement("span");
      text.textContent = Tools.i18n.t(`chunk_${key}`);
      const input = document.createElement("input");
      input.name = key;
      input.id = `chunk-${key}`;
      const value = this.state[key];
      if (typeof value === "boolean") {
        input.type = "checkbox";
        input.checked = value;
      } else {
        input.type = "number";
        input.min = key === "margin" ? "0" : "100";
        input.max = "100000";
        input.step = "1";
        input.required = true;
        input.value = String(value);
      }
      label.append(text, input);
      form.append(label);
      inputs[key] = input;
    }
    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    form.append(error);
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = Tools.i18n.t("chunk_save");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = Tools.i18n.t("Cancel");
    cancel.onclick = () => dialog.close();
    form.append(save, cancel);
    dialog.append(form);
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      dialog.remove();
      this.panel = null;
    });
    form.onsubmit = async (event) => {
      event.preventDefault();
      save.disabled = true;
      error.textContent = "";
      try {
        const url = new URL(
          `../chunks/${encodeURIComponent(Tools.identity.boardName)}`,
          location.href,
        );
        if (Tools.identity.token)
          url.searchParams.set("token", Tools.identity.token);
        const settings = {
          width: Number(inputs.width.value),
          height: Number(inputs.height.value),
          margin: Number(inputs.margin.value),
          follow: inputs.follow.checked,
          locked: inputs.locked.checked,
        };
        const response = await Tools.connection.fetchBoard(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-WBO-Chunks": "1" },
          body: new Blob([JSON.stringify(settings)], {
            type: "application/json",
          }),
        });
        if (!response.ok) throw new Error("save failed");
        this.receive(await response.json());
        dialog.close();
      } catch {
        error.textContent = Tools.i18n.t("chunk_save_failed");
        save.disabled = false;
      }
    };
    dialog.showModal();
  }
}
