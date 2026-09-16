const assert = require("node:assert/strict");
const test = require("node:test");

/** @param {Record<string, string>} [initialEntries] */
function createLocalStorage(initialEntries = {}) {
  const values = new Map(Object.entries(initialEntries));
  return {
    /** @param {string} key */
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    /**
     * @param {string} key
     * @param {string} value
     */
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

/**
 * @template T
 * @param {Record<string, unknown>} windowObject
 * @param {() => T} callback
 * @returns {T}
 */
function withWindow(windowObject, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(global, "window");
  Object.defineProperty(global, "window", {
    configurable: true,
    enumerable: true,
    value: windowObject,
    writable: true,
  });
  try {
    return callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(global, "window", descriptor);
    } else {
      delete (/** @type {any} */ (global).window);
    }
  }
}

/**
 * @template T
 * @param {number} value
 * @param {() => T} callback
 * @returns {T}
 */
function withMathRandom(value, callback) {
  const original = Math.random;
  Math.random = () => value;
  try {
    return callback();
  } finally {
    Math.random = original;
  }
}

test("createInitialPreferences restores the stored color before the default", async () => {
  const { createInitialPreferences } = await import(
    "../client-data/js/board_preferences.js"
  );
  const preferences = withWindow(
    { localStorage: createLocalStorage({ "wbo.currentColor": "#123ABC" }) },
    () => withMathRandom(0.99, () => createInitialPreferences()),
  );

  assert.equal(preferences.color, "#123ABC");
});

test("createInitialPreferences defaults to canonical black when localStorage is empty", async () => {
  const { createInitialPreferences } = await import(
    "../client-data/js/board_preferences.js"
  );
  const preferences = withWindow({ localStorage: createLocalStorage() }, () =>
    withMathRandom(0.75, () => createInitialPreferences()),
  );

  assert.equal(preferences.color, "#000000");
});

test("PreferenceModule persists color changes", async () => {
  const storage = createLocalStorage();
  const { PreferenceModule } = await import(
    "../client-data/js/board_runtime_core.js"
  );

  withWindow({ localStorage: storage }, () => {
    const preferences = new PreferenceModule([], {
      tool: "hand",
      color: "#000000",
      size: 40,
      opacity: 1,
    });
    preferences.setColor("#ff4136");
  });

  assert.equal(storage.getItem("wbo.currentColor"), "#ff4136");
});

test("wheel preference defaults safely and keeps the session choice when storage fails", async () => {
  const { readStoredWheelMode } = await import(
    "../client-data/js/board_preferences.js"
  );
  const { createViewportController } = await import(
    "../client-data/js/board_viewport.js"
  );
  for (const value of ["", "invalid", "zoom", "navigate"]) {
    withWindow(
      { localStorage: createLocalStorage({ "wbo.wheelMode": value }) },
      () => {
        assert.equal(
          readStoredWheelMode(),
          value === "navigate" ? "navigate" : "zoom",
        );
      },
    );
  }
  for (const windowObject of [
    {
      get localStorage() {
        throw new Error("Access denied");
      },
    },
    {
      localStorage: {
        getItem() {
          throw new Error("Access denied");
        },
        setItem() {
          throw new Error("Quota exceeded");
        },
      },
    },
  ]) {
    withWindow(windowObject, () => {
      const viewport = createViewportController(/** @type {any} */ ({}));
      assert.equal(viewport.getWheelMode(), "zoom");
      viewport.setWheelMode("navigate");
      assert.equal(viewport.getWheelMode(), "navigate");
      viewport.setWheelMode("invalid");
      assert.equal(viewport.getWheelMode(), "navigate");
    });
  }
});
