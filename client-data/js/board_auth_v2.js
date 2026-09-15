// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: local Ed25519 keys, including plain HTTP.
/** @typedef {{sign: {keyPair: {fromSeed(seed: Uint8Array): {publicKey: Uint8Array, secretKey: Uint8Array}}, detached(message: Uint8Array, key: Uint8Array): Uint8Array}, hash(message: Uint8Array): Uint8Array}} NaCl */
export const PRIVATE_KEY_STORAGE = "wbo-user-secret-v2-private";
export const PUBLIC_KEY_COOKIE = "wbo-user-secret-v2-public";
/** @type {Promise<NaCl> | undefined} */
let library;

function loadSigner() {
  if (!library)
    library = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL(
        "../vendor/tweetnacl/nacl-fast.js",
        import.meta.url,
      ).href;
      script.onload = () => {
        const nacl = /** @type {{nacl?: NaCl}} */ (
          /** @type {unknown} */ (window)
        ).nacl;
        if (nacl) resolve(nacl);
        else reject(new Error("auth_v2_failed"));
      };
      script.onerror = () => reject(new Error("auth_v2_failed"));
      document.head.appendChild(script);
    });
  return library;
}

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** @param {string} seed */
function seedBytes(seed) {
  if (!/^[0-9a-f]{64}$/i.test(seed)) throw new Error("auth_v2_failed");
  return Uint8Array.from(seed.match(/../g) || [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

function baseUrl() {
  return new URL("../", import.meta.url);
}

function readPublicKey() {
  const prefix = `${PUBLIC_KEY_COOKIE}=`;
  for (const cookie of document.cookie.split(";")) {
    const value = cookie.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return "";
}

/** @param {string} seed @param {string} publicKey */
function storeIdentity(seed, publicKey) {
  localStorage.setItem(PRIVATE_KEY_STORAGE, seed.toLowerCase());
  const base = baseUrl();
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is unavailable on plain HTTP.
  document.cookie = `${PUBLIC_KEY_COOKIE}=${publicKey}; Path=${base.pathname}; Max-Age=31536000; SameSite=Strict${base.protocol === "https:" ? "; Secure" : ""}`;
}

/**
 * Serialize key replacement across tabs. IndexedDB transactions also work on
 * plain HTTP, where Web Locks are unavailable. No keys are stored in this DB.
 * @template T
 * @param {() => T} update
 * @returns {Promise<T>}
 */
function withIdentityLock(update) {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open("wbo-auth-v2", 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore("identity-lock");
    };
    opening.onerror = () => reject(new Error("auth_v2_failed"));
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction("identity-lock", "readwrite");
      transaction.onabort = () => {
        db.close();
        reject(new Error("auth_v2_failed"));
      };
      // Run only once the read/write transaction owns the store, not while it
      // is still queued behind another tab's transaction.
      transaction.objectStore("identity-lock").get("lock").onsuccess = () => {
        try {
          const result = update();
          transaction.oncomplete = () => {
            db.close();
            resolve(result);
          };
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      };
    };
  });
}

/** @param {NaCl} nacl */
function readIdentity(nacl) {
  const seed = localStorage.getItem(PRIVATE_KEY_STORAGE);
  const storedPublicKey = readPublicKey();
  if (
    seed &&
    /^[0-9a-f]{64}$/i.test(seed) &&
    /^[0-9a-f]{64}$/i.test(storedPublicKey)
  ) {
    const pair = nacl.sign.keyPair.fromSeed(seedBytes(seed));
    const publicKey = hex(pair.publicKey);
    if (publicKey === storedPublicKey.toLowerCase()) return { pair, publicKey };
  }
  return null;
}

/** @param {NaCl} nacl */
async function ensureIdentity(nacl) {
  const existing = readIdentity(nacl);
  if (existing) return existing;
  return withIdentityLock(() => {
    // Another tab may have completed the pair while we waited for the lock.
    const current = readIdentity(nacl);
    if (current) return current;
    const randomSeed = crypto.getRandomValues(new Uint8Array(32));
    const pair = nacl.sign.keyPair.fromSeed(randomSeed);
    const publicKey = hex(pair.publicKey);
    storeIdentity(hex(randomSeed), publicKey);
    return { pair, publicKey };
  });
}

/** Keeps a valid matching pair, otherwise generates one. Returns only the public key. */
export async function createIdentity() {
  return (await ensureIdentity(await loadSigner())).publicKey;
}

/** @param {string} seed A 32-byte Ed25519 seed as 64 hexadecimal characters. */
export async function setIdentity(seed) {
  const nacl = await loadSigner();
  const pair = nacl.sign.keyPair.fromSeed(seedBytes(seed));
  const publicKey = hex(pair.publicKey);
  await withIdentityLock(() => storeIdentity(seed, publicKey));
  return publicKey;
}

/** @param {Blob} body */
export async function hashBody(body) {
  const nacl = await loadSigner();
  return hex(nacl.hash(new Uint8Array(await body.arrayBuffer())));
}

/** @param {string} board @param {string} scope @param {string} [bodyHash] */
export async function createProof(board, scope, bodyHash = "") {
  const nacl = await loadSigner();
  const { pair, publicKey } = await ensureIdentity(nacl);
  const base = baseUrl();
  const response = await fetch(new URL("auth/v2/challenge", base), {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board, scope, publicKey, bodyHash }),
  });
  if (!response.ok) throw new Error("auth_v2_failed");
  const result = await response.json();
  if (typeof result?.challenge !== "string" || result.challenge.length > 2048)
    throw new Error("auth_v2_failed");
  const fields = JSON.parse(result.challenge);
  const audience = `${base.origin}${base.pathname.replace(/\/$/, "")}`;
  if (
    !Array.isArray(fields) ||
    fields.length !== 8 ||
    fields[0] !== "wbo-auth-v2" ||
    fields[1] !== audience ||
    fields[2] !== board ||
    fields[3] !== scope ||
    fields[4] !== publicKey ||
    fields[5] !== bodyHash ||
    typeof fields[6] !== "string" ||
    !/^[0-9a-f]{64}$/.test(fields[6]) ||
    !Number.isSafeInteger(fields[7])
  )
    throw new Error("auth_v2_failed");
  // Always derive the public half from the seed, never from a server or cookie.
  const signature = nacl.sign.detached(
    new TextEncoder().encode(result.challenge),
    pair.secretKey,
  );
  return `${fields[6]}.${hex(signature)}`;
}
