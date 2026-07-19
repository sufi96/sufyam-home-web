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

// ---------- hierarchy ----------
//
// Inventory categories are two levels: "Cleaning" > "Sponge". Only inventory
// uses this; labels and record types stay flat, and a parent_id on those is
// simply ignored.
//
// Depth is capped at 2 deliberately. Expense categories go three deep and the
// drag-to-nest UI they need is the most complicated screen in this app; stock
// doesn't earn that, and a flat-ish tree keeps the picker readable.
export const MAX_DEPTH = 2;

/** Top-level entries — those with no parent, or a parent that's gone. */
export function roots(kind) {
  const ids = new Set(list(kind).map((t) => t.id));
  return list(kind).filter((t) => !t.parent_id || !ids.has(t.parent_id));
}

export function childrenOf(kind, parentId) {
  if (!parentId) return [];
  return list(kind).filter((t) => t.parent_id === parentId);
}

/** [{ entry, children: [entry] }], parents in bank order. */
export function tree(kind) {
  return roots(kind).map((entry) => ({ entry, children: childrenOf(kind, entry.id) }));
}

/** Flat list with a depth on each, for indenting a <select> or a list. */
export function flatten(kind) {
  const out = [];
  for (const { entry, children } of tree(kind)) {
    out.push({ entry, depth: 0 });
    for (const child of children) out.push({ entry: child, depth: 1 });
  }
  return out;
}

export function byId(kind, id) {
  return list(kind).find((t) => t.id === id) || null;
}

/**
 * Entries are referenced from item rows by *name*, not id — that's how the
 * column has always been stored and how the phone reads it. Names are unique
 * within a kind (create() and rename() both refuse duplicates), so this is
 * unambiguous.
 */
export function byName(kind, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return list(kind).find((t) => t.name.trim().toLowerCase() === key) || null;
}

/** An entry and everything beneath it, itself first. */
export function withDescendants(kind, entry) {
  if (!entry) return [];
  return [entry, ...childrenOf(kind, entry.id)];
}

/** ['Cleaning', 'Sponge'] for a subcategory; ['Cleaning'] for a parent. */
export function pathOf(kind, entry) {
  if (!entry) return [];
  const parent = entry.parent_id ? byId(kind, entry.parent_id) : null;
  return parent ? [parent.name, entry.name] : [entry.name];
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
export async function create(kind, {
  name, icon_key = '', color_hex = '', parent_id = '', min_threshold = 0,
}) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Name is required');
  // Unique across the whole kind, not just among siblings: item rows reference
  // categories by name, so two "Sponge"s under different parents would be
  // indistinguishable once written to an item.
  if (names(kind).some((n) => n.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`"${clean}" already exists`);
  }
  if (parent_id && byId(kind, parent_id)?.parent_id) {
    throw new Error('Categories only go two levels deep');
  }
  const order = list(kind).reduce((max, t) => Math.max(max, parseNum(t.sort_order)), 0) + 1;
  return repo.save('Taxonomy', {
    kind, name: clean, icon_key, color_hex, parent_id, min_threshold, sort_order: order,
  });
}

export async function rename(entry, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Name is required');
  if (clean.toLowerCase() !== entry.name.trim().toLowerCase()
    && names(entry.kind).some((n) => n.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`"${clean}" already exists`);
  }
  return repo.save('Taxonomy', { ...entry, name: clean });
}

/**
 * Saves an inventory category and re-points every item that referenced it.
 *
 * Items store the category *name*, not its id, so a bare rename would orphan
 * all of them at once — they'd keep pointing at a name that no longer exists
 * and quietly fall out of their category. One save for the category, one batch
 * for the items.
 *
 * Returns how many items were re-filed.
 */
export async function updateCategory(entry, patch) {
  const before = String(entry.name || '').trim();
  const after = patch.name === undefined ? before : String(patch.name).trim();
  if (!after) throw new Error('Name is required');
  if (after.toLowerCase() !== before.toLowerCase()
    && names(entry.kind).some((n) => n.toLowerCase() === after.toLowerCase())) {
    throw new Error(`"${after}" already exists`);
  }

  await repo.save('Taxonomy', { ...entry, ...patch, name: after });
  if (after === before) return 0;

  const affected = repo.rows('Inventory')
    .filter((i) => String(i.category || '').trim() === before)
    .map((i) => ({ ...i, category: after }));
  if (affected.length) await repo.saveMany('Inventory', affected);
  return affected.length;
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
