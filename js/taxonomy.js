// The Taxonomy tab is the app's data bank of user-managed lookup lists:
// expense labels, inventory categories and record types, distinguished by the
// `kind` column. Values match Dart's TaxonomyKind enum names exactly
// (lib/core/models/enums.dart) — the phone parses them by name.

import * as repo from './repo.js';
import { parseNum } from './schema.js';

export const KIND_LABEL = 'label';
export const KIND_INVENTORY_CATEGORY = 'inventoryCategory';
export const KIND_RECORD_TYPE = 'recordType';

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
