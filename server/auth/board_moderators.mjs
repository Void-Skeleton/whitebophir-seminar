/**
 * @param {{BOARD_MODERATORS?: Map<string, Set<string>>}} config
 * @param {string} boardName
 * @param {string | undefined | null} userSecret
 * @param {string | undefined} [verifiedPublicKey]
 * @returns {boolean}
 */
export function isConfiguredModerator(
  config,
  boardName,
  userSecret,
  verifiedPublicKey,
) {
  const moderators = config.BOARD_MODERATORS?.get(
    String(boardName).toLowerCase(),
  );
  return (
    moderators !== undefined &&
    ((typeof userSecret === "string" &&
      /^[0-9a-f]{32}$/.test(userSecret) &&
      moderators.has(userSecret)) ||
      (typeof verifiedPublicKey === "string" &&
        /^[0-9a-f]{64}$/.test(verifiedPublicKey) &&
        moderators.has(verifiedPublicKey)))
  );
}
