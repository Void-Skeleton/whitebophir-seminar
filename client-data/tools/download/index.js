/**
 *                        WHITEBOPHIR
 *********************************************************
 * @licstart  The following is the entire license notice for the
 *  JavaScript code in this page.
 *
 * Copyright (C) 2020  Ophir LOJKINE
 *
 *
 * The JavaScript code in this page is free software: you can
 * redistribute it and/or modify it under the terms of the GNU
 * General Public License (GNU GPL) as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option)
 * any later version.  The code is distributed WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU GPL for more details.
 *
 * As additional permission under GNU GPL version 3 section 7, you
 * may distribute non-source (e.g., minimized or compacted) forms of
 * that code without the copy of the GNU GPL normally required by
 * section 4, provided you include this license notice and a URL
 * through which recipients can access the Corresponding Source.
 *
 * @licend
 */

// Modified 2026-09-15: native compressed backups with moderator import controls.

/** @import { ToolBootContext } from "../../../types/app-runtime" */
/** @typedef {ReturnType<typeof boot>} DownloadToolState */

export const toolId = "download";
export const shortcut = "d";
export const oneTouch = true;
export const mouseCursor = "crosshair";
export const visibleWhenReadOnly = true;

/**
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadContent(blob, filename) {
  const url = URL.createObjectURL(blob);
  const element = document.createElement("a");
  element.setAttribute("href", url);
  element.setAttribute("download", filename);
  element.style.display = "none";
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
  window.URL.revokeObjectURL(url);
}

/** @param {DownloadToolState} state */
function downloadSvgFile(state) {
  const canvasCopy = /** @type {SVGSVGElement} */ (
    state.board.svg.cloneNode(true)
  );
  canvasCopy.removeAttribute("style");
  const styleNode = document.createElement("style");
  styleNode.innerHTML = Array.from(document.styleSheets)
    .filter(
      (stylesheet) =>
        !!(
          stylesheet.href &&
          (stylesheet.href.match(/\/tools\/.*\.css/) ||
            stylesheet.href.match(/board\.css/))
        ),
    )
    .map((stylesheet) =>
      Array.from(stylesheet.cssRules).map((rule) => rule.cssText),
    )
    .join("\n");
  canvasCopy.appendChild(styleNode);
  const outerHTML =
    canvasCopy.outerHTML || new XMLSerializer().serializeToString(canvasCopy);
  downloadContent(
    new Blob([outerHTML], { type: "image/svg+xml;charset=utf-8" }),
    `${state.identity.boardName}.svg`,
  );
}

/** @param {ToolBootContext} ctx */
export function boot(ctx) {
  return {
    board: ctx.runtime.board,
    identity: ctx.runtime.identity,
    access: ctx.runtime.permissions,
    connection: ctx.runtime.connection,
    i18n: ctx.runtime.i18n,
    ui: ctx.runtime.ui,
    config: ctx.runtime.config.serverConfig,
    busy: false,
  };
}

/** @param {DownloadToolState} state */
export function onstart(state) {
  if (!state.busy) void chooseFileAction(state);
  return false;
}

/** @param {DownloadToolState} state */
function archiveUrl(state) {
  const url = new URL(
    `../archive/${encodeURIComponent(state.identity.boardName)}`,
    window.location.href,
  );
  if (state.identity.token) url.searchParams.set("token", state.identity.token);
  return url;
}

/** @param {DownloadToolState} state @param {string} key */
function showNotice(state, key) {
  return state.ui.confirm({
    message: state.i18n.t(key),
    confirmLabel: state.i18n.t("moderation_acknowledge"),
    cancelLabel: state.i18n.t("Cancel"),
  });
}

/** @param {DownloadToolState} state @param {File} file */
async function importFile(state, file) {
  if (state.busy) return;
  state.busy = true;
  try {
    if (!state.access.canBan || !state.access.canEdit)
      throw new Error("write_blocked");
    if (file.size > (state.config.MAX_ARCHIVE_BYTES || 64 * 1024 * 1024))
      throw new Error("archive_too_large");
    const response = await state.connection.fetchBoard(archiveUrl(state), {
      method: "POST",
      headers: {
        "Content-Type": "application/gzip",
        "X-WBO-Archive": "1",
        "X-WBO-Socket-Id": state.connection.socket?.id || "",
      },
      body: file,
    });
    if (!response.ok) throw new Error("archive_import_failed");
    await showNotice(state, "archive_import_success");
  } catch {
    await showNotice(state, "archive_import_failed");
  } finally {
    state.busy = false;
  }
}

/** @param {DownloadToolState} state */
async function chooseFileAction(state) {
  state.busy = true;
  try {
    const choices = [
      { value: "svg", label: state.i18n.t("archive_export_svg") },
      { value: "wbo", label: state.i18n.t("archive_export_wbo") },
    ];
    if (state.access.canBan && state.access.canEdit)
      choices.push({
        value: "import",
        label: state.i18n.t("archive_import_wbo"),
      });
    const action = await state.ui.showActionDialog({
      title: state.i18n.t("download"),
      message: state.i18n.t("archive_import_note"),
      cancelLabel: state.i18n.t("Cancel"),
      sections: [{ id: "file", layout: "stacked", submit: true, choices }],
      link: {
        href:
          state.config.SOURCE_URL || "https://github.com/lovasoa/whitebophir",
        label: state.i18n.t("source_code"),
      },
    });
    if (action?.value === "svg") downloadSvgFile(state);
    if (action?.value === "wbo") {
      const response = await state.connection.fetchBoard(archiveUrl(state));
      if (!response.ok) throw new Error("archive_export_failed");
      downloadContent(await response.blob(), `${state.identity.boardName}.wbo`);
    }
    if (action?.value === "import") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".wbo,application/gzip";
      input.hidden = true;
      input.addEventListener(
        "change",
        () => {
          const file = input.files?.[0];
          input.remove();
          if (file) void importFile(state, file);
        },
        { once: true },
      );
      input.addEventListener("cancel", () => input.remove(), { once: true });
      document.body.appendChild(input);
      input.click();
    }
  } catch {
    await showNotice(state, "archive_export_failed");
  } finally {
    state.busy = false;
  }
}

export function draw() {}
