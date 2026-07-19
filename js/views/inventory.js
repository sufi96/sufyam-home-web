// Inventory, grouped by category, built for a stock-take: the thing you do
// most while walking round the house is adjust a count, so that's a button on
// every row rather than a trip through the edit form.
//
// The generic table in entity.js can't show this one honestly. A row's own
// numbers don't decide whether it's low — items sharing a stock group are
// judged on their pooled total (see stock.js) — so a per-row "2 / 3" column
// would be actively misleading for exactly the items the grouping exists for.

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { schemaFor, parseBool, parseNum } from '../schema.js';
import { buildGroups, stockStatus, groupKeyOf } from '../stock.js';
import { openForm } from './entity.js';
import { el, clear, toast, confirmDialog, emptyState, fmtDate, fmtNumber } from '../ui.js';

const UNCATEGORISED = 'Uncategorised';

export function renderInventory(container) {
  const schema = schemaFor('Inventory');
  let query = '';
  let filter = 'all'; // all | low | winding
  let showDeleted = false;

  const listWrap = el('div', {});

  const search = el('input', {
    class: 'input search',
    type: 'search',
    placeholder: 'Search items, brands, groups…',
    oninput: (e) => { query = e.target.value.trim().toLowerCase(); paint(); },
  });

  const filterSelect = el('select', {
    class: 'select',
    style: 'max-width:190px',
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
    // Groups are built from every live item, not the filtered set: a group's
    // total has to count the members a search happens to be hiding, or
    // filtering the list would change what counts as low.
    const groups = buildGroups(repo.rows('Inventory'));

    const list = all.filter((item) => {
      if (query && !blob(item).includes(query)) return false;
      if (filter === 'all') return true;
      const level = stockStatus(item, groups).level;
      if (filter === 'low') return level === 'low' || level === 'out';
      return level === 'winding';
    });

    clear(listWrap);

    if (!list.length) {
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

    for (const [category, items] of byCategory(list)) {
      listWrap.append(categorySection(category, items, groups, paint));
    }
  }
}

/** Category name -> items, ordered the way the taxonomy bank is ordered. */
function byCategory(items) {
  const buckets = new Map();
  for (const item of items) {
    const name = String(item.category || '').trim() || UNCATEGORISED;
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(item);
  }

  const rank = new Map(
    taxonomy.names(taxonomy.KIND_INVENTORY_CATEGORY).map((n, i) => [n.toLowerCase(), i]),
  );
  const order = (name) => (name === UNCATEGORISED
    ? Number.MAX_SAFE_INTEGER // always last, whatever it's called
    : rank.get(name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER - 1);

  const sorted = [...buckets.entries()].sort((a, b) => {
    const d = order(a[0]) - order(b[0]);
    return d !== 0 ? d : a[0].localeCompare(b[0]);
  });

  for (const [, list] of sorted) {
    list.sort((a, b) => {
      // Grouped items sit together, under the group's name.
      const g = groupKeyOf(a).localeCompare(groupKeyOf(b));
      if (g !== 0) return g;
      return String(a.item_name || '').localeCompare(String(b.item_name || ''));
    });
  }
  return sorted;
}

function categorySection(category, items, groups, refresh) {
  const meta = taxonomy.list(taxonomy.KIND_INVENTORY_CATEGORY)
    .find((t) => t.name.toLowerCase() === category.toLowerCase());
  const colour = meta?.color_hex || '';

  const short = items.filter((i) => {
    const l = stockStatus(i, groups).level;
    return l === 'low' || l === 'out';
  }).length;

  return el('section', { class: 'stock-group' }, [
    el('div', { class: 'stock-group-head' }, [
      colour ? el('span', { class: 'dot', style: `background:${colour}` }) : null,
      el('h3', { text: category }),
      el('span', { class: 'count', text: `${items.length}` }),
      short ? el('span', { class: 'pill pill-low', text: `${short} to buy` }) : null,
    ]),
    el('div', { class: 'stock-rows' }, items.map(
      (item) => itemRow(item, groups, refresh, items),
    )),
  ]);
}

function itemRow(item, groups, refresh, siblings) {
  const status = stockStatus(item, groups);
  const deleted = parseBool(item.is_deleted);
  const unit = item.unit || '';

  // Only the first member of a group carries the group's summary, so a group
  // of five variants doesn't repeat the same "3 of 2" five times.
  const isGroupLead = status.grouped
    && siblings.find((s) => groupKeyOf(s) === status.group.key) === item;

  return el('div', {
    class: `stock-row${deleted ? ' is-deleted' : ''}`,
  }, [
    el('div', { class: 'stock-main' }, [
      el('div', { class: 'stock-title' }, [
        el('span', { class: 'name', text: item.item_name || '(unnamed)' }),
        item.brand ? el('span', { class: 'brand', text: item.brand }) : null,
        item.variant_size ? el('span', { class: 'variant', text: item.variant_size }) : null,
      ]),
      el('div', { class: 'stock-meta' }, [
        status.grouped
          ? el('span', {
              class: 'pill pill-group',
              text: `Group: ${status.group.name}`,
              title: `Pooled with ${status.group.items.length} item(s). `
                + `Group holds ${fmtNumber(status.stock)}, wants ${fmtNumber(status.threshold)}.`,
            })
          : null,
        parseBool(item.is_refill) ? el('span', { class: 'pill pill-refill', text: 'Refill' }) : null,
        parseBool(item.no_restock) ? el('span', { class: 'pill pill-winding', text: 'Using up' }) : null,
        item.expiration_date
          ? el('span', { class: 'pill', text: `Exp ${fmtDate(item.expiration_date)}` })
          : null,
        isGroupLead
          ? el('span', {
              class: `pill ${status.level === 'ok' ? 'pill-ok' : 'pill-low'}`,
              text: `${fmtNumber(status.stock)} of ${fmtNumber(status.threshold)} in group`,
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
          ? 'This row\'s own count. Low-stock is judged on the group total.'
          : `Keep at least ${fmtNumber(status.threshold)}`,
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
  return [item.item_name, item.brand, item.variant_size, item.category, item.stock_group]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
