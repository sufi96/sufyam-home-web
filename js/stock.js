// Deciding what counts as "running low".
//
// Kept apart from any view because two places ask the question — the dashboard
// panel and the inventory list — and an answer that differs between them is
// worse than either answer being wrong.
//
// Three things complicate the plain `current_stock <= min_threshold`:
//
//   stock_group  Some things are only wanted in a quantity, not a brand: two
//                toothbrushes in the house, whichever two. Items sharing a
//                group pool their stock and are judged together, so one spare
//                Colgate and one spare Oral-B satisfy "keep at least 2".
//   no_restock   Use it up and don't buy more. Stays in the list — you still
//                want to know it's there — but never nags.
//   is_refill    Purely descriptive. It changes what you buy, not when.

import { parseBool, parseNum } from './schema.js';

/** Case- and space-insensitive, so "Razor" and "razor " are one group. */
export function groupKeyOf(item) {
  return String(item?.stock_group || '').trim().toLowerCase();
}

/**
 * Buckets items by stock group.
 *
 * Returns a Map of key -> { key, name, items, stock, threshold, active }.
 * `name` keeps the first spelling seen, for display. `active` is false when
 * every member is marked no_restock — a group that is being wound down.
 *
 * Ungrouped items get no entry; they're judged on their own row.
 */
export function buildGroups(items) {
  const groups = new Map();

  for (const item of items) {
    const key = groupKeyOf(item);
    if (!key) continue;

    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        name: String(item.stock_group).trim(),
        items: [],
        stock: 0,
        threshold: 0,
        active: false,
      };
      groups.set(key, g);
    }

    g.items.push(item);
    // Stock pools regardless of the flags: a bottle you're using up is still a
    // bottle in the house, and pretending otherwise would send you shopping
    // for something you already have.
    g.stock += parseNum(item.current_stock);

    if (!parseBool(item.no_restock)) {
      g.active = true;
      // The highest threshold in the group wins. Setting "at least 2" on any
      // one member is enough to mean it for the group, which is how someone
      // filling this in would expect it to behave — and forgetting to repeat
      // the number on a new variant then can't quietly lower the bar.
      g.threshold = Math.max(g.threshold, parseNum(item.min_threshold));
    }
  }

  return groups;
}

/**
 * How one item is doing.
 *
 * `level` is one of:
 *   'out'      nothing left, and it's wanted
 *   'low'      at or under the threshold
 *   'ok'       fine, or no threshold set
 *   'winding'  no_restock — reported, never warned about
 *
 * `stock` / `threshold` are the numbers the decision was made on, which for a
 * grouped item are the group's totals rather than the row's own.
 */
export function stockStatus(item, groups) {
  const key = groupKeyOf(item);
  const group = key ? groups?.get(key) : null;

  const stock = group ? group.stock : parseNum(item.current_stock);
  const threshold = group ? group.threshold : parseNum(item.min_threshold);
  const base = { stock, threshold, group: group || null, grouped: Boolean(group) };

  // An individually retired item inside a still-wanted group isn't "winding
  // down" in any useful sense — the group still needs stocking, so it reports
  // the group's state like its siblings do.
  if (parseBool(item.no_restock) && !(group && group.active)) {
    return { ...base, level: 'winding' };
  }
  if (threshold <= 0) return { ...base, level: 'ok' };
  if (stock <= 0) return { ...base, level: 'out' };
  // Strictly below, because the number means "keep at least this many".
  // Holding exactly two toothbrushes satisfies "at least 2" — warning then
  // would nag at the moment you're fine, and you'd learn to ignore it.
  // InventoryItem.isLowStock in the Flutter app matches this.
  if (stock < threshold) return { ...base, level: 'low' };
  return { ...base, level: 'ok' };
}

/**
 * Everything that needs buying, one entry per thing to buy.
 *
 * A group collapses to a single entry — three low toothbrush variants are one
 * line on the shopping list, not three — while ungrouped items appear as
 * themselves.
 *
 * Entries: { key, name, detail, stock, threshold, level, items }
 */
export function shortages(items) {
  const groups = buildGroups(items);
  const out = [];
  const seenGroups = new Set();

  for (const item of items) {
    const status = stockStatus(item, groups);
    if (status.level !== 'low' && status.level !== 'out') continue;

    if (status.grouped) {
      if (seenGroups.has(status.group.key)) continue;
      seenGroups.add(status.group.key);
      out.push({
        key: status.group.key,
        name: status.group.name,
        detail: `${status.group.items.length} variant${status.group.items.length === 1 ? '' : 's'}`,
        stock: status.stock,
        threshold: status.threshold,
        level: status.level,
        items: status.group.items,
      });
    } else {
      out.push({
        key: item.id,
        name: item.item_name || '(unnamed)',
        detail: [item.brand, item.variant_size].filter(Boolean).join(' · '),
        stock: status.stock,
        threshold: status.threshold,
        level: status.level,
        items: [item],
      });
    }
  }

  // Emptiest first — what to pick up on the way home.
  out.sort((a, b) => {
    const gap = (a.stock - a.threshold) - (b.stock - b.threshold);
    return gap !== 0 ? gap : a.name.localeCompare(b.name);
  });
  return out;
}

/** Distinct non-empty values of a column across items, for the datalists. */
export function suggestionsFor(items, key) {
  const seen = new Map();
  for (const item of items) {
    const v = String(item[key] || '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (!seen.has(k)) seen.set(k, v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
