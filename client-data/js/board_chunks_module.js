// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: presentation controls and persistent chunk borders.
import {
  DEFAULT_CHUNKS,
  chunkRect,
  isActivityPoint,
  isViewMode,
  validateChunkState,
} from "./board_chunks.js";

/** @typedef {import("./board_chunks.js").ViewMode} ViewMode */
const NAVIGATION_CONFIRM_MS = 2000;

export class ChunksModule {
  /** @param {() => import("../../types/app-runtime").AppToolsState} getTools */
  constructor(getTools) {
    this.getTools = getTools;
    /** @type {import("./board_chunks.js").ChunkState} */
    this.state = { ...DEFAULT_CHUNKS };
    this.mode = /** @type {ViewMode} */ ("free");
    this.focusedPoint = { x: 0, y: 0 };
    /** @type {{key: string, expiresAt: number} | null} */
    this.pendingNavigation = null;
    /** @type {import("../../types/app-runtime").BoardStatusView | null} */
    this.navigationNotice = null;
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
  get following() {
    return this.mode === "latest";
  }
  /** @param {unknown} input */
  receive(input) {
    const state = validateChunkState(input);
    if (!state) return;
    const changed = this.state.revision !== state.revision;
    this.state = state;
    if (!this.received) {
      this.mode = state.viewMode;
      this.focusedPoint = state.point;
      try {
        const saved = JSON.parse(
          localStorage.getItem(this.storageKey()) || "null",
        );
        if (saved?.revision === state.revision) {
          if (isViewMode(saved.mode)) this.mode = saved.mode;
          else if (typeof saved.follow === "boolean")
            this.mode = saved.follow ? "latest" : "free";
          if (isActivityPoint(saved.point)) this.focusedPoint = saved.point;
        }
      } catch {
        /* Storage is optional. */
      }
    } else if (changed && !this.getTools().access.canBan) {
      this.mode = state.viewMode;
      this.focusedPoint = state.point;
    }
    if (changed) this.clearNavigationNotice();
    this.received = true;
    this.sync();
  }

  /** @param {unknown} point @param {string} [sourceSocketId] */
  activity(point, sourceSocketId) {
    if (!isActivityPoint(point)) return;
    this.state = { ...this.state, point };
    if (this.following)
      this.syncFrame(
        !!sourceSocketId &&
          sourceSocketId === this.getTools().connection.socket?.id,
      );
  }

  /** @param {boolean} value */
  setFollowing(value) {
    this.setMode(value ? "latest" : "free");
  }

  /** @param {unknown} mode */
  setMode(mode) {
    if (!isViewMode(mode)) return;
    if (mode === "chunk" && this.mode !== "chunk") {
      this.focusedPoint = this.following
        ? this.state.point
        : this.getTools().viewportState.controller.getViewCenter();
    }
    this.mode = mode;
    this.clearNavigationNotice();
    this.sync();
  }

  sync() {
    if (!this.received) return;
    try {
      localStorage.setItem(
        this.storageKey(),
        JSON.stringify({
          revision: this.state.revision,
          mode: this.mode,
          point: this.focusedPoint,
        }),
      );
    } catch {
      /* Optional. */
    }
    const select = document.getElementById("chunkViewMode");
    if (select instanceof HTMLSelectElement) {
      select.value = this.mode;
    }
    const settings = document.getElementById("chunkSettingsToggle");
    if (settings) settings.hidden = !this.getTools().access.canBan;
    if (this.panel && !this.getTools().access.canBan) this.panel.remove();
    this.syncGrid();
    this.syncFrame();
  }

  /** @param {boolean} [deferUntilStrokeEnd] */
  syncFrame(deferUntilStrokeEnd = false) {
    const Tools = this.getTools();
    if (!this.received || Tools.replay.awaitingSnapshot) return;
    const rect = chunkRect(
      this.state,
      this.following ? this.state.point : this.focusedPoint,
    );
    const key =
      this.mode !== "free"
        ? `${rect.x},${rect.y},${rect.width},${rect.height},${this.state.margin}`
        : "";
    if (key === this.frameKey && !(this.frameDeferred && !deferUntilStrokeEnd))
      return;
    this.frameKey = key;
    this.frameDeferred = deferUntilStrokeEnd;
    Tools.viewportState.controller.setFollowFrame(
      this.mode !== "free" ? { ...rect, margin: this.state.margin } : null,
      deferUntilStrokeEnd,
    );
  }

  syncGrid() {
    const Tools = this.getTools();
    if (Tools.dom.status !== "attached") return;
    if (!this.pattern && !this.state.revision && this.mode === "free") return;
    if (!this.pattern) {
      const ns = "http://www.w3.org/2000/svg";
      this.pattern = document.createElementNS(ns, "pattern");
      this.pattern.id = "activityChunkGrid";
      this.pattern.setAttribute("patternUnits", "userSpaceOnUse");
      const line = document.createElementNS(ns, "path");
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "#475569");
      line.setAttribute("stroke-width", "8");
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
    if (this.grid)
      this.grid.style.display = revision || this.mode !== "free" ? "" : "none";
  }

  init() {
    window.addEventListener("keydown", (event) =>
      this.handleChunkShortcut(event),
    );
    window.addEventListener("blur", () => this.clearNavigationNotice());
    document
      .getElementById("chunkViewMode")
      ?.addEventListener("change", (event) => {
        if (event.target instanceof HTMLSelectElement)
          this.setMode(event.target.value);
      });
    document
      .getElementById("chunkSettingsToggle")
      ?.addEventListener("click", () => this.openSettings());
  }

  /** @param {KeyboardEvent} event */
  handleChunkShortcut(event) {
    const Tools = this.getTools();
    if (
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing ||
      event.defaultPrevented ||
      !this.received ||
      (this.mode === "free" && event.ctrlKey && !this.state.revision) ||
      Tools.replay.awaitingSnapshot
    )
      return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], dialog",
      )
    )
      return;
    if (!/^Arrow(Left|Right|Up|Down)$/.test(event.key)) return;
    event.preventDefault();
    this.navigateByArrow(event.key, event.ctrlKey, event.repeat);
  }

  /**
   * Shared by keyboard shortcuts and the personal wheel navigation preference.
   * @param {string} arrow
   * @param {boolean} [ctrlKey]
   * @param {boolean} [repeat]
   * @param {"keyboard" | "wheel"} [source]
   */
  navigateByArrow(arrow, ctrlKey = false, repeat = false, source = "keyboard") {
    const Tools = this.getTools();
    if (!this.received || Tools.replay.awaitingSnapshot) return;
    let dx = 0;
    let dy = 0;
    switch (arrow) {
      case "ArrowLeft":
        dx = -1;
        break;
      case "ArrowRight":
        dx = 1;
        break;
      case "ArrowUp":
        dy = -1;
        break;
      case "ArrowDown":
        dy = 1;
        break;
      default:
        return;
    }
    if (this.following) {
      const key = `${source}:${ctrlKey ? "Ctrl+" : ""}${arrow}`;
      const now = performance.now();
      const pending = this.pendingNavigation;
      if (
        repeat ||
        !pending ||
        pending.key !== key ||
        now > pending.expiresAt
      ) {
        // Holding a key or continuing one wheel gesture cannot confirm.
        if (!repeat)
          this.pendingNavigation = {
            key,
            expiresAt: now + NAVIGATION_CONFIRM_MS,
          };
        this.navigationNotice = {
          hidden: false,
          state: "paused",
          title: Tools.i18n.t("chunk_view_latest"),
          detail: Tools.i18n.t(
            source === "wheel"
              ? "chunk_wheel_navigation_reminder"
              : "chunk_navigation_reminder",
          ),
        };
        Tools.status.showBoardStatus(
          this.navigationNotice,
          NAVIGATION_CONFIRM_MS,
        );
        return;
      }
      this.setMode("chunk");
    }
    if (this.mode === "chunk") {
      const rect = chunkRect(this.state, this.focusedPoint);
      this.focusedPoint = {
        x: Tools.coordinates.toBoardCoordinate(rect.x + dx * rect.width),
        y: Tools.coordinates.toBoardCoordinate(rect.y + dy * rect.height),
      };
      this.sync();
    } else {
      Tools.viewportState.controller.panByKeyboard(
        dx,
        dy,
        ctrlKey ? this.state.width : undefined,
        ctrlKey ? this.state.height : undefined,
      );
    }
  }

  clearNavigationNotice() {
    this.pendingNavigation = null;
    const status = this.getTools().status;
    if (
      this.navigationNotice &&
      status.explicitBoardStatus === this.navigationNotice
    )
      status.clearBoardStatus();
    this.navigationNotice = null;
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
      /** @type {Record<"width" | "height" | "margin", HTMLInputElement>} */ ({});
    for (const key of /** @type {const} */ (["width", "height", "margin"])) {
      const label = document.createElement("label");
      const text = document.createElement("span");
      text.textContent = Tools.i18n.t(`chunk_${key}`);
      const input = document.createElement("input");
      input.name = key;
      input.id = `chunk-${key}`;
      input.type = "number";
      input.min = key === "margin" ? "0" : "100";
      input.max = "100000";
      input.step = "1";
      input.required = true;
      input.value = String(this.state[key]);
      label.append(text, input);
      form.append(label);
      inputs[key] = input;
    }
    const viewLabel = document.createElement("label");
    viewLabel.append(Tools.i18n.t("chunk_view_for_others"));
    const viewMode = document.createElement("select");
    viewMode.id = "chunk-view-mode";
    for (const mode of ["free", "chunk", "latest"]) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = Tools.i18n.t(`chunk_view_${mode}`);
      viewMode.append(option);
    }
    viewMode.value = this.state.viewMode;
    viewLabel.append(viewMode);
    form.append(viewLabel);
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
          viewMode: viewMode.value,
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
