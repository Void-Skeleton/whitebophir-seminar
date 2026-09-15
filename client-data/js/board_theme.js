// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: reversible, hue-preserving board themes.
/** @typedef {"light" | "dark"} BoardTheme */
export const DARK_BACKGROUND = "#202020";

/** @param {unknown} value @returns {value is BoardTheme} */
export function isBoardTheme(value) {
  return value === "light" || value === "dark";
}

/**
 * Invert HSL lightness without rotating hue, then fit into the dark canvas's
 * usable range. Stored colors always remain in the original light palette.
 * @param {string} color
 * @param {BoardTheme} theme
 * @param {boolean} [inverse]
 */
export function themeColor(color, theme, inverse = false) {
  if (theme !== "dark" || !/^#[0-9a-f]{6}$/i.test(color)) return color;
  const rgb = [1, 3, 5].map((offset) =>
    parseInt(color.slice(offset, offset + 2), 16),
  );
  if (inverse) {
    for (let i = 0; i < 3; i++)
      rgb[i] = Math.max(0, (((rgb[i] || 0) - 32) * 255) / 223);
  }
  const sum = Math.max(...rgb) + Math.min(...rgb);
  return (
    "#" +
    rgb
      .map((value) => {
        const flipped = 255 + value - sum;
        const mapped = inverse ? flipped : 32 + (flipped * 223) / 255;
        return Math.round(mapped).toString(16).padStart(2, "0");
      })
      .join("")
  );
}

// Equivalent per-pixel transform: 32/255 + 223/255 * (1 + rgb - min - max).
// All arithmetic intermediates stay nonnegative. Restore SourceAlpha last so
// antialiasing and overlapping translucent strokes retain their opacity.
export const THEME_SVG_RESOURCES = `<defs id="wbo-theme-defs">
<filter id="wbo-dark-colors" filterUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
<feColorMatrix in="SourceGraphic" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1" result="rgb"/>
<feColorMatrix in="rgb" values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1" result="r"/>
<feColorMatrix in="rgb" values="0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 1" result="g"/>
<feColorMatrix in="rgb" values="0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 1" result="b"/>
<feBlend in="r" in2="g" mode="darken" result="minRG"/>
<feBlend in="minRG" in2="b" mode="darken" result="minRGB"/>
<feBlend in="r" in2="g" mode="lighten" result="maxRG"/>
<feBlend in="maxRG" in2="b" mode="lighten" result="maxRGB"/>
<feBlend in="rgb" in2="minRGB" mode="difference" result="chroma"/>
<feColorMatrix in="maxRGB" values="-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 0 1" result="complement"/>
<feComposite in="chroma" in2="complement" operator="arithmetic" k2="1" k3="1"/>
<feColorMatrix values="0.874509804 0 0 0 0.125490196 0 0.874509804 0 0 0.125490196 0 0 0.874509804 0 0.125490196 0 0 0 1 0"/>
<feComposite in2="SourceAlpha" operator="in"/>
</filter></defs>
<style id="wbo-theme-style">
svg[data-wbo-theme="dark"] { background: #202020; }
svg[data-wbo-theme="dark"] > #drawingArea, svg[data-wbo-theme="dark"] > #cursors { filter: url(#wbo-dark-colors); }
svg[data-wbo-theme="dark"] #activityChunkGrid path, svg[data-wbo-theme="dark"] #grid path, svg[data-wbo-theme="dark"] #smallGrid path { stroke: #ffffff; }
svg[data-wbo-theme="dark"] #dots circle { fill: #ffffff; }
</style>`;
