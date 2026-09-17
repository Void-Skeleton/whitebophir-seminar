import { getMutationType, MutationType } from "./message_tool_metadata.js";

/**
 * @param {unknown} message
 * @returns {{reset: boolean, invalidatedIds: string[]}}
 */
export function optimisticPrunePlanForAuthoritativeMessage(message) {
  if (!message || typeof message !== "object") {
    return { reset: false, invalidatedIds: [] };
  }
  const normalizedMessage = /** @type {{type?: unknown, id?: unknown}} */ (
    message
  );
  const mutationType = getMutationType(normalizedMessage);
  if (
    mutationType === MutationType.RESTORE &&
    "items" in message &&
    Array.isArray(message.items)
  ) {
    return {
      reset: false,
      invalidatedIds: message.items.map((entry) => entry.id),
    };
  }
  if (mutationType === MutationType.CLEAR) {
    return { reset: true, invalidatedIds: [] };
  }
  if (
    mutationType === MutationType.DELETE &&
    typeof normalizedMessage.id === "string"
  ) {
    return { reset: false, invalidatedIds: [normalizedMessage.id] };
  }
  return { reset: false, invalidatedIds: [] };
}
