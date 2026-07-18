// The Taxonomy tab is the app's data bank of user-managed lookup lists:
// expense labels, inventory categories and record types, distinguished by the
// `kind` column. Values match Dart's TaxonomyKind enum names exactly
// (lib/core/models/enums.dart) — the phone parses them by name.

import * as repo from './repo.js';
import { parseNum } from './schema.js';

export const KIND_LABEL = 'label';
export const KIND_INVENTORY_CATEGORY = 'inventoryCategory';
export const KIND_RECORD_TYPE = 'recordType';
// Must exist in Dart's TaxonomyKind too — Taxonomy.fromMap falls back to
// inventoryCategory for unknown kinds, so a kind the phone doesn't know would
// surface in its inventory category list rather than being ignored.
export const KIND_NOTE_CATEGORY = 'noteCategory';

/** Live entries of one kind, in the order the phone shows them. */
export function list(kind) {
  return repo.rows('Taxonomy')
    .filter((t) => (t.kind || '') === kind)
    .sort((a, b) => {
      const d = parseNum(a.sort_order) - parseNum(b.sort_order);
      return d !== 0 ? d : (a.name || '').localeCompare(b.name || '');
    });
}

export function names(kind) {
  return list(kind).map((t) => t.name).filter(Boolean);
}

function existingNameSet(kind) {
  return new Set(names(kind).map((n) => n.toLowerCase()));
}

/**
 * Adds any of [wanted] that aren't in the bank yet. Case-insensitive, so
 * "Weekly" won't be banked twice as "weekly".
 *
 * Returns the names actually created.
 */
export async function ensure(kind, wanted) {
  const have = existingNameSet(kind);
  const missing = [];
  const seen = new Set();

  for (const raw of wanted) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (have.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(name);
  }
  if (!missing.length) return [];

  let order = list(kind).reduce((max, t) => Math.max(max, parseNum(t.sort_order)), 0);
  await repo.saveMany('Taxonomy', missing.map((name) => ({
    kind,
    name,
    icon_key: '',
    color_hex: '',
    sort_order: ++order,
  })));
  return missing;
}

/**
 * Labels that appear on transactions but were never added to the bank —
 * typically typed by hand before the picker existed.
 */
export function unbankedLabels() {
  const have = existingNameSet(KIND_LABEL);
  const found = new Map(); // lowercase -> original casing

  for (const txn of repo.rows('Transactions')) {
    for (const raw of String(txn.labels || '').split('|')) {
      const name = raw.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (have.has(key) || found.has(key)) continue;
      found.set(key, name);
    }
  }
  return [...found.values()].sort((a, b) => a.localeCompare(b));
}

/** How many transactions carry each label, for ordering the picker. */
export function labelUsage() {
  const counts = new Map();
  for (const txn of repo.rows('Transactions')) {
    for (const raw of String(txn.labels || '').split('|')) {
      const name = raw.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}


// ---------- CRUD, for the kinds the web console manages directly ----------

/** Adds one entry and returns it. */
export async function create(kind, { name, icon_key = '', color_hex = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Name is required');
  if (names(kind).some((n) => n.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`"${clean}" already exists`);
  }
  const order = list(kind).reduce((max, t) => Math.max(max, parseNum(t.sort_order)), 0) + 1;
  return repo.save('Taxonomy', { kind, name: clean, icon_key, color_hex, sort_order: order });
}

export async function rename(entry, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Name is required');
  return repo.save('Taxonomy', { ...entry, name: clean });
}

export async function update(entry, patch) {
  return repo.save('Taxonomy', { ...entry, ...patch });
}

/** Soft-deletes an entry. Rows referencing it by name keep that text. */
export async function remove(entry) {
  return repo.remove('Taxonomy', entry.id);
}

/** Rewrites sort_order to match `orderedIds`, saving only what moved. */
export async function reorder(kind, orderedIds) {
  const current = list(kind);
  const byId = new Map(current.map((t) => [t.id, t]));
  const updates = [];
  orderedIds.forEach((id, i) => {
    const entry = byId.get(id);
    if (entry && parseNum(entry.sort_order) !== i + 1) {
      updates.push({ ...entry, sort_order: i + 1 });
    }
  });
  if (updates.length) await repo.saveMany('Taxonomy', updates);
  return updates.length;
}

/** How many notes sit in each note category, keyed by lowercase name. */
export function noteCategoryUsage() {
  const counts = new Map();
  for (const note of repo.rows('Notes')) {
    const key = String(note.category || '').trim().toLowerCase();
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
