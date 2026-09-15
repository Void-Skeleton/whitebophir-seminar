// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: per-board name cookies and rename UI.
import { SocketEvents } from "./socket_events.js";
import { MAX_USER_NAME_LENGTH, normalizeUserName } from "./user_name.js";

const COOKIE = "wbo-board-name-v1";
/** @import { AppToolsState, ConnectedUser } from "../../types/app-runtime.d.ts" */

function readNameCookie() {
  try {
    for (const part of document.cookie.split(";")) {
      const cookie = part.trim();
      if (cookie.startsWith(`${COOKIE}=`))
        return normalizeUserName(
          decodeURIComponent(cookie.slice(COOKIE.length + 1)),
        );
    }
  } catch {
    /* Disabled storage or malformed cookie. */
  }
  return null;
}

/** @param {string} board @param {string} name */
function saveNameCookie(board, name) {
  const base = new URL(location.href);
  const path = `${base.pathname.split("/boards/")[0]}/boards/${encodeURIComponent(board)}`;
  // biome-ignore lint/suspicious/noDocumentCookie: Names must persist in cookies on plain HTTP too.
  document.cookie = `${COOKIE}=${encodeURIComponent(name)}; Path=${path}; Max-Age=31536000; SameSite=Lax${base.protocol === "https:" ? "; Secure" : ""}`;
}

export class UserNameController {
  /** @param {() => AppToolsState} getTools */
  constructor(getTools) {
    this.getTools = getTools;
    this.initialized = false;
    this.promptStarted = false;
    this.resolved = false;
    this.dialogOpen = false;
    this.urlName = /** @type {string | null} */ (null);
    this.currentName = "";
  }

  forConnection() {
    if (!this.initialized) {
      this.initialized = true;
      this.urlName = normalizeUserName(
        new URL(location.href).searchParams.get("name"),
      );
    }
    return this.urlName || readNameCookie() || this.currentName;
  }

  /** @param {ConnectedUser} user */
  receive(user) {
    const Tools = this.getTools();
    if (user.socketId !== Tools.connection.socket?.id) return;
    const requested = this.urlName;
    this.urlName = null;
    if (requested && requested !== user.name) {
      void this.save(requested, user.socketId).then((error) => {
        if (error) void this.edit(user);
      });
      return;
    }
    if (user.nameChosen) {
      this.currentName = user.name;
      this.resolved = true;
      try {
        saveNameCookie(Tools.identity.boardName, user.name);
      } catch {
        /* Keep the live name. */
      }
      const url = new URL(location.href);
      if (url.searchParams.has("name")) {
        url.searchParams.delete("name");
        history.replaceState(history.state, "", url);
      }
    } else if (!this.promptStarted) {
      this.promptStarted = true;
      // Opening a native modal makes the entire SVG inert. Let replay and its
      // first paint finish before applying that change to a large board.
      const promptAfterReplay = () => {
        if (this.resolved) return;
        if (Tools.replay.awaitingSnapshot) {
          requestAnimationFrame(promptAfterReplay);
          return;
        }
        requestAnimationFrame(() => {
          const current = Tools.presence.users.get(
            Tools.connection.socket?.id || "",
          );
          if (current && !current.nameChosen) void this.edit(current, true);
        });
      };
      requestAnimationFrame(promptAfterReplay);
    }
  }

  /** @param {string} value @param {string} socketId @returns {Promise<string | null>} */
  async save(value, socketId) {
    const Tools = this.getTools();
    const name = normalizeUserName(value);
    if (!name) return Tools.i18n.t("user_name_invalid");
    const socket = Tools.connection.socket;
    if (!socket?.connected) return Tools.i18n.t("user_name_unavailable");
    return new Promise((resolve) => {
      const timeout = window.setTimeout(
        () => resolve(Tools.i18n.t("user_name_unavailable")),
        8000,
      );
      socket.emit(SocketEvents.SET_USER_NAME, { name, socketId }, (result) => {
        window.clearTimeout(timeout);
        if (result?.ok === true) resolve(null);
        else {
          const key =
            result?.ok === false &&
            [
              "user_name_invalid",
              "user_name_forbidden",
              "user_name_rate_limited",
            ].includes(result.error)
              ? result.error
              : "user_name_unavailable";
          resolve(Tools.i18n.t(key));
        }
      });
    });
  }

  /** @param {ConnectedUser} user @param {boolean} [firstVisit] */
  async edit(user, firstVisit = false) {
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    const Tools = this.getTools();
    const result = await Tools.ui.prompt({
      title: firstVisit
        ? Tools.i18n.t("user_name_choose")
        : Tools.i18n.format("user_name_rename", { name: user.name }),
      label: Tools.i18n.t("user_name_label"),
      value: user.name,
      maxLength: MAX_USER_NAME_LENGTH,
      saveLabel: Tools.i18n.t("user_name_save"),
      cancelLabel: Tools.i18n.t("Cancel"),
      submit: (value) => this.save(value, user.socketId),
    });
    this.dialogOpen = false;
    if (firstVisit && result === null) {
      const current = Tools.presence.users.get(
        Tools.connection.socket?.id || "",
      );
      if (current && !current.nameChosen)
        await this.save(current.name, current.socketId);
    }
  }
}
