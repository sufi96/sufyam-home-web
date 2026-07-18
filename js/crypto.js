// Envelope encryption for secure notes, on WebCrypto only — no libraries.
//
//   passphrase --PBKDF2-SHA256(210k)--> 256-bit key --AES-GCM--> ciphertext
//
// Stored form, one self-contained string per encrypted value:
//
//   v1.<salt b64>.<iv b64>.<ciphertext+tag b64>
//
// The salt travels in the envelope even though every note in a vault shares
// one, so a single cell is enough to decrypt given the passphrase — nothing
// depends on other rows surviving.
//
// There is deliberately no derived-key cache here. An earlier version cached
// by salt, which meant that once any key for a salt existed, deriving with a
// *different* passphrase returned the cached key — and since unlocking works
// by decrypting a verifier, every passphrase would have been accepted while a
// session was already open. Derivation only happens on unlock, vault creation
// and passphrase change, so there is nothing worth caching anyway: the open
// vault already holds its key.
//
// Design notes:
//   - AES-GCM is authenticated: a wrong key fails to decrypt rather than
//     returning junk, which is what makes it usable as a passphrase check.
//   - The IV is random per encryption and never reused, which GCM requires.
//   - 210,000 iterations follows the OWASP 2023 guidance for PBKDF2-HMAC-
//     SHA256. It costs a few hundred milliseconds once, on unlock.

const VERSION = 'v1';
const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomSalt() {
  return toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/**
 * Derives the AES key for a passphrase + salt.
 *
 * Extractable on purpose: "remember on this device" persists the derived key
 * rather than the passphrase, so a passphrase reused elsewhere never sits in
 * browser storage.
 */
export async function deriveKey(passphrase, saltB64) {
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromBase64(saltB64),
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key) {
  return toBase64(await crypto.subtle.exportKey('raw', key));
}

export async function importKey(rawB64) {
  return crypto.subtle.importKey(
    'raw', fromBase64(rawB64), { name: 'AES-GCM', length: 256 }, true,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptText(key, saltB64, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(plaintext ?? ''),
  );
  return [VERSION, saltB64, toBase64(iv), toBase64(cipher)].join('.');
}

/** Throws if the key is wrong or the payload was tampered with. */
export async function decryptText(key, envelope) {
  const parsed = parseEnvelope(envelope);
  if (!parsed) throw new Error('Not an encrypted value');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: parsed.iv }, key, parsed.cipher,
  );
  return dec.decode(plain);
}

export function parseEnvelope(value) {
  const text = String(value || '');
  const parts = text.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    return {
      version: parts[0],
      salt: parts[1],
      iv: fromBase64(parts[2]),
      cipher: fromBase64(parts[3]),
    };
  } catch {
    return null;
  }
}

export function isEnvelope(value) {
  return parseEnvelope(value) !== null;
}

/** Salt of an envelope, so a vault can be opened from any single note. */
export function saltOf(value) {
  return parseEnvelope(value)?.salt || '';
}
