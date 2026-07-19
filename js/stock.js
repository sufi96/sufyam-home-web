// Deciding what counts as "running low".
//
// Kept apart from any view because two places ask the question — the dashboard
// panel and the inventory list — and an answer that differs between them is
// worse than either answer being wrong.
//
// The rule that isn't obvious: a category can carry the stock requirement for
// everything inside it. Some things are wanted in a quantity rather than a
// brand — two toothbrushes in the house, whichever two — so "Toiletries >
// Toothbrush" with "keep at least 2" counts every toothbrush together, and one
// spare Colgate plus one spare Oral-B satisfies it. Items in a category that
// sets no number are judged on their own row instead.
//
// (This replaced a separate stock_group column on each item. Same behaviour,
// one fewer thing to fill in: the subcategory already said what the item was.)
//
// Two flags round it out:
//   no_restock   Use it up and don't buy more. Stays in the list — you still
//                want to know it's there — but never nags.
//   is_refill    Purely descriptive. It changes what you buy, not when.

import { parseBool, parseNum } from './schema.js';

const norm = (v) => String(v || '').trim().toLowerCase();

/**
 * Works out which category governs each item's stock level.
 *
 * `categories` is the inventory-category taxonomy: rows with id, name,
 * parent_id and min_threshold. Passed in rather than imported so this module
 * stays pure and testable.
 *
 * Returns a Map of category id -> { id, name, items, stock, threshold, active },
 * holding only the categories that actually set a threshold — those are the
 * ones that pool. A category with no number governs nothing and its items fall
 * back to their own.
 */
export function buildGroups(items, categories = []) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const byName = new Map(categories.map((c) => [norm(c.name), c]));

  // The nearest category at or above `cat` that sets a number. A parent can
  // cover all its subcategories ("keep 3 cleaning things") without each one
  // repeating it, and a subcategory that sets its own overrides the parent for
  // its items.
  const governorOf = (cat) => {
    let node = cat;
    let guard = 0;
    while (node && guard++ < 8) {
      if (parseNum(node.min_threshold) > 0) return node;
      node = node.parent_id ? byId.get(node.parent_id) : null;
    }
    return null;
  };

  const groups = new Map();

  for (const item of items) {
    const cat = byName.get(norm(item.category));
    const governor = cat ? governorOf(cat) : null;
    if (!governor) continue;

    let g = groups.get(governor.id);
    if (!g) {
      g = {
        id: governor.id,
        name: governor.name,
        items: [],
        itemIds: new Set(),
        stock: 0,
        threshold: parseNum(governor.min_threshold),
        active: false,
      };
      groups.set(governor.id, g);
    }

    g.items.push(item);
    g.itemIds.add(item.id);
    // Stock pools regardless of the flags: a bottle you're using up is still a
    // bottle in the house, and pretending otherwise would send you shopping
    // for something you already have.
    g.stock += parseNum(item.current_stock);
    if (!parseBool(item.no_restock)) g.active = true;
  }

  return groups;
}

/**
 * The governing category id for one item, or '' if it stands alone.
 *
 * Matched on id rather than object identity, so a caller holding a copy of a
 * row (a form's working value, say) still resolves to the right group.
 */
export function governorIdOf(item, groups) {
  for (const [id, g] of groups) {
    if (g.itemIds.has(item.id)) return id;
  }
  return '';
}

/**
 * How one item is doing.
 *
 * `level` is one of:
 *   'out'      nothing left, and it's wanted
 *   'low'      below what should be kept
 *   'ok'       fine, or no number set anywhere
 *   'winding'  no_restock — reported, never warned about
 *
 * `stock` / `threshold` are the numbers the decision was made on, which for a
 * pooled item are the category's totals rather than the row's own.
 */
export function stockStatus(item, groups) {
  const id = governorIdOf(item, groups);
  const group = id ? groups.get(id) : null;

  const stock = group ? group.stock : parseNum(item.current_stock);
  const threshold = group ? group.threshold : parseNum(item.min_threshold);
  const base = { stock, threshold, group: group || null, grouped: Boolean(group) };

  // An individually retired item inside a category still being stocked isn't
  // "winding down" in any useful sense — the category still needs filling, so
  // it reports the category's state like its siblings do.
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
 * A pooled category collapses to a single entry — three low toothbrush brands
 * are one line on the shopping list, not three — while items judged on their
 * own appear as themselves.
 *
 * Entries: { key, name, detail, stock, threshold, level, items }
 */
export function shortages(items, categories = []) {
  const groups = buildGroups(items, categories);
  const out = [];
  const seen = new Set();

  for (const item of items) {
    const status = stockStatus(item, groups);
    if (status.level !== 'low' && status.level !== 'out') continue;

    if (status.grouped) {
      if (seen.has(status.group.id)) continue;
      seen.add(status.group.id);
      const n = status.group.items.length;
      out.push({
        key: status.group.id,
        name: status.group.name,
        detail: `${n} item${n === 1 ? '' : 's'}`,
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
