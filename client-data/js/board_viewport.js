// Seminar modifications, 2026-09-16: personal wheel zoom/navigation controls.
import {
  readStoredWheelMode,
  saveStoredWheelMode,
} from "./board_preferences.js";
import { isTextEntryTarget } from "./text_entry_target.js";

export const DEFAULT_BOARD_SCALE = 0.1;
export const MIN_BOARD_SCALE = 0.01;
export const MAX_BOARD_SCALE = 1;
export const VIEWPORT_HASH_SCALE_DECIMALS = 3;
export const VIEWPORT_LAYOUT_EVENT = "wbo:viewport-layout";
export const VIEWPORT_SCALING_CLASS = "wbo-viewport-scaling";

const DEFAULT_MAX_BOARD_SIZE = 655360;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const WHEEL_LINE_PIXELS = 30;
const WHEEL_PAGE_PIXELS = 1000;
const WHEEL_ZOOM_SENSITIVITY = 0.01;
const WHEEL_MAX_FRAME_DELTA = 30;
const WHEEL_NAVIGATION_INTERVAL_MS = 120;
const WHEEL_GESTURE_GAP_MS = 180;
const SCALE_WILL_CHANGE_TIMEOUT_MS = 1000;
const VIEWPORT_HASH_SYNC_DELAY_MS = 200;
const FOLLOW_TRANSITION_MS = 240;
const VIEWPORT_HASH_PUSH_INTERVAL_MS = 5000;
const PINCH_MIN_DISTANCE = 16;
const BOARD_EXTENT_MARGIN = 20000;
/** Opacity change per event is `wheelDelta / this` (smaller = stronger). */
const STYLE_WHEEL_OPACITY_DIVISOR = 100;
/** Size change is `wheelDelta / this` with S + wheel. */
const STYLE_WHEEL_SIZE_FACTOR = 2;
/** Physical keys for S+wheel / O+wheel (opacity wins if both). */
const STYLE_WHEEL_KEY_MASK = Object.freeze({
  KeyS: 1,
  KeyO: 2,
});
const APP_TOOL_TOUCH_ACTION = "none";
const BROWSER_SCROLL_WITHOUT_ZOOM_TOUCH_ACTION = "pan-x pan-y";
const TOUCH_EVENT_LISTENER_OPTIONS = {
  passive: false,
  capture: true,
};
/** @type {GestureCoordinatorEventName[]} */
const TOUCH_EVENT_NAMES = [
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
];

/**
 * @typedef {{
 *   minScale?: number,
 *   maxScale?: number,
 *   defaultScale?: number,
 *   maxBoardSize?: number,
 *   viewportWidth?: number,
 *   viewportHeight?: number,
 * }} ScaleLimits
 */

/**
 * @typedef {{
 *   scrollLeft: number,
 *   scrollTop: number,
 *   scale: number,
 *   x: number,
 *   y: number,
 * }} ViewportState
 */

/**
 * @typedef {{
 *   x: number,
 *   y: number,
 *   width: number,
 *   height: number,
 * }} BoardRect
 */

/**
 * CSS-pixel rect relative to the board element. This is the coordinate space
 * used by absolutely positioned HTML overlays inside the board.
 *
 * @typedef {{
 *   left: number,
 *   top: number,
 *   width: number,
 *   height: number,
 * }} LayoutRect
 */

/**
 * @typedef {{
 *   left: number,
 *   top: number,
 *   right: number,
 *   bottom: number,
 *   width: number,
 *   height: number,
 * }} ViewportRect
 */

/** @typedef {"app-gesture" | "native-pan"} ViewportTouchPolicy */
/** @typedef {"none" | "browser" | "viewport-gesture"} TouchGestureOwner */
/** @typedef {Pick<import("../../types/app-runtime").AppToolsState, "config" | "coordinates" | "dom" | "preferences" | "toolRegistry" | "viewportState"> & Partial<Pick<import("../../types/app-runtime").AppToolsState, "chunks">>} ViewportRuntime */
/** @typedef {{startPinchPan(event: TouchEvent): void, updatePinchPan(event: TouchEvent): void, endPinchPan(): void, cancelPinchPan(): void}} GestureCoordinatorHandlers */
/** @typedef {"touchstart" | "touchmove" | "touchend" | "touchcancel"} GestureCoordinatorEventName */
/** @typedef {Record<GestureCoordinatorEventName, (event: TouchEvent) => void>} GestureCoordinatorEventHandlers */

/**
 * @typedef {{
 *   getWheelMode(): import("./board_preferences.js").WheelMode,
 *   setWheelMode(mode: unknown): void,
 *   holdFollowCamera(interrupt: () => void): {release(): void},
 *   isFollowCameraMoving(): boolean,
 *   setFollowFrame(frame: (BoardRect & {margin: number}) | null, deferUntilStrokeEnd?: boolean): void,
 *   panByKeyboard(dx: number, dy: number, width?: number, height?: number): void,
 *   getViewCenter(): {x: number, y: number},
 *   setScale(scale: number): number,
 *   getScale(): number,
 *   syncLayoutSize(): void,
 *   setTouchPolicy(policy: ViewportTouchPolicy): void,
 *   ensureBoardExtentAtLeast(width: number, height: number): boolean,
 *   ensureBoardExtentForPoint(x: number, y: number): boolean,
 *   ensureBoardExtentForBounds(bounds: {maxX: number, maxY: number} | null | undefined): boolean,
 *   boardCoordinateToLayout(value: unknown): number,
 *   pageCoordinateToBoard(value: unknown): number,
 *   boardRectToLayoutRect(rect: BoardRect): LayoutRect,
 *   boardRectToViewportRect(rect: BoardRect): ViewportRect,
 *   clientRectToLayoutRect(rect: {left?: unknown, top?: unknown, right?: unknown, bottom?: unknown, width?: unknown, height?: unknown}): LayoutRect,
 *   clientRectToBoardRect(rect: {left?: unknown, top?: unknown, right?: unknown, bottom?: unknown, width?: unknown, height?: unknown}): BoardRect,
 *   panBy(dx: number, dy: number): void,
 *   panTo(left: number, top: number): void,
 *   zoomAt(scale: number, pageX: number, pageY: number): number,
 *   zoomAtBoardPoint(scale: number, boardX: number, boardY: number): number,
 *   zoomBy(factor: number, pageX: number, pageY: number): number,
 *   beginPan(clientX: number, clientY: number): void,
 *   movePan(clientX: number, clientY: number): void,
 *   endPan(): void,
 *   install(): void,
 *   installTemporaryPan(): () => void,
 *   installHashObservers(): void,
 *   applyFromHash(): void,
 * }} ViewportController
 */

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function finiteNonNegative(value) {
  return Math.max(0, finiteOr(value, 0));
}

/**
 * @param {"innerWidth" | "innerHeight"} property
 * @returns {number}
 */
function windowDimension(property) {
  return typeof window === "undefined" ? 0 : window[property] || 0;
}

/**
 * @param {ScaleLimits} limits
 * @returns {{minScale: number, maxScale: number, defaultScale: number}}
 */
export function getScaleLimits(limits = {}) {
  const maxBoardSize = finiteOr(limits.maxBoardSize, DEFAULT_MAX_BOARD_SIZE);
  const viewportWidth = finiteOr(
    limits.viewportWidth,
    windowDimension("innerWidth"),
  );
  const viewportHeight = finiteOr(
    limits.viewportHeight,
    windowDimension("innerHeight"),
  );
  const fullScale = Math.max(viewportWidth, viewportHeight) / maxBoardSize;
  return {
    minScale: Math.max(finiteOr(limits.minScale, MIN_BOARD_SCALE), fullScale),
    maxScale: finiteOr(limits.maxScale, MAX_BOARD_SCALE),
    defaultScale: finiteOr(limits.defaultScale, DEFAULT_BOARD_SCALE),
  };
}

/**
 * @param {unknown} scale
 * @param {ScaleLimits} limits
 * @returns {number}
 */
export function clampScale(scale, limits = {}) {
  const scaleLimits = getScaleLimits(limits);
  const value = finiteOr(scale, scaleLimits.defaultScale);
  return Math.max(scaleLimits.minScale, Math.min(scaleLimits.maxScale, value));
}

/**
 * @param {unknown} value
 * @param {number} scale
 * @returns {number}
 */
export function screenToBoard(value, scale) {
  const screenCoordinate = Number(value);
  if (!Number.isFinite(screenCoordinate)) return 0;
  return screenCoordinate / scale;
}

/**
 * @param {number} boardCoordinate
 * @param {number} scale
 * @returns {number}
 */
export function boardToScroll(boardCoordinate, scale) {
  return boardCoordinate * scale;
}

/**
 * @param {unknown} svgWidth
 * @param {unknown} svgHeight
 * @param {unknown} scale
 * @param {unknown} viewportWidth
 * @param {unknown} viewportHeight
 * @returns {{width: number, height: number}}
 */
export function getScaledBoardLayoutSize(
  svgWidth,
  svgHeight,
  scale,
  viewportWidth,
  viewportHeight,
) {
  const safeScale = Math.max(0, finiteOr(scale, DEFAULT_BOARD_SCALE));
  return {
    width: Math.max(
      0,
      finiteOr(viewportWidth, 0),
      finiteOr(svgWidth, 0) * safeScale,
    ),
    height: Math.max(
      0,
      finiteOr(viewportHeight, 0),
      finiteOr(svgHeight, 0) * safeScale,
    ),
  };
}

/**
 * @param {{deltaMode?: number, deltaY?: number}} event
 * @returns {number}
 */
export function normalizeWheelDelta(event) {
  return normalizeWheelAxisDelta(event, "deltaY");
}

/**
 * @param {{deltaMode?: number, deltaX?: number, deltaY?: number}} event
 * @param {"deltaX" | "deltaY"} axis
 * @returns {number}
 */
function normalizeWheelAxisDelta(event, axis) {
  const multiplier =
    event.deltaMode === DOM_DELTA_LINE
      ? WHEEL_LINE_PIXELS
      : event.deltaMode === DOM_DELTA_PAGE
        ? WHEEL_PAGE_PIXELS
        : 1;
  return finiteOr(event[axis], 0) * multiplier;
}

/**
 * Prefer vertical wheel delta; when it is zero or smaller than horizontal (common on Mac
 * trackpads), use deltaX for S/O + wheel size and opacity adjustments.
 *
 * @param {WheelEvent} event
 * @returns {number}
 */
export function wheelDeltaForStyleWheel(event) {
  const dy = normalizeWheelAxisDelta(event, "deltaY");
  const dx = normalizeWheelAxisDelta(event, "deltaX");
  const absY = Math.abs(dy);
  const absX = Math.abs(dx);
  if (absY >= absX) return dy;
  return dx;
}

/**
 * @param {number} delta
 * @returns {number}
 */
export function wheelDeltaToScaleFactor(delta) {
  const cappedDelta = Math.max(
    -WHEEL_MAX_FRAME_DELTA,
    Math.min(WHEEL_MAX_FRAME_DELTA, delta),
  );
  return Math.exp(-cappedDelta * WHEEL_ZOOM_SENSITIVITY);
}

/**
 * @param {ViewportState} viewport
 * @param {number} nextScale
 * @returns {{left: number, top: number, scale: number}}
 */
export function zoomAt(viewport, nextScale) {
  const oldScale = viewport.scale;
  const scale = nextScale;
  return {
    left: viewport.scrollLeft + viewport.x * (scale - oldScale),
    top: viewport.scrollTop + viewport.y * (scale - oldScale),
    scale,
  };
}

/**
 * @param {{clientX: number, clientY: number}} first
 * @param {{clientX: number, clientY: number}} second
 * @returns {number}
 */
function distanceBetween(first, second) {
  const dx = first.clientX - second.clientX;
  const dy = first.clientY - second.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * @param {{clientX: number, clientY: number}} first
 * @param {{clientX: number, clientY: number}} second
 * @returns {{clientX: number, clientY: number}}
 */
function midpoint(first, second) {
  return {
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
  };
}

/**
 * @param {Event} event
 * @returns {boolean}
 */
export function safePreventDefault(event) {
  if (!event.cancelable) return false;
  event.preventDefault();
  return true;
}

class GestureCoordinator {
  /** @param {GestureCoordinatorHandlers} handlers */
  constructor(handlers) {
    this.handlers = handlers;
    /** @type {TouchGestureOwner} */
    this.owner = "none";

    /** @type {GestureCoordinatorEventHandlers} */
    this.eventHandlers = {
      touchstart: (event) => {
        if (!this.acceptCancelableTouchEvent(event)) return;
        if (event.touches.length >= 2) {
          this.claimViewportGesture(event);
          this.handlers.startPinchPan(event);
        }
      },
      touchmove: (event) => {
        if (!this.acceptCancelableTouchEvent(event)) return;
        if (this.owner === "browser") return;
        if (event.touches.length >= 2) {
          this.claimViewportGesture(event);
          this.handlers.updatePinchPan(event);
          return;
        }
        if (this.owner === "viewport-gesture") safePreventDefault(event);
      },
      touchend: (event) => {
        if (!this.acceptCancelableTouchEvent(event)) return;
        if (this.owner === "viewport-gesture") {
          safePreventDefault(event);
          if (event.touches.length === 0) {
            this.handlers.endPinchPan();
            this.reset();
          }
          return;
        }
        if (event.touches.length === 0) this.reset();
      },
      touchcancel: (event) => {
        if (!this.acceptCancelableTouchEvent(event)) return;
        if (this.owner === "viewport-gesture") {
          safePreventDefault(event);
          this.handlers.cancelPinchPan();
        }
        this.reset();
      },
    };
  }

  /** @returns {void} */
  reset() {
    this.owner = "none";
  }

  /**
   * @param {TouchEvent} event
   * @returns {boolean}
   */
  acceptCancelableTouchEvent(event) {
    if (event.cancelable) return true;
    if (this.owner === "viewport-gesture") this.handlers.cancelPinchPan();
    this.owner = "browser";
    if (event.touches.length === 0) this.reset();
    return false;
  }

  /** @param {TouchEvent} event */
  claimViewportGesture(event) {
    this.owner = "viewport-gesture";
    safePreventDefault(event);
  }
}

/**
 * @param {ViewportRuntime} Tools
 * @returns {ViewportController}
 */
export function createViewportController(Tools) {
  /** @type {number | null} */
  let scaleTimeout = null;
  /** @type {number | null} */
  let wheelAnimationFrame = null;
  let wheelDelta = 0;
  let wheelPageX = 0;
  let wheelPageY = 0;
  let wheelMode = readStoredWheelMode();
  let lastWheelDirection = 0;
  let lastWheelEventAt = -Infinity;
  let lastWheelNavigationAt = -Infinity;
  /** @type {number | null} */
  let viewportHashScrollTimeout = null;
  let lastViewportHashStateUpdate = Date.now();
  /** @type {(BoardRect & {margin: number}) | null} */
  let followFrame = null;
  let followPadding = 0;
  let applyingFollowFrame = false;
  /** @type {{left: number, top: number, scale: number} | null} */
  let followCamera = null;
  /** @type {number | null} */
  let followAnimationFrame = null;
  /** @type {{left: number, top: number} | null} */
  let chunkPanTarget = null;
  /** @type {Set<() => void>} */
  const followHolds = new Set();
  let interruptingFollowStroke = false;
  let followPending = false;
  let installed = false;
  let hashObserversInstalled = false;
  /** @type {ViewportTouchPolicy} */
  let touchPolicy = "app-gesture";
  /** @type {{x: number, y: number, scrollLeft: number, scrollTop: number} | null} */
  let activePan = null;
  /** @type {{distance: number, scale: number, boardX: number, boardY: number} | null} */
  let activePinchPan = null;
  /** @type {(() => void) | null} */
  let temporaryPanCleanup = null;
  /** Bitset: {@link STYLE_WHEEL_KEY_MASK} (O wins if both). */
  let styleWheelKeysHeld = 0;

  /**
   * @param {string} code
   * @param {boolean} held
   * @returns {void}
   */
  function setStyleWheelKeyHeld(code, held) {
    if (!(code in STYLE_WHEEL_KEY_MASK)) return;
    const mask =
      STYLE_WHEEL_KEY_MASK[
        /** @type {keyof typeof STYLE_WHEEL_KEY_MASK} */ (code)
      ];
    if (held) styleWheelKeysHeld |= mask;
    else styleWheelKeysHeld &= ~mask;
  }

  /**
   * @returns {ScaleLimits}
   */
  function currentScaleLimits() {
    return {
      maxBoardSize:
        Number(Tools.config.serverConfig.MAX_BOARD_SIZE) || undefined,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }

  /**
   * @returns {number}
   */
  function currentMaxBoardSize() {
    return (
      Number(Tools.config.serverConfig.MAX_BOARD_SIZE) || DEFAULT_MAX_BOARD_SIZE
    );
  }

  /**
   * @param {unknown} value
   * @returns {number | null}
   */
  function extentCoordinate(value) {
    const coordinate = Number(value);
    if (!Number.isFinite(coordinate)) return null;
    return Math.max(0, Math.min(currentMaxBoardSize(), Math.ceil(coordinate)));
  }

  /**
   * @param {number} left
   * @param {number} top
   * @returns {void}
   */
  function panTo(left, top) {
    if ((followFrame || followCamera) && !applyingFollowFrame) return;
    if (!applyingFollowFrame) stopFollowAnimation();
    window.scrollTo(left, top);
    scheduleViewportHashSync();
  }

  /**
   * @returns {{board: HTMLElement, svg: SVGSVGElement, drawingArea: Element} | null}
   */
  function getAttachedDom() {
    return Tools.dom?.status === "attached" ? Tools.dom : null;
  }

  /**
   * @returns {{left: number, top: number}}
   */
  function boardClientOrigin() {
    const dom = getAttachedDom();
    const rect =
      dom &&
      typeof dom.board.getBoundingClientRect === "function" &&
      dom.board.getBoundingClientRect();
    if (rect && Number.isFinite(rect.left) && Number.isFinite(rect.top)) {
      return { left: rect.left, top: rect.top };
    }
    return {
      left: -(document.documentElement.scrollLeft || 0),
      top: -(document.documentElement.scrollTop || 0),
    };
  }

  /**
   * @param {unknown} value
   * @returns {number}
   */
  function boardCoordinateToLayout(value) {
    return boardToScroll(finiteOr(value, 0), getScale());
  }

  /**
   * Converts unscaled board units to CSS pixels relative to the board element.
   *
   * @param {BoardRect} rect
   * @returns {LayoutRect}
   */
  function boardRectToLayoutRect(rect) {
    return {
      left: boardCoordinateToLayout(rect.x),
      top: boardCoordinateToLayout(rect.y),
      width: boardCoordinateToLayout(finiteNonNegative(rect.width)),
      height: boardCoordinateToLayout(finiteNonNegative(rect.height)),
    };
  }

  /**
   * Converts unscaled board units to a browser viewport client rect.
   *
   * @param {BoardRect} rect
   * @returns {ViewportRect}
   */
  function boardRectToViewportRect(rect) {
    const origin = boardClientOrigin();
    const layoutRect = boardRectToLayoutRect(rect);
    const left = origin.left + layoutRect.left;
    const top = origin.top + layoutRect.top;
    return {
      left,
      top,
      right: left + layoutRect.width,
      bottom: top + layoutRect.height,
      width: layoutRect.width,
      height: layoutRect.height,
    };
  }

  /**
   * Converts a browser viewport client rect into CSS pixels relative to the
   * board element. It removes board origin and scroll, but leaves zoom intact.
   *
   * @param {{left?: unknown, top?: unknown, right?: unknown, bottom?: unknown, width?: unknown, height?: unknown}} rect
   * @returns {LayoutRect}
   */
  function clientRectToLayoutRect(rect) {
    const origin = boardClientOrigin();
    const left = finiteOr(rect.left, 0);
    const top = finiteOr(rect.top, 0);
    const width = Number.isFinite(Number(rect.width))
      ? finiteNonNegative(rect.width)
      : Math.max(0, finiteOr(rect.right, left) - left);
    const height = Number.isFinite(Number(rect.height))
      ? finiteNonNegative(rect.height)
      : Math.max(0, finiteOr(rect.bottom, top) - top);
    return {
      left: left - origin.left,
      top: top - origin.top,
      width,
      height,
    };
  }

  /**
   * Converts a browser viewport client rect to unscaled board units.
   *
   * @param {{left?: unknown, top?: unknown, right?: unknown, bottom?: unknown, width?: unknown, height?: unknown}} rect
   * @returns {BoardRect}
   */
  function clientRectToBoardRect(rect) {
    const scale = getScale();
    const layoutRect = clientRectToLayoutRect(rect);
    return {
      x: screenToBoard(layoutRect.left, scale),
      y: screenToBoard(layoutRect.top, scale),
      width: screenToBoard(layoutRect.width, scale),
      height: screenToBoard(layoutRect.height, scale),
    };
  }

  /**
   * @returns {void}
   */
  function applyTouchPolicy() {
    const dom = getAttachedDom();
    if (!dom) return;
    // Hand mode uses document scrolling as board panning. Other tools own
    // touch input themselves, so browser panning and browser zoom stay off.
    const touchAction =
      !followFrame && !followCamera && touchPolicy === "native-pan"
        ? BROWSER_SCROLL_WITHOUT_ZOOM_TOUCH_ACTION
        : APP_TOOL_TOUCH_ACTION;
    dom.board.style.touchAction = touchAction;
    dom.svg.style.touchAction = touchAction;
  }

  /** @param {{board: HTMLElement}} dom */
  function dispatchViewportLayoutEvent(dom) {
    if (typeof dom.board.dispatchEvent !== "function") return;
    dom.board.dispatchEvent(new Event(VIEWPORT_LAYOUT_EVENT));
  }

  /**
   * @param {{board: HTMLElement}} dom
   * @param {boolean} scaling
   */
  function setViewportScalingClass(dom, scaling) {
    if (!dom.board.classList) return;
    dom.board.classList.toggle(VIEWPORT_SCALING_CLASS, scaling);
  }

  /**
   * @returns {void}
   */
  function syncLayoutSize() {
    const dom = getAttachedDom();
    if (!dom) return;
    const size = getScaledBoardLayoutSize(
      dom.svg.width.baseVal.value,
      dom.svg.height.baseVal.value,
      Tools.viewportState.scale,
      window.innerWidth,
      window.innerHeight,
    );
    dom.board.style.width = `${size.width}px`;
    dom.board.style.height = `${size.height}px`;
    dom.board.dataset.viewportManaged = "true";
    applyTouchPolicy();
    dispatchViewportLayoutEvent(dom);
  }

  /**
   * Root SVG dimensions are the canonical scroll extent. They only grow here;
   * zoom and page layout are derived from them.
   * @param {number} width
   * @param {number} height
   * @returns {boolean}
   */
  function ensureBoardExtentAtLeast(width, height) {
    const dom = getAttachedDom();
    if (!dom) return false;
    const targetWidth = extentCoordinate(width);
    const targetHeight = extentCoordinate(height);
    if (targetWidth === null || targetHeight === null) return false;
    let resized = false;
    if (targetWidth > dom.svg.width.baseVal.value) {
      dom.svg.width.baseVal.value = targetWidth;
      resized = true;
    }
    if (targetHeight > dom.svg.height.baseVal.value) {
      dom.svg.height.baseVal.value = targetHeight;
      resized = true;
    }
    if (resized) syncLayoutSize();
    return resized;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  function ensureBoardExtentForPoint(x, y) {
    return ensureBoardExtentAtLeast(
      Number(x) + BOARD_EXTENT_MARGIN,
      Number(y) + BOARD_EXTENT_MARGIN,
    );
  }

  /**
   * @param {{maxX: number, maxY: number} | null | undefined} bounds
   * @returns {boolean}
   */
  function ensureBoardExtentForBounds(bounds) {
    if (!bounds) return false;
    return ensureBoardExtentForPoint(bounds.maxX, bounds.maxY);
  }

  /**
   * @param {number} scale
   * @returns {number}
   */
  function setScale(scale) {
    if ((followFrame || followCamera) && !applyingFollowFrame)
      return getScale();
    if (!applyingFollowFrame) stopFollowAnimation();
    const scaleLimits = getScaleLimits(currentScaleLimits());
    const value = finiteOr(scale, scaleLimits.defaultScale);
    const appliedScale = applyingFollowFrame
      ? value
      : Math.max(scaleLimits.minScale, Math.min(scaleLimits.maxScale, value));
    const dom = getAttachedDom();
    if (!dom) {
      Tools.viewportState.scale = appliedScale;
      return appliedScale;
    }
    dom.svg.style.willChange = "transform";
    setViewportScalingClass(dom, true);
    dom.svg.style.transform = `scale(${appliedScale})`;
    Tools.viewportState.scale = appliedScale;
    const resized =
      appliedScale <= scaleLimits.minScale &&
      ensureBoardExtentAtLeast(currentMaxBoardSize(), currentMaxBoardSize());
    if (!resized) syncLayoutSize();
    if (scaleTimeout !== null) clearTimeout(scaleTimeout);
    scaleTimeout = window.setTimeout(() => {
      const timeoutDom = getAttachedDom();
      if (timeoutDom) {
        timeoutDom.svg.style.willChange = "auto";
        setViewportScalingClass(timeoutDom, false);
      }
    }, SCALE_WILL_CHANGE_TIMEOUT_MS);
    Tools.toolRegistry.syncDrawToolAvailability(false);
    return appliedScale;
  }

  /**
   * @returns {number}
   */
  function getScale() {
    return Tools.viewportState.scale;
  }

  /**
   * @param {number} scale
   * @param {number} boardX
   * @param {number} boardY
   * @returns {number}
   */
  function zoomAtBoardPoint(scale, boardX, boardY) {
    const oldScale = getScale();
    const x = Tools.coordinates.toBoardCoordinate(boardX);
    const y = Tools.coordinates.toBoardCoordinate(boardY);
    const scrollLeft = document.documentElement.scrollLeft;
    const scrollTop = document.documentElement.scrollTop;
    const newScale = setScale(scale);
    const nextViewport = zoomAt(
      {
        scrollLeft,
        scrollTop,
        scale: oldScale,
        x,
        y,
      },
      newScale,
    );
    panTo(nextViewport.left, nextViewport.top);
    return newScale;
  }

  /**
   * @param {number} scale
   * @param {number} pageX
   * @param {number} pageY
   * @returns {number}
   */
  function zoomAtPagePoint(scale, pageX, pageY) {
    const oldScale = getScale();
    return zoomAtBoardPoint(
      scale,
      screenToBoard(pageX, oldScale),
      screenToBoard(pageY, oldScale),
    );
  }

  /**
   * @returns {void}
   */
  function flushWheelZoom() {
    wheelAnimationFrame = null;
    const factor = wheelDeltaToScaleFactor(wheelDelta);
    wheelDelta = 0;
    zoomAtPagePoint(getScale() * factor, wheelPageX, wheelPageY);
  }

  function resetStyleWheelModifierKeys() {
    styleWheelKeysHeld = 0;
  }

  /**
   * @param {KeyboardEvent} event
   * @returns {void}
   */
  function onStyleWheelModifierKeydown(event) {
    if (isTextEntryTarget(event.target)) return;
    setStyleWheelKeyHeld(event.code, true);
  }

  /**
   * @param {KeyboardEvent} event
   * @returns {void}
   */
  function onStyleWheelModifierKeyup(event) {
    setStyleWheelKeyHeld(event.code, false);
  }

  /**
   * S/O + wheel must run on window capture so it works over the toolbar/style
   * panel (wheel on `#board` never fires there). Shift is excluded so Shift+wheel
   * pan on the board still works when a key repeats focus state oddly.
   * Letter keys are tracked from keydown/keyup: `WheelEvent` does not report which
   * letter is held (unlike Shift/Ctrl), and `getModifierState` is not for this.
   * @param {WheelEvent} event
   * @returns {void}
   */
  function handleStyleShortcutWheelCapture(event) {
    if (event.shiftKey) return;
    if (!styleWheelKeysHeld) return;
    if (!safePreventDefault(event)) return;
    const prefDelta = wheelDeltaForStyleWheel(event);
    if (styleWheelKeysHeld & STYLE_WHEEL_KEY_MASK.KeyO) {
      Tools.preferences.setOpacity(
        Tools.preferences.getOpacity() -
          prefDelta / STYLE_WHEEL_OPACITY_DIVISOR,
      );
    } else {
      Tools.preferences.setSize(
        Tools.preferences.getSize() - prefDelta / STYLE_WHEEL_SIZE_FACTOR,
      );
    }
    event.stopImmediatePropagation();
  }

  /**
   * @param {WheelEvent} event
   * @returns {void}
   */
  function handleWheel(event) {
    if (
      event.target instanceof Element &&
      event.target.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], dialog",
      )
    )
      return;
    if (!safePreventDefault(event)) return;

    if (wheelMode === "navigate" && !event.ctrlKey && !event.shiftKey) {
      if (event.altKey || event.metaKey) return;
      const direction = Math.sign(normalizeWheelDelta(event));
      if (!direction) return;
      const now = performance.now();
      const repeat =
        direction === lastWheelDirection &&
        now - lastWheelEventAt < WHEEL_GESTURE_GAP_MS;
      lastWheelDirection = direction;
      lastWheelEventAt = now;
      if (repeat && now - lastWheelNavigationAt < WHEEL_NAVIGATION_INTERVAL_MS)
        return;
      lastWheelNavigationAt = now;
      if (Tools.chunks) {
        Tools.chunks.navigateByArrow(
          direction < 0 ? "ArrowUp" : "ArrowDown",
          false,
          repeat,
          "wheel",
        );
      } else {
        controller.panByKeyboard(0, direction);
      }
      return;
    }
    lastWheelDirection = 0;
    if (event.shiftKey && !event.ctrlKey) {
      controller.panBy(
        normalizeWheelAxisDelta(event, "deltaX"),
        normalizeWheelAxisDelta(event, "deltaY"),
      );
      return;
    }
    wheelDelta += normalizeWheelDelta(event);
    wheelPageX = event.pageX;
    wheelPageY = event.pageY;
    if (wheelAnimationFrame === null) {
      wheelAnimationFrame = window.requestAnimationFrame(flushWheelZoom);
    }
  }

  /**
   * @param {TouchEvent} event
   * @returns {[Touch, Touch] | null}
   */
  function getPinchTouches(event) {
    const first = event.touches[0];
    const second = event.touches[1];
    return first && second ? [first, second] : null;
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {number} scale
   * @returns {{x: number, y: number}}
   */
  function clientPointToBoardPoint(clientX, clientY, scale) {
    return {
      x: screenToBoard(document.documentElement.scrollLeft + clientX, scale),
      y: screenToBoard(document.documentElement.scrollTop + clientY, scale),
    };
  }

  /**
   * @param {TouchEvent} event
   * @returns {void}
   */
  function startPinchPan(event) {
    if (followFrame) return;
    const touches = getPinchTouches(event);
    if (!touches) return;
    const distance = distanceBetween(touches[0], touches[1]);
    if (distance < PINCH_MIN_DISTANCE) return;
    clearViewportHashSync();
    const center = midpoint(touches[0], touches[1]);
    const scale = getScale();
    const boardPoint = clientPointToBoardPoint(
      center.clientX,
      center.clientY,
      scale,
    );
    activePinchPan = {
      distance,
      scale,
      boardX: boardPoint.x,
      boardY: boardPoint.y,
    };
  }

  /**
   * @param {TouchEvent} event
   * @returns {void}
   */
  function updatePinchPan(event) {
    if (followFrame) return;
    if (event.touches.length !== 2) return;
    const touches = getPinchTouches(event);
    if (!touches) return;
    if (!activePinchPan) startPinchPan(event);
    if (!activePinchPan) return;
    const distance = distanceBetween(touches[0], touches[1]);
    const center = midpoint(touches[0], touches[1]);
    const scale = setScale(
      activePinchPan.scale * (distance / activePinchPan.distance),
    );
    // Keep the board point that was under the initial midpoint under the
    // current midpoint, so equal-distance two-finger moves pan without zooming.
    panTo(
      activePinchPan.boardX * scale - center.clientX,
      activePinchPan.boardY * scale - center.clientY,
    );
  }

  function endPinchPan() {
    const wasPinching = !!activePinchPan;
    activePinchPan = null;
    if (wasPinching) scheduleViewportHashSync();
  }

  function cancelPinchPan() {
    activePinchPan = null;
  }

  const gestureCoordinator = new GestureCoordinator({
    startPinchPan,
    updatePinchPan,
    endPinchPan,
    cancelPinchPan,
  });

  function clearViewportHashSync() {
    if (viewportHashScrollTimeout !== null) {
      window.clearTimeout(viewportHashScrollTimeout);
      viewportHashScrollTimeout = null;
    }
  }

  /**
   * @returns {string}
   */
  function currentViewportHash() {
    const scale = getScale();
    const x = (document.documentElement.scrollLeft - followPadding) / scale;
    const y = (document.documentElement.scrollTop - followPadding) / scale;

    return `#${x | 0},${y | 0},${scale.toFixed(VIEWPORT_HASH_SCALE_DECIMALS)}`;
  }

  function updateViewportHistory() {
    viewportHashScrollTimeout = null;
    const hash = currentViewportHash();
    if (hash === window.location.hash) return;
    if (
      Date.now() - lastViewportHashStateUpdate >
      VIEWPORT_HASH_PUSH_INTERVAL_MS
    ) {
      window.history.pushState({}, "", hash);
      lastViewportHashStateUpdate = Date.now();
    } else {
      window.history.replaceState({}, "", hash);
    }
  }

  function scheduleViewportHashSync() {
    if (!hashObserversInstalled || activePan || activePinchPan) return;
    clearViewportHashSync();
    viewportHashScrollTimeout = window.setTimeout(
      updateViewportHistory,
      VIEWPORT_HASH_SYNC_DELAY_MS,
    );
  }

  function syncViewportHashFromScroll() {
    // Enforce the displayed camera, including during easing and a held stroke.
    // Snapping to the destination here would bypass the animation on each scroll.
    if (followCamera) window.scrollTo(followCamera.left, followCamera.top);
    scheduleViewportHashSync();
  }

  function stopFollowAnimation() {
    chunkPanTarget = null;
    if (followAnimationFrame === null) return;
    window.cancelAnimationFrame(followAnimationFrame);
    followAnimationFrame = null;
  }

  /** @param {{left: number, top: number, scale: number}} camera */
  function renderCamera(camera) {
    applyingFollowFrame = true;
    if (followFrame) followCamera = camera;
    if (getScale() !== camera.scale) setScale(camera.scale);
    panTo(camera.left, camera.top);
    applyingFollowFrame = false;
  }

  /**
   * Shared by activity following and manual chunk navigation. Both block Pencil
   * until the last animation frame and honor reduced-motion preferences.
   * @param {{left: number, top: number, scale: number}} start
   * @param {{left: number, top: number, scale: number}} target
   */
  function animateCamera(start, target) {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      renderCamera(target);
      chunkPanTarget = null;
      return;
    }
    const startedAt = performance.now();
    renderCamera(start);
    /** @param {number} now */
    const advance = (now) => {
      followAnimationFrame = null;
      const progress = Math.min(
        1,
        Math.max(0, (now - startedAt) / FOLLOW_TRANSITION_MS),
      );
      const eased = progress * progress * (3 - 2 * progress);
      renderCamera({
        left: start.left + (target.left - start.left) * eased,
        top: start.top + (target.top - start.top) * eased,
        scale: start.scale + (target.scale - start.scale) * eased,
      });
      if (progress < 1)
        followAnimationFrame = window.requestAnimationFrame(advance);
      else chunkPanTarget = null;
    };
    followAnimationFrame = window.requestAnimationFrame(advance);
  }

  function interruptStroke() {
    if (followHolds.size === 0) return;
    interruptingFollowStroke = true;
    try {
      for (const interrupt of [...followHolds]) interrupt();
    } finally {
      interruptingFollowStroke = false;
    }
  }

  // A uniform page inset allows negative board-space margins at the origin.
  // Own edits wait for stroke completion; other camera changes finish the stroke.
  /** @param {boolean} [interruptDrawing] */
  function applyFollowFrame(interruptDrawing = false) {
    const dom = getAttachedDom();
    if (!dom) return;
    if (interruptDrawing) interruptStroke();
    if (followHolds.size > 0) {
      followPending = true;
      return;
    }
    followPending = false;
    stopFollowAnimation();
    const oldPadding = followPadding;
    const left = document.documentElement.scrollLeft;
    const top = document.documentElement.scrollTop;
    if (!followFrame) {
      followCamera = null;
      followPadding = 0;
      dom.board.style.margin = "";
      applyTouchPolicy();
      panTo(left - oldPadding, top - oldPadding);
      return;
    }
    const wasFollowing = followCamera !== null;
    const menu = document.getElementById("menu");
    const inset =
      menu && menu.getClientRects().length
        ? menu.getBoundingClientRect().right + 8
        : 0;
    const availableWidth = Math.max(1, window.innerWidth - inset);
    const frame = followFrame;
    const scale = Math.min(
      MAX_BOARD_SCALE,
      availableWidth / (frame.width + 2 * frame.margin),
      window.innerHeight / (frame.height + 2 * frame.margin),
    );
    followPadding = Math.max(window.innerWidth, window.innerHeight);
    dom.board.style.margin = `${followPadding}px`;
    ensureBoardExtentForPoint(frame.x + frame.width, frame.y + frame.height);
    syncLayoutSize();
    const target = {
      left:
        followPadding +
        (frame.x + frame.width / 2) * scale -
        (inset + availableWidth / 2),
      top:
        followPadding +
        (frame.y + frame.height / 2) * scale -
        window.innerHeight / 2,
      scale,
    };
    if (!wasFollowing) {
      renderCamera(target);
      return;
    }
    const start = {
      left: left + followPadding - oldPadding,
      top: top + followPadding - oldPadding,
      scale: getScale(),
    };
    animateCamera(start, target);
  }

  /** @type {ViewportController} */
  const controller = {
    getWheelMode() {
      return wheelMode;
    },
    setWheelMode(mode) {
      if (mode !== "zoom" && mode !== "navigate") return;
      wheelMode = mode;
      lastWheelDirection = 0;
      if (wheelAnimationFrame !== null) {
        window.cancelAnimationFrame(wheelAnimationFrame);
        wheelAnimationFrame = null;
        wheelDelta = 0;
      }
      Tools.chunks?.clearNavigationNotice();
      saveStoredWheelMode(mode);
    },
    getViewCenter() {
      const menu = document.getElementById("menu");
      const inset =
        menu && menu.getClientRects().length
          ? menu.getBoundingClientRect().right + 8
          : 0;
      const center = clientRectToBoardRect({
        left: (inset + window.innerWidth) / 2,
        top: window.innerHeight / 2,
        width: 0,
        height: 0,
      });
      return {
        x: Tools.coordinates.toBoardCoordinate(center.x),
        y: Tools.coordinates.toBoardCoordinate(center.y),
      };
    },
    panByKeyboard(dx, dy, width, height) {
      if (followFrame || followCamera || !getAttachedDom()) return;
      const scale = getScale();
      const stepX = width === undefined ? 64 : width * scale;
      const stepY = height === undefined ? 64 : height * scale;
      const start = {
        left: document.documentElement.scrollLeft,
        top: document.documentElement.scrollTop,
        scale,
      };
      // Key repeats advance from the destination, never a partial frame.
      const previous = chunkPanTarget || start;
      const target = {
        left: Math.max(
          0,
          Math.min(
            Math.max(0, currentMaxBoardSize() * scale - window.innerWidth),
            previous.left + dx * stepX,
          ),
        ),
        top: Math.max(
          0,
          Math.min(
            Math.max(0, currentMaxBoardSize() * scale - window.innerHeight),
            previous.top + dy * stepY,
          ),
        ),
        scale,
      };
      if (target.left === previous.left && target.top === previous.top) return;
      interruptStroke();
      stopFollowAnimation();
      activePan = null;
      activePinchPan = null;
      ensureBoardExtentForPoint(
        (target.left + window.innerWidth) / scale,
        (target.top + window.innerHeight) / scale,
      );
      chunkPanTarget = target;
      animateCamera(start, target);
    },
    holdFollowCamera(interrupt) {
      followHolds.add(interrupt);
      if (followAnimationFrame !== null) {
        stopFollowAnimation();
        followPending = true;
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          followHolds.delete(interrupt);
          if (
            followHolds.size === 0 &&
            followPending &&
            !interruptingFollowStroke
          )
            applyFollowFrame();
        },
      };
    },
    isFollowCameraMoving() {
      return followAnimationFrame !== null || applyingFollowFrame;
    },
    setFollowFrame(frame, deferUntilStrokeEnd = false) {
      const current = followFrame;
      const unchanged =
        frame === current ||
        (!!frame &&
          !!current &&
          frame.x === current.x &&
          frame.y === current.y &&
          frame.width === current.width &&
          frame.height === current.height &&
          frame.margin === current.margin);
      if (unchanged && !followPending) return;
      followFrame = frame;
      activePan = null;
      activePinchPan = null;
      applyFollowFrame(!deferUntilStrokeEnd);
    },
    setScale,
    getScale,
    syncLayoutSize,
    setTouchPolicy(policy) {
      touchPolicy = policy === "native-pan" ? "native-pan" : "app-gesture";
      applyTouchPolicy();
    },
    ensureBoardExtentAtLeast,
    ensureBoardExtentForPoint,
    ensureBoardExtentForBounds,
    boardCoordinateToLayout,
    pageCoordinateToBoard(value) {
      return Tools.coordinates.toBoardCoordinate(
        screenToBoard(Number(value) - followPadding, getScale()),
      );
    },
    boardRectToLayoutRect,
    boardRectToViewportRect,
    clientRectToLayoutRect,
    clientRectToBoardRect,
    panBy(dx, dy) {
      panTo(
        document.documentElement.scrollLeft + dx,
        document.documentElement.scrollTop + dy,
      );
    },
    panTo,
    zoomAt: zoomAtPagePoint,
    zoomAtBoardPoint,
    zoomBy(factor, pageX, pageY) {
      return zoomAtPagePoint(getScale() * factor, pageX, pageY);
    },
    beginPan(clientX, clientY) {
      if (followFrame) return;
      clearViewportHashSync();
      activePan = {
        x: clientX,
        y: clientY,
        scrollLeft: document.documentElement.scrollLeft,
        scrollTop: document.documentElement.scrollTop,
      };
    },
    movePan(clientX, clientY) {
      if (!activePan) return;
      panTo(
        activePan.scrollLeft + activePan.x - clientX,
        activePan.scrollTop + activePan.y - clientY,
      );
    },
    endPan() {
      const wasPanning = !!activePan;
      activePan = null;
      if (wasPanning) scheduleViewportHashSync();
    },
    install() {
      const dom = getAttachedDom();
      if (installed || !dom) return;
      installed = true;
      window.addEventListener("resize", () => {
        syncLayoutSize();
        if (followFrame || followCamera) applyFollowFrame(true);
      });
      window.addEventListener("keydown", onStyleWheelModifierKeydown, true);
      window.addEventListener("keyup", onStyleWheelModifierKeyup, true);
      window.addEventListener("blur", resetStyleWheelModifierKeys);
      window.addEventListener("wheel", handleStyleShortcutWheelCapture, {
        passive: false,
        capture: true,
      });
      dom.board.addEventListener("wheel", handleWheel, {
        passive: false,
        capture: true,
      });
      for (const name of TOUCH_EVENT_NAMES) {
        dom.board.addEventListener(
          name,
          gestureCoordinator.eventHandlers[name],
          TOUCH_EVENT_LISTENER_OPTIONS,
        );
      }
    },
    installTemporaryPan() {
      const dom = getAttachedDom();
      if (!dom || temporaryPanCleanup) return temporaryPanCleanup || (() => {});

      /** @param {MouseEvent} event */
      function handleMouseDown(event) {
        if (event.button !== 0) return;
        if (!safePreventDefault(event)) return;
        controller.beginPan(event.clientX, event.clientY);
      }

      /** @param {MouseEvent} event */
      function handleMouseMove(event) {
        controller.movePan(event.clientX, event.clientY);
      }

      function handleMouseUp() {
        controller.endPan();
      }

      dom.board.addEventListener("mousedown", handleMouseDown);
      dom.board.addEventListener("mousemove", handleMouseMove);
      dom.board.addEventListener("mouseup", handleMouseUp);
      dom.board.addEventListener("mouseleave", handleMouseUp);
      temporaryPanCleanup = () => {
        dom.board.removeEventListener("mousedown", handleMouseDown);
        dom.board.removeEventListener("mousemove", handleMouseMove);
        dom.board.removeEventListener("mouseup", handleMouseUp);
        dom.board.removeEventListener("mouseleave", handleMouseUp);
        controller.endPan();
        temporaryPanCleanup = null;
      };
      return temporaryPanCleanup;
    },
    installHashObservers() {
      if (hashObserversInstalled) return;
      hashObserversInstalled = true;
      window.addEventListener("scroll", syncViewportHashFromScroll);
      window.addEventListener("hashchange", controller.applyFromHash, false);
      window.addEventListener("popstate", controller.applyFromHash, false);
    },
    applyFromHash() {
      if (followFrame || followCamera) {
        if (followCamera) window.scrollTo(followCamera.left, followCamera.top);
        return;
      }
      const coords = window.location.hash.slice(1).split(",");
      const x = Tools.coordinates.toBoardCoordinate(coords[0]);
      const y = Tools.coordinates.toBoardCoordinate(coords[1]);
      const scale = Number.parseFloat(coords[2] || "");
      ensureBoardExtentForPoint(x, y);
      const appliedScale = setScale(scale);
      panTo(boardToScroll(x, appliedScale), boardToScroll(y, appliedScale));
    },
  };

  return controller;
}
