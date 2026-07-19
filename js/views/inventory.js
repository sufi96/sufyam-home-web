// Inventory, grouped by the category tree, built for a stock-take: the thing
// you do most while walking round the house is adjust a count, so that's a
// button on every row rather than a trip through the edit form.
//
// The generic table in entity.js can't show this one honestly. A row's own
// numbers don't decide whether it's low — a category that sets "keep at least
// N" counts everything inside it together (see stock.js) — so a per-row "1 / 2"
// column would be actively misleading for exactly the items that rule exists
// for. Here the pooled figure sits on the category heading, where it applies.

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { schemaFor, parseBool, parseNum } from '../schema.js';
import { buildGroups, stockStatus } from '../stock.js';
import { glyphFor } from '../icons.js';
import { normaliseHex } from './cattree.js';
import { openForm } from './entity.js';
import { el, clear, toast, confirmDialog, emptyState, fmtDate, fmtNumber } from '../ui.js';

const KIND = taxonomy.KIND_INVENTORY_CATEGORY;
const UNCATEGORISED = '__none__';

export function renderInventory(container) {
  const schema = schemaFor('Inventory');
  let query = '';
  let filter = 'all'; // all | low | winding
  let showDeleted = false;

  const listWrap = el('div', {});

  const search = el('input', {
    class: 'input search',
    type: 'search',
    placeholder: 'Search items, brands, categories…',
    oninput: (e) => { query = e.target.value.trim().toLowerCase(); paint(); },
  });

  const filterSelect = el('select', {
    class: 'select',
    style: 'max-width:180px',
    onchange: (e) => { filter = e.target.value; paint(); },
  }, [
    el('option', { value: 'all', text: 'Everything' }),
    el('option', { value: 'low', text: 'Needs buying' }),
    el('option', { value: 'winding', text: 'Using up' }),
  ]);

  const deletedToggle = el('label', { class: 'check-row muted-check' }, [
    el('input', {
      type: 'checkbox',
      onchange: (e) => { showDeleted = e.target.checked; paint(); },
    }),
    'Show deleted',
  ]);

  container.append(
    el('div', { class: 'toolbar' }, [
      search,
      filterSelect,
      deletedToggle,
      el('div', { class: 'spacer' }),
      // A shortcut to the Stock categories page, which is also in the nav —
      // routed through the hash so it's one destination, not two copies of the
      // same screen with their own unsaved buffers.
      el('button', {
        class: 'btn btn-ghost',
        text: 'Categories',
        onclick: () => { location.hash = 'InventoryCategories'; },
      }),
      el('button', {
        class: 'btn',
        text: '+ New item',
        onclick: () => openForm(schema, null, paint),
      }),
    ]),
    listWrap,
  );

  paint();

  function paint() {
    const all = repo.rows('Inventory', { includeDeleted: showDeleted });
    const categories = taxonomy.list(KIND);
    // Pools are built from every live item, not the filtered set: a category's
    // total has to count the items a search happens to be hiding, or filtering
    // the list would change what counts as low.
    const groups = buildGroups(repo.rows('Inventory'), categories);

    const visible = all.filter((item) => {
      if (query && !blob(item).includes(query)) return false;
      if (filter === 'all') return true;
      const level = stockStatus(item, groups).level;
      if (filter === 'low') return level === 'low' || level === 'out';
      return level === 'winding';
    });

    clear(listWrap);

    if (!visible.length) {
      listWrap.append(emptyState(
        '📦',
        all.length ? 'Nothing matches that.' : 'No stock items yet.',
        all.length ? null : el('button', {
          class: 'btn',
          text: '+ New item',
          onclick: () => openForm(schema, null, paint),
        }),
      ));
      return;
    }

    for (const section of sections(visible, categories)) {
      listWrap.append(renderSection(section, groups, paint));
    }
  }
}

/**
 * Arranges the visible items into the category tree.
 *
 * Returns [{ entry, items, subs: [{ entry, items }] }], parents in bank order
 * with an "Uncategorised" bucket last. Items sitting directly on a parent and
 * items in its subcategories both appear under that parent, the latter under
 * their own subheading.
 */
function sections(items, categories) {
  const byName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c]));
  const buckets = new Map(); // category id (or UNCATEGORISED) -> items

  for (const item of items) {
    const cat = byName.get(String(item.category || '').trim().toLowerCase());
    const key = cat ? cat.id : UNCATEGORISED;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }

  const sortItems = (list) => list.sort(
    (a, b) => String(a.item_name || '').localeCompare(String(b.item_name || '')),
  );

  const out = [];
  for (const { entry, children } of taxonomy.tree(KIND)) {
    const own = buckets.get(entry.id) || [];
    const subs = children
      .map((child) => ({ entry: child, items: sortItems(buckets.get(child.id) || []) }))
      .filter((s) => s.items.length || parseNum(s.entry.min_threshold) > 0);

    // A category with nothing in it and no rule to state is just noise.
    if (!own.length && !subs.length) continue;
    out.push({ entry, items: sortItems(own), subs });
  }

  const loose = buckets.get(UNCATEGORISED) || [];
  if (loose.length) {
    out.push({ entry: null, items: sortItems(loose), subs: [] });
  }
  return out;
}

function renderSection({ entry, items, subs }, groups, refresh) {
  const children = [
    heading(entry, items, groups, 0),
    items.length ? el('div', { class: 'stock-rows' }, items.map(
      (item) => itemRow(item, groups, refresh),
    )) : null,
  ];

  for (const sub of subs) {
    children.push(heading(sub.entry, sub.items, groups, 1));
    if (sub.items.length) {
      children.push(el('div', { class: 'stock-rows' }, sub.items.map(
        (item) => itemRow(item, groups, refresh),
      )));
    } else {
      children.push(el('div', { class: 'stock-empty-sub', text: 'Nothing here yet.' }));
    }
  }

  return el('section', { class: 'stock-group' }, children);
}

/**
 * A category heading. When the category sets a "keep at least" number, the
 * pooled figure goes here rather than on the rows, because here is where it's
 * true — it's a statement about the category, not about any one item.
 */
function heading(entry, items, groups, depth) {
  if (!entry) {
    return el('div', { class: 'stock-group-head' }, [
      el('span', { class: 'micon cat-icon', text: 'help_outline' }),
      el('h3', { text: 'Uncategorised' }),
      el('span', { class: 'count', text: String(items.length) }),
    ]);
  }

  const group = groups.get(entry.id);
  const threshold = parseNum(entry.min_threshold);
  const short = items.filter((i) => {
    const l = stockStatus(i, groups).level;
    return l === 'low' || l === 'out';
  }).length;

  // Tinted with the category's own colour, the same colour the tree editor
  // fills its rows with — so a category is recognisable by colour in both
  // places rather than only where you set it.
  const colour = normaliseHex(entry.color_hex);

  return el('div', {
    class: `stock-group-head depth-${depth}`,
    style: colour
      ? `--cat-colour:${colour};`
        + `background:color-mix(in srgb, ${colour} ${depth ? 7 : 14}%, var(--surface));`
      : '',
  }, [
    el('span', {
      class: 'micon cat-icon',
      text: glyphFor(entry.icon_key || 'category'),
      style: colour ? `color:${colour}` : '',
    }),
    el(depth ? 'h4' : 'h3', { text: entry.name }),
    el('span', { class: 'count', text: String(items.length) }),
    threshold > 0
      ? el('span', {
          class: `pill ${group && group.stock < threshold ? 'pill-low' : 'pill-ok'}`,
          text: `${fmtNumber(group ? group.stock : 0)} of ${fmtNumber(threshold)} together`,
          title: 'Everything in this category counts towards one total, '
            + 'whatever the brand or variant.',
        })
      : (short ? el('span', { class: 'pill pill-low', text: `${short} to buy` }) : null),
  ]);
}

function itemRow(item, groups, refresh) {
  const status = stockStatus(item, groups);
  const deleted = parseBool(item.is_deleted);
  const unit = item.unit || '';

  return el('div', { class: `stock-row${deleted ? ' is-deleted' : ''}` }, [
    el('div', { class: 'stock-main' }, [
      el('div', { class: 'stock-title' }, [
        el('span', { class: 'name', text: item.item_name || '(unnamed)' }),
        item.brand ? el('span', { class: 'brand', text: item.brand }) : null,
        item.variant_size ? el('span', { class: 'variant', text: item.variant_size }) : null,
      ]),
      el('div', { class: 'stock-meta' }, [
        parseBool(item.is_refill) ? el('span', { class: 'pill pill-refill', text: 'Refill' }) : null,
        parseBool(item.no_restock) ? el('span', { class: 'pill pill-winding', text: 'Using up' }) : null,
        item.expiration_date
          ? el('span', { class: 'pill', text: `Exp ${fmtDate(item.expiration_date)}` })
          : null,
        // Only for items judged on their own. A pooled item's requirement is
        // stated once on the category heading instead of repeated on each row.
        !status.grouped && status.threshold > 0
          ? el('span', {
              class: `pill ${status.level === 'ok' ? 'pill-ok' : 'pill-low'}`,
              text: `keep ${fmtNumber(status.threshold)}`,
            })
          : null,
      ]),
    ]),

    el('div', { class: 'stock-count' }, [
      el('button', {
        class: 'btn btn-ghost btn-sm step',
        text: '−',
        title: 'One less',
        disabled: deleted || parseNum(item.current_stock) <= 0,
        onclick: (e) => adjust(e, item, -1, refresh),
      }),
      el('span', {
        class: `qty qty-${status.level}`,
        text: `${fmtNumber(parseNum(item.current_stock))}${unit ? ` ${unit}` : ''}`,
        title: status.grouped
          ? `This row's own count. ${status.group.name} needs `
            + `${fmtNumber(status.threshold)} in total and has ${fmtNumber(status.stock)}.`
          : (status.threshold > 0 ? `Keep at least ${fmtNumber(status.threshold)}` : ''),
      }),
      el('button', {
        class: 'btn btn-ghost btn-sm step',
        text: '+',
        title: 'One more',
        disabled: deleted,
        onclick: (e) => adjust(e, item, 1, refresh),
      }),
    ]),

    el('div', { class: 'stock-actions' }, [
      deleted
        ? el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Restore',
            onclick: async () => {
              try {
                await repo.restore('Inventory', item.id);
                toast('Restored');
                refresh();
              } catch (err) { toast(err.message, { error: true }); }
            },
          })
        : el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Edit',
            onclick: () => openForm(schemaFor('Inventory'), item, refresh),
          }),
      deleted ? null : el('button', {
        class: 'btn btn-ghost btn-sm btn-danger',
        text: '🗑',
        title: 'Delete',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Delete item?',
            message: `"${item.item_name || item.id}" will be marked deleted and disappear from `
              + 'your phone on the next sync. The row stays in the sheet and can be restored.',
          });
          if (!ok) return;
          try {
            await repo.remove('Inventory', item.id);
            toast('Deleted');
            refresh();
          } catch (err) { toast(err.message, { error: true }); }
        },
      }),
    ]),
  ]);
}

/**
 * Nudges one item's count by [delta].
 *
 * Writes straight through rather than buffering: a stock-take is a slow walk
 * round the house, and a batch of unsaved counts is a batch you can lose by
 * closing the tab. The button disables while the write is in flight so a
 * double-tap can't send two.
 */
async function adjust(event, item, delta, refresh) {
  const button = event.currentTarget;
  const next = parseNum(item.current_stock) + delta;
  if (next < 0) return;

  button.disabled = true;
  try {
    await repo.save('Inventory', { ...item, current_stock: next });
    refresh();
  } catch (err) {
    button.disabled = false;
    toast(err.message, { error: true });
  }
}

function blob(item) {
  return [item.item_name, item.brand, item.variant_size, item.category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
