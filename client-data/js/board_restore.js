// SPDX-License-Identifier: AGPL-3.0-or-later
import { TOOL_CODE_BY_ID } from "../tools/tool-order.js";

/** Render a server-authorized replacement through the ordinary tool renderers.
 * @param {import("./board_message_module.js").MessageModule} messages
 * @param {import("../../types/app-runtime").RestoreMessage} message
 */
export async function drawRestoredItems(messages, message) {
  for (const entry of message.items) {
    await messages.messageForTool({ tool: 6, type: 3, id: entry.id });
  }
  for (const { item } of message.items) {
    if (!item) continue;
    const tool =
      TOOL_CODE_BY_ID[/** @type {keyof typeof TOOL_CODE_BY_ID} */ (item.tool)];
    await messages.messageForTool(
      /** @type {import("../../types/app-runtime").BoardMessage} */ (
        /** @type {unknown} */ ({
          ...item,
          tool,
          type: 1,
          _children: undefined,
          transform: undefined,
        })
      ),
    );
    if (tool === 1) {
      for (const point of item._children || [])
        await messages.messageForTool({
          tool,
          type: 4,
          parent: item.id,
          x: point.x,
          y: point.y,
        });
    } else if (tool === 5) {
      await messages.messageForTool({
        tool,
        type: 2,
        id: item.id,
        txt: item.txt,
      });
    }
    if (item.transform)
      await messages.messageForTool({
        tool: 7,
        type: 2,
        id: item.id,
        transform: item.transform,
      });
  }
  // Insert back-to-front, including adjacent objects restored by the same undo.
  for (const entry of message.items.slice().sort((a, b) => b.order - a.order)) {
    if (!entry.item) continue;
    const element = document.getElementById(entry.id);
    const next = entry.beforeId
      ? document.getElementById(entry.beforeId)
      : null;
    if (element && next && element.parentNode === next.parentNode)
      next.before(element);
  }
}
