// The vault: one passphrase, one key, shared by every secure note.
//
// Its salt and a verifier live in a reserved row of the Notes tab (id
// `__vault__`), so any device with the passphrase can open the vault and no
// separate storage is needed. The verifier is a known string encrypted with
// the key — AES-GCM refuses to decrypt under the wrong key, so decrypting it
// successfully *is* the passphrase check. The passphrase itself is never
// written anywhere.
//
// "Remember on this device" persists the derived key, not the passphrase.
// Both grant the same access on this machine, but a passphrase you also use
// elsewhere never ends up sitting in browser storage.
//
// There is no recovery. Losing the passphrase means the ciphertext stays
// ciphertext — that is the point, and the UI says so before you commit to one.

import * as repo from './repo.js';
import {
  randomSalt, deriveKey, encryptText, decryptText, exportKey, importKey,
  saltOf, isEnvelope,
} from './crypto.js';

export const VAULT_ID = '__vault__';
const VERIFIER = 'sufyam-vault-v1';
const STORAGE_KEY = 'sufyam.vault.key';

let key = null;      // CryptoKey while unlocked
let salt = '';       // base64, from the vault row

// ---------- vault record ----------

function vaultRow() {
  return repo.rows('Notes', { includeDeleted: true })
    .find((n) => n.id === VAULT_ID) || null;
}

export function vaultExists() {
  return Boolean(vaultRow());
}

/**
 * Salt for this sheet's vault. Falls back to the salt inside any encrypted
 * note, so a deleted vault row can't lock you out of data you can still
 * decrypt.
 */
function vaultSalt() {
  const row = vaultRow();
  if (row?.content && isEnvelope(row.content)) return saltOf(row.content);
  const anySecure = repo.rows('Notes').find((n) => isEnvelope(n.content));
  return anySecure ? saltOf(anySecure.content) : '';
}

export function isUnlocked() {
  return key !== null;
}

// ---------- lifecycle ----------

export async function create(passphrase) {
  if (vaultExists()) throw new Error('A vault already exists for this sheet');
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Use at least 8 characters');
  }
  salt = randomSalt();
  key = await deriveKey(passphrase, salt);
  const verifier = await encryptText(key, salt, VERIFIER);

  await repo.save('Notes', {
    id: VAULT_ID,
    title: '(vault)',
    type: 'vault',
    category: '',
    content: verifier,
    labels: '',
    is_encrypted: true,
    pinned: false,
    sort_order: 0,
    color_hex: '',
  });
  return true;
}

/** Returns true when the passphrase is right, false when it isn't. */
export async function unlock(passphrase) {
  const useSalt = vaultSalt();
  if (!useSalt) throw new Error('No vault on this sheet yet');

  const candidate = await deriveKey(passphrase, useSalt);
  const row = vaultRow();

  try {
    if (row?.content && isEnvelope(row.content)) {
      await decryptText(candidate, row.content);
    } else {
      // No verifier row — fall back to proving the key against a real note.
      const anySecure = repo.rows('Notes').find((n) => isEnvelope(n.content));
      if (!anySecure) throw new Error('Nothing encrypted to check against');
      await decryptText(candidate, anySecure.content);
    }
  } catch {
    return false;
  }

  key = candidate;
  salt = useSalt;
  return true;
}

/** Forgets the key for this session but leaves it remembered on the device. */
export function lock() {
  key = null;
}

export function isRemembered() {
  return Boolean(localStorage.getItem(STORAGE_KEY));
}

export async function remember() {
  if (!key) throw new Error('Unlock first');
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    key: await exportKey(key),
    salt,
  }));
}

export function forget() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Restores a remembered key on load. Silent — never prompts. */
export async function restore() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return false;
  }
  if (!stored?.key || !stored?.salt) return false;

  // A vault rebuilt with a different passphrase leaves a stale key behind;
  // verifying here means that surfaces as "locked", not as garbled notes.
  const currentSalt = vaultSalt();
  if (currentSalt && currentSalt !== stored.salt) {
    forget();
    return false;
  }

  try {
    const restored = await importKey(stored.key);
    const row = vaultRow();
    if (row?.content && isEnvelope(row.content)) {
      await decryptText(restored, row.content);
    }
    key = restored;
    salt = stored.salt;
    return true;
  } catch {
    forget();
    return false;
  }
}

// ---------- use ----------

export async function encrypt(plaintext) {
  if (!key) throw new Error('Vault is locked');
  return encryptText(key, salt, plaintext);
}

export async function decrypt(envelope) {
  if (!key) throw new Error('Vault is locked');
  return decryptText(key, envelope);
}

/**
 * Re-encrypts every secure note under a new passphrase.
 *
 * Done as one batch so a half-changed vault can't exist: if the write fails,
 * nothing moved and the old passphrase still opens everything.
 */
export async function changePassphrase(current, next) {
  if (!(await unlock(current))) throw new Error('Current passphrase is wrong');
  if (!next || next.length < 8) throw new Error('Use at least 8 characters');

  const secure = repo.rows('Notes').filter(
    (n) => n.id !== VAULT_ID && isEnvelope(n.content),
  );
  const plain = [];
  for (const note of secure) plain.push([note, await decrypt(note.content)]);

  const newSalt = randomSalt();
  const newKey = await deriveKey(next, newSalt);

  const updates = [];
  for (const [note, text] of plain) {
    updates.push({ ...note, content: await encryptText(newKey, newSalt, text) });
  }
  updates.push({
    ...(vaultRow() || { id: VAULT_ID, title: '(vault)', type: 'vault' }),
    id: VAULT_ID,
    content: await encryptText(newKey, newSalt, VERIFIER),
    is_encrypted: true,
  });

  await repo.saveMany('Notes', updates);
  key = newKey;
  salt = newSalt;
  if (isRemembered()) await remember();
  return updates.length - 1;
}
