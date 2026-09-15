// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: shared display-name validation.
export const MAX_USER_NAME_LENGTH = 64;

/** @param {unknown} value @returns {string | null} */
export function normalizeUserName(value) {
  if (typeof value !== "string" || value.length > MAX_USER_NAME_LENGTH)
    return null;
  // Reject controls, directional overrides and unpaired surrogates.
  if (
    /[\p{Cc}\p{Cs}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(
      value,
    )
  )
    return null;
  const name = value.normalize("NFC").trim();
  return name && name.length <= MAX_USER_NAME_LENGTH ? name : null;
}
