import { canonicalizeBoardName } from "./board_name.js";
import { normalizeRecentBoards } from "./board_page_state.js";
import { normalizeUserName } from "./user_name.js";

function readEntryName() {
  const input = document.getElementById("user-name");
  if (!(input instanceof HTMLInputElement)) return "";
  const name = normalizeUserName(input.value);
  const invalid = input.value.trim() !== "" && name === null;
  input.setCustomValidity(invalid ? input.dataset.invalidMessage || "" : "");
  if (invalid) {
    input.reportValidity();
    return null;
  }
  input.value = name || "";
  return name || "";
}

function setupNamedBoardForm() {
  const form = document.getElementById("named-board-form");
  const input = document.getElementById("board");
  if (!(form instanceof HTMLFormElement)) return;
  if (!(input instanceof HTMLInputElement)) return;

  form.addEventListener("submit", (event) => {
    if (readEntryName() === null) {
      event.preventDefault();
      return;
    }
    input.value = canonicalizeBoardName(input.value);
    if (input.value !== "") return;

    event.preventDefault();
    input.reportValidity();
  });
}

function showRecentBoards() {
  const parent = document.getElementById("recent-boards");
  if (!parent) return;
  const ul = document.querySelector("#recent-boards ul");
  ul && parent.removeChild(ul);
  parent.classList.add("hidden");

  const storedBoardsText = localStorage.getItem("recent-boards");
  const recentBoards = normalizeRecentBoards(
    storedBoardsText ? JSON.parse(storedBoardsText) : [],
  );
  if (recentBoards.length === 0) return;

  const list = document.createElement("ul");

  recentBoards.forEach(
    /** @param {string} name */
    (name) => {
      const listItem = document.createElement("li");
      const link = document.createElement("a");
      link.setAttribute("href", `boards/${encodeURIComponent(name)}`);
      link.textContent = name;
      listItem.appendChild(link);
      list.appendChild(listItem);
    },
  );

  parent.appendChild(list);
  parent.classList.remove("hidden");
}

setupNamedBoardForm();
document.getElementById("user-name")?.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement)
    event.target.setCustomValidity("");
});
document.getElementById("actions")?.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest("a");
  if (!link) return;
  const url = new URL(link.href);
  const base = new URL(document.baseURI);
  if (
    url.origin !== base.origin ||
    !(
      url.pathname.startsWith(`${base.pathname}boards/`) ||
      url.pathname === `${base.pathname}random`
    )
  )
    return;
  const name = readEntryName();
  if (name === null) {
    event.preventDefault();
    return;
  }
  if (name) url.searchParams.set("name", name);
  else url.searchParams.delete("name");
  link.href = url.href;
});
window.addEventListener("pageshow", showRecentBoards);
