// Inventory as one editable tree: category > subcategory > the items in it,
// with the selected row's details on the right.
//
// The same shape as Stock categories, deliberately — but this screen puts the
// items in the tree too, so a stock-take is one list you scroll rather than a
// category page and an item page you bounce between. Dragging an item onto a
// category is how it gets filed; there's no category dropdown in the detail
// pane, because in a tree the item's position already states its category and
// two controls for one fact is how they end up disagreeing.
//
// Edits are BUFFERED, the same as the category screen: names, brands, counts
// and structure all go into a working copy and repaint immediately, and Save
// writes categories and items in one batch each. The exception is the +/-
// stepper, which writes straight through — see adjust().

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { schemaFor, parseBool, parseNum } from '../schema.js';
import { buildGroups, stockStatus, suggestionsFor } from '../stock.js';
import {
  INDENT_PX, attachTreeDrag, deriveTree, categoryBadge, rowTint, normaliseHex,
} from './cattree.js';
import { categoryFields, itemFields } from './catfields.js';
import { openForm } from './entity.js';
import {
  el, clear, toast, confirmDialog, emptyState, fmtDate, fmtNumber,
} from '../ui.js';

const KIND = taxonomy.KIND_INVENTORY_CATEGORY;
const MAX_DEPTH = 2; // category > subcategory > item
const CAT_EDITABLE = ['name', 'icon_key', 'color_hex', 'min_threshold'];
const ITEM_EDITABLE = [
  'item_name', 'brand', 'variant_size', 'current_stock', 'unit',
  'min_threshold', 'expiration_date', 'is_refill', 'no_restock',
];
const PENDING_KEY = 'sufyam.inv.pending';

// Items have no sort_order column, so their order can't be stored. Sorting
// them by a rule instead is honest about that — a hand-arranged order would
// silently reset on the next load.
const ITEM_SORTS = {
  name: (a, b) => String(a.item_name || '').localeCompare(String(b.item_name || '')),
  stock: (a, b) => parseNum(a.current_stock) - parseNum(b.current_stock),
  brand: (a, b) => String(a.brand || '').localeCompare(String(b.brand || '')),
};

export function renderInventory(container) {
  let query = '';
  let filter = 'all';   // all | low | winding
  let itemSort = localStorage.getItem('sufyam.inv.sort') || 'name';
  let saving = false;
  let selected = null;  // { kind: 'cat' | 'item', id }

  let working = [];         // [{ id, depth, kind }] — categories and items
  let catEdits = new Map();
  let itemEdits = new Map();

  const treePane = el('div', { class: 'pane' });
  const detailPane = el('div', { class: 'pane' });

  // ---------- model ----------

  const storedCat = (id) => repo.byId('Taxonomy', id);
  const storedItem = (id) => repo.byId('Inventory', id);

  function effCat(id) {
    const s = storedCat(id);
    return s ? { ...s, ...(catEdits.get(id) || {}) } : null;
  }
  function effItem(id) {
    const s = storedItem(id);
    return s ? { ...s, ...(itemEdits.get(id) || {}) } : null;
  }
  const effCategories = () => taxonomy.list(KIND).map((c) => effCat(c.id)).filter(Boolean);

  /** The tree as stored: categories in sort order, each followed by its items. */
  function buildTree() {
    const cats = taxonomy.list(KIND);
    const live = new Map(cats.map((c) => [c.id, c]));
    const kids = new Map();
    for (const cat of cats) {
      const key = cat.parent_id && live.has(cat.parent_id) ? cat.parent_id : '';
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(cat);
    }
    for (const list of kids.values()) list.sort(bySortOrder);

    const items = repo.rows('Inventory');
    const byCategory = new Map();
    for (const item of items) {
      const key = String(item.category || '').trim().toLowerCase();
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(item);
    }
    const itemsOf = (cat) => (byCategory.get(cat.name.trim().toLowerCase()) || [])
      .slice()
      .sort(ITEM_SORTS[itemSort] || ITEM_SORTS.name);

    const out = [];
    const walk = (parentId, depth) => {
      for (const cat of kids.get(parentId) || []) {
        out.push({ id: cat.id, depth, kind: 'cat' });
        for (const item of itemsOf(cat)) {
          out.push({ id: item.id, depth: depth + 1, kind: 'item' });
        }
        if (depth < 1) walk(cat.id, depth + 1);
      }
    };
    walk('', 0);

    // Items whose category doesn't match anything go last, at the top level,
    // where they're visible rather than quietly missing from the list.
    const known = new Set(cats.map((c) => c.name.trim().toLowerCase()));
    for (const item of items) {
      if (!known.has(String(item.category || '').trim().toLowerCase())) {
        out.push({ id: item.id, depth: 0, kind: 'item' });
      }
    }
    return out;
  }

  function syncWorking() {
    working = buildTree();
    catEdits = new Map();
    itemEdits = new Map();
  }

  const kindOf = (id) => working.find((w) => w.id === id)?.kind || 'cat';
  const derive = () => deriveTree(working, MAX_DEPTH);

  /**
   * What's changed, split by entity.
   *
   * An item's parent in the tree becomes its `category`; a category's parent
   * becomes its parent_id. Items carry no sort_order, so only their category
   * is structural for them.
   */
  function dirtyRows() {
    const derived = derive();
    const cats = [];
    const items = [];
    const nameById = new Map();
    for (const { id, kind } of working) {
      if (kind === 'cat') nameById.set(id, effCat(id)?.name || '');
    }

    for (const { id, kind } of working) {
      const want = derived.get(id);
      if (!want) continue;

      if (kind === 'cat') {
        const stored = storedCat(id);
        if (!stored) continue;
        const now = effCat(id);
        const structural = (stored.parent_id || '') !== want.parent_id
          || parseNum(stored.sort_order) !== want.sort_order;
        const changed = CAT_EDITABLE.some(
          (k) => String(now[k] ?? '') !== String(stored[k] ?? ''),
        );
        if (structural || changed) {
          cats.push({ ...now, parent_id: want.parent_id, sort_order: want.sort_order });
        }
      } else {
        const stored = storedItem(id);
        if (!stored) continue;
        const now = effItem(id);
        // Depth 0 means it's sitting outside every category.
        const category = want.depth === 0 ? '' : (nameById.get(want.parent_id) || '');
        const moved = String(stored.category || '') !== category;
        const changed = ITEM_EDITABLE.some(
          (k) => String(now[k] ?? '') !== String(stored[k] ?? ''),
        );
        if (moved || changed) items.push({ ...now, category });
      }
    }
    return { cats, items, count: cats.length + items.length };
  }

  const isDirty = () => dirtyRows().count > 0;

  function persist() {
    if (!isDirty()) return localStorage.removeItem(PENDING_KEY);
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        working, catEdits: [...catEdits], itemEdits: [...itemEdits],
      }));
    } catch { /* storage unavailable; the in-memory buffer still works */ }
  }

  function restore() {
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    } catch { return false; }
    if (!stored?.working?.length) return false;

    // Every row in the buffer must still exist, and nothing may have appeared
    // since. Otherwise the arrangement no longer describes reality and writing
    // it would put a guess over whatever the sheet now holds.
    const liveIds = new Set([
      ...taxonomy.list(KIND).map((c) => c.id),
      ...repo.rows('Inventory').map((i) => i.id),
    ]);
    const kept = stored.working.filter((w) => liveIds.has(w.id));
    const missing = [...liveIds].filter((id) => !kept.some((w) => w.id === id));
    if (kept.length !== stored.working.length || missing.length) {
      localStorage.removeItem(PENDING_KEY);
      return false;
    }
    working = kept;
    catEdits = new Map((stored.catEdits || []).filter(([id]) => liveIds.has(id)));
    itemEdits = new Map((stored.itemEdits || []).filter(([id]) => liveIds.has(id)));
    return isDirty();
  }

  // ---------- painting ----------

  function paintAll() {
    clear(container);
    container.append(toolbar(), el('div', { class: 'cat-split' }, [treePane, detailPane]));
    paintTree();
    paintDetail();
  }

  function refreshToolbar() {
    const old = container.querySelector('.toolbar');
    if (old) old.replaceWith(toolbar());
  }

  function toolbar() {
    const dirty = dirtyRows();
    return el('div', { class: 'toolbar' }, [
      el('input', {
        class: 'input search',
        type: 'search',
        placeholder: 'Search items, brands, categories…',
        value: query,
        oninput: (e) => { query = e.target.value.trim().toLowerCase(); paintTree(); },
      }),
      el('select', {
        class: 'select',
        style: 'max-width:165px',
        onchange: (e) => { filter = e.target.value; paintTree(); },
      }, [
        ['all', 'Everything'], ['low', 'Needs buying'], ['winding', 'Using up'],
      ].map(([v, t]) => el('option', { value: v, text: t, selected: filter === v }))),
      el('select', {
        class: 'select',
        style: 'max-width:150px',
        title: 'How items are ordered inside each category',
        onchange: (e) => {
          itemSort = e.target.value;
          localStorage.setItem('sufyam.inv.sort', itemSort);
          // Re-sorting rebuilds the arrangement, so any unsaved structural
          // change would be lost — flush it first.
          if (isDirty()) save().then(() => { syncWorking(); paintAll(); });
          else { syncWorking(); paintAll(); }
        },
      }, [
        ['name', 'Sort: name'], ['stock', 'Sort: stock'], ['brand', 'Sort: brand'],
      ].map(([v, t]) => el('option', { value: v, text: t, selected: itemSort === v }))),
      el('div', { class: 'spacer' }),
      dirty.count ? el('span', { class: 'chip chip-warn', text: `${dirty.count} unsaved` }) : null,
      el('button', {
        class: 'btn btn-ghost',
        text: 'Discard',
        disabled: !dirty.count || saving,
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Discard changes?',
            message: `${dirty.count} row(s) will go back to what the sheet holds. `
              + 'This cannot be undone.',
          });
          if (!ok) return;
          syncWorking();
          persist();
          paintAll();
        },
      }),
      el('button', {
        class: 'btn',
        text: saving ? 'Saving…' : 'Save',
        disabled: !dirty.count || saving,
        onclick: save,
      }),
      el('button', {
        class: 'btn',
        text: '+ New item',
        onclick: () => withFlush(() => openForm(schemaFor('Inventory'), null, () => {
          syncWorking();
          paintAll();
        })),
      }),
    ]);
  }

  function paintTree() {
    clear(treePane);
    persist();

    const derived = derive();
    const groups = buildGroups(repo.rows('Inventory'), effCategories());
    const filtering = Boolean(query) || filter !== 'all';

    const rows = working
      .map((w) => ({ ...w, depth: derived.get(w.id)?.depth ?? w.depth }))
      .filter((w) => matches(w, groups));

    if (!rows.length) {
      treePane.append(emptyState(
        '📦',
        working.length ? 'Nothing matches that.' : 'No stock items yet.',
        working.length ? null : el('button', {
          class: 'btn',
          text: '+ New item',
          onclick: () => openForm(schemaFor('Inventory'), null, () => { syncWorking(); paintAll(); }),
        }),
      ));
      return;
    }

    const list = el('div', { class: 'cat-list' });
    for (const row of rows) {
      const node = row.kind === 'cat'
        ? catRow(row, groups, { draggable: !filtering })
        : itemRow(row, groups, { draggable: !filtering });
      if (node) list.append(node);
    }
    treePane.append(list);

    // Reordering while rows are hidden would move things relative to rows that
    // aren't on screen, so drag is off until the view shows everything.
    if (!filtering && !saving) attachDrag(list);
  }

  /** Search matches an item on its own text, a category on its own or its items'. */
  function matches({ id, kind }, groups) {
    if (kind === 'item') {
      const item = effItem(id);
      if (!item) return false;
      if (query && !itemBlob(item).includes(query)) return false;
      if (filter === 'all') return true;
      const level = stockStatus(item, groups).level;
      return filter === 'low'
        ? (level === 'low' || level === 'out')
        : level === 'winding';
    }

    const cat = effCat(id);
    if (!cat) return false;
    // A category stays visible when anything inside it matches, so filtering
    // never leaves items floating without their heading.
    const inside = itemsIn(cat);
    if (filter !== 'all') {
      const anyMatch = inside.some((i) => {
        const level = stockStatus(i, groups).level;
        return filter === 'low' ? (level === 'low' || level === 'out') : level === 'winding';
      });
      if (!anyMatch) return false;
    }
    if (!query) return true;
    return cat.name.toLowerCase().includes(query)
      || inside.some((i) => itemBlob(i).includes(query));
  }

  function attachDrag(list) {
    attachTreeDrag(list, {
      maxDepth: MAX_DEPTH,
      depthNames: ['category', 'subcategory', 'item'],
      isBusy: () => saving,
      getWorking: () => working,
      setWorking: (next) => { working = next; },
      nameOf: (id) => (kindOf(id) === 'cat'
        ? effCat(id)?.name
        : effItem(id)?.item_name) || '',
      // Categories and items share this list but obey different rules: an item
      // can't hold children and a category can't live inside an item. The
      // generic clamp only knows about depth, so the type rules go here.
      limitDepth: ({ id, wanted, aboveId, aboveDepth, defaultMax }) => {
        const dragged = kindOf(id);
        const above = aboveId ? kindOf(aboveId) : null;

        if (dragged === 'cat') {
          // Categories go two levels at most, and never inside an item.
          const ceiling = above === 'item' ? Math.max(0, aboveDepth - 1) : 1;
          return Math.max(0, Math.min(wanted, ceiling, defaultMax));
        }
        // An item sits inside whatever category is above it; below another
        // item it becomes that item's sibling rather than its child.
        if (!above) return 0;
        const ceiling = above === 'cat' ? aboveDepth + 1 : aboveDepth;
        return Math.max(0, Math.min(wanted, ceiling));
      },
      hintFor: ({ id, depth, parentName }) => {
        if (kindOf(id) === 'cat') {
          return depth === 0 ? '↤ top-level category' : `↳ subcategory of ${parentName}`;
        }
        return depth === 0 ? '↤ outside every category' : `↳ into ${parentName}`;
      },
      onDrop: () => { paintTree(); paintDetail(); refreshToolbar(); },
    });
  }

  function select(kind, id) {
    selected = { kind, id };
    for (const other of treePane.querySelectorAll('.cat-row')) {
      other.classList.toggle('is-selected', other.dataset.id === id);
    }
    paintDetail();
  }

  function catRow({ id, depth }, groups, { draggable }) {
    const cat = effCat(id);
    if (!cat) return null;
    const items = itemsIn(cat);
    const threshold = parseNum(cat.min_threshold);
    const pool = groups.get(id);

    return el('div', {
      class: `cat-row depth-${depth} is-category${isSelected('cat', id) ? ' is-selected' : ''}`,
      'data-id': id,
      'data-depth': String(depth),
      style: `--indent:${depth * INDENT_PX}px;${rowTint(cat.color_hex, depth)}`,
      onclick: (e) => { if (!e.target.closest('input, button')) select('cat', id); },
    }, [
      draggable
        ? el('span', { class: 'drag-handle', text: '⠿', title: 'Drag to reorder or nest' })
        : el('span', { style: 'width:10px' }),
      categoryBadge(cat, depth === 0 ? 26 : 22, { onColour: depth === 0 }),
      el('span', { class: 'cat-name', text: cat.name || '(unnamed)' }),
      items.length ? el('span', { class: 'chip', text: String(items.length) }) : null,
      threshold > 0
        ? el('span', {
            class: `chip ${pool && pool.stock < threshold ? 'chip-danger' : 'chip-accent'}`,
            title: 'Everything in this category counts as one pool, whatever the brand.',
            text: `${fmtNumber(pool ? pool.stock : 0)} of ${fmtNumber(threshold)}`,
          })
        : null,
    ]);
  }

  function itemRow({ id, depth }, groups, { draggable }) {
    const item = effItem(id);
    if (!item) return null;
    const status = stockStatus(item, groups);
    const unit = item.unit || '';

    // Items are visually a rung below their category: no colour fill, a quieter
    // row, and the category's colour only as a thin edge so you can still see
    // which one it belongs to when scrolling.
    const colour = normaliseHex(parentColourOf(id)) || '';

    return el('div', {
      class: `cat-row stock-item depth-${depth}${isSelected('item', id) ? ' is-selected' : ''}`,
      'data-id': id,
      'data-depth': String(depth),
      style: `--indent:${depth * INDENT_PX}px;${colour ? `--item-accent:${colour};` : ''}`,
      onclick: (e) => { if (!e.target.closest('input, button')) select('item', id); },
    }, [
      draggable
        ? el('span', { class: 'drag-handle', text: '⠿', title: 'Drag into another category' })
        : el('span', { style: 'width:10px' }),
      el('span', { class: 'item-dot' }),
      el('span', { class: 'cat-name item-name' }, [
        el('span', { text: item.item_name || '(unnamed)' }),
        item.brand ? el('span', { class: 'brand', text: item.brand }) : null,
        item.variant_size ? el('span', { class: 'variant', text: item.variant_size }) : null,
      ]),
      parseBool(item.is_refill) ? el('span', { class: 'pill pill-refill', text: 'Refill' }) : null,
      parseBool(item.no_restock) ? el('span', { class: 'pill pill-winding', text: 'Using up' }) : null,
      item.expiration_date
        ? el('span', { class: 'pill', text: `Exp ${fmtDate(item.expiration_date)}` })
        : null,
      el('span', { style: 'flex:1' }),
      el('span', { class: 'stock-count' }, [
        el('button', {
          class: 'btn btn-ghost btn-sm step',
          text: '−',
          title: 'One less',
          disabled: parseNum(item.current_stock) <= 0,
          onclick: (e) => { e.stopPropagation(); adjust(e, item, -1); },
        }),
        el('span', {
          class: `qty qty-${status.level}`,
          text: `${fmtNumber(parseNum(item.current_stock))}${unit ? ` ${unit}` : ''}`,
          title: status.grouped
            ? `${status.group.name} wants ${fmtNumber(status.threshold)} in total `
              + `and has ${fmtNumber(status.stock)}.`
            : (status.threshold > 0 ? `Keep at least ${fmtNumber(status.threshold)}` : ''),
        }),
        el('button', {
          class: 'btn btn-ghost btn-sm step',
          text: '+',
          title: 'One more',
          onclick: (e) => { e.stopPropagation(); adjust(e, item, 1); },
        }),
      ]),
    ]);
  }

  const isSelected = (kind, id) => selected?.kind === kind && selected.id === id;

  /** The colour of the category an item currently sits in. */
  function parentColourOf(itemId) {
    const derived = derive();
    const parentId = derived.get(itemId)?.parent_id;
    return parentId ? (effCat(parentId)?.color_hex || '') : '';
  }

  // ---------- right pane ----------

  function paintDetail() {
    clear(detailPane);

    if (!selected) {
      return detailPane.append(el('div', { class: 'card detail-empty' }, [
        emptyState('👈', 'Select a category or an item to edit it.'),
      ]));
    }
    if (selected.kind === 'cat') return paintCatDetail();
    return paintItemDetail();
  }

  function paintCatDetail() {
    const id = selected.id;
    const stored = storedCat(id);
    if (!stored) { selected = null; return paintDetail(); }

    const cat = effCat(id);
    const parent = cat.parent_id ? effCat(cat.parent_id) : null;
    const items = itemsIn(cat);
    const groups = buildGroups(repo.rows('Inventory'), effCategories());
    const pool = groups.get(id);
    const threshold = parseNum(cat.min_threshold);

    const set = (key, value) => {
      buffer(catEdits, id, stored, key, value);
      paintTree();
      refreshToolbar();
      persist();
    };

    detailPane.append(el('div', { class: 'card' }, [
      el('div', { class: 'detail-head' }, [
        categoryBadge(cat, 36),
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'detail-title', text: cat.name || '(unnamed)' }),
          el('div', {
            class: 'detail-crumb',
            text: parent ? `Inside ${parent.name}` : 'Top-level category',
          }),
        ]),
      ]),
      el('div', { class: 'cat-detail-body' }, categoryFields(cat, set)),
      threshold > 0
        ? el('div', {
            class: `detail-note ${pool && pool.stock < threshold ? 'is-low' : 'is-ok'}`,
            text: `${fmtNumber(pool ? pool.stock : 0)} in stock across `
              + `${pool ? pool.items.length : 0} item(s) — wants ${fmtNumber(threshold)}.`,
          })
        : null,
      el('div', { class: 'detail-items' }, [
        el('div', { class: 'pane-title', text: `${items.length} item(s) inside` }),
        items.length
          ? null
          : el('div', { class: 'hint', text: 'Drag items here to file them.' }),
      ]),
      el('div', { class: 'detail-actions' }, [
        el('button', {
          class: 'btn btn-ghost btn-danger',
          text: 'Delete category',
          onclick: () => withFlush(() => removeCategory(stored)),
        }),
      ]),
    ]));
  }

  function paintItemDetail() {
    const id = selected.id;
    const stored = storedItem(id);
    if (!stored) { selected = null; return paintDetail(); }

    const item = effItem(id);
    const derived = derive();
    const parentId = derived.get(id)?.parent_id;
    const parent = parentId ? effCat(parentId) : null;
    const groups = buildGroups(repo.rows('Inventory'), effCategories());
    const status = stockStatus(item, groups);

    const set = (key, value) => {
      buffer(itemEdits, id, stored, key, value);
      paintTree();
      refreshToolbar();
      persist();
    };

    detailPane.append(el('div', { class: 'card' }, [
      el('div', { class: 'detail-head' }, [
        el('span', {
          class: 'micon',
          style: `font-size:30px;color:${normaliseHex(parent?.color_hex) || 'var(--text-dim)'}`,
          text: 'inventory_2',
        }),
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'detail-title', text: item.item_name || '(unnamed)' }),
          el('div', {
            class: 'detail-crumb',
            text: parent ? `In ${parent.name} — drag it elsewhere to move it` : 'Not in any category',
          }),
        ]),
      ]),

      status.grouped
        ? el('div', {
            class: `detail-note ${status.level === 'ok' ? 'is-ok' : 'is-low'}`,
            text: `Counted with the rest of ${status.group.name}: `
              + `${fmtNumber(status.stock)} of ${fmtNumber(status.threshold)} together. `
              + 'This item\'s own "keep at least" is ignored while that applies.',
          })
        : null,

      el('div', { class: 'cat-detail-body' }, itemFields(item, set, {
        brands: suggestionsFor(repo.rows('Inventory'), 'brand'),
      })),

      el('div', { class: 'detail-actions' }, [
        el('button', {
          class: 'btn btn-ghost btn-danger',
          text: 'Delete item',
          onclick: () => withFlush(() => removeItem(stored)),
        }),
      ]),
    ]));
  }

  /** Records one field edit, dropping it again if it matches what's stored. */
  function buffer(map, id, stored, key, value) {
    const next = { ...(map.get(id) || {}) };
    if (String(value ?? '') === String(stored[key] ?? '')) delete next[key];
    else next[key] = value;
    if (Object.keys(next).length) map.set(id, next);
    else map.delete(id);
  }

  // ---------- saving ----------

  async function save() {
    const { cats, items, count } = dirtyRows();
    if (!count || saving) return;

    // Items reference categories by name, so two categories sharing one would
    // make every item under them ambiguous.
    const names = new Map();
    for (const cat of [...taxonomy.list(KIND).map((c) => effCat(c.id)), ...cats]) {
      const key = String(cat.name || '').trim().toLowerCase();
      if (!key) return toast('A category needs a name', { error: true });
      if (names.has(key) && names.get(key) !== cat.id) {
        return toast(`Two categories are both called "${cat.name}"`, { error: true });
      }
      names.set(key, cat.id);
    }

    saving = true;
    refreshToolbar();
    try {
      // Categories first: an item's `category` is a name, so it has to be
      // written against names that already exist in the sheet.
      if (cats.length) await repo.saveMany('Taxonomy', cats);

      // A renamed category takes its items with it, including items the user
      // didn't touch and which therefore aren't in `items` yet.
      const renamed = new Map();
      for (const cat of cats) {
        const before = storedCat(cat.id)?.name ?? '';
        if (before && before !== cat.name) renamed.set(before.trim().toLowerCase(), cat.name);
      }
      const queued = new Map(items.map((i) => [i.id, i]));
      if (renamed.size) {
        for (const row of repo.rows('Inventory')) {
          if (queued.has(row.id)) continue;
          const to = renamed.get(String(row.category || '').trim().toLowerCase());
          if (to) queued.set(row.id, { ...row, category: to });
        }
      }
      if (queued.size) await repo.saveMany('Inventory', [...queued.values()]);

      toast(`Saved ${count} change${count === 1 ? '' : 's'}`);
      syncWorking();
      localStorage.removeItem(PENDING_KEY);
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      saving = false;
      paintAll();
    }
  }

  async function withFlush(action) {
    if (isDirty()) await save();
    action();
  }

  /**
   * The +/- stepper writes straight through rather than buffering.
   *
   * A stock-take is a slow walk round the house, and a batch of unsaved counts
   * is a batch you can lose by closing the tab. It flushes any buffered edits
   * first so the two paths can't fight over the same row.
   */
  async function adjust(event, item, delta) {
    const button = event.currentTarget;
    const next = parseNum(item.current_stock) + delta;
    if (next < 0) return;

    button.disabled = true;
    try {
      if (isDirty()) await save();
      const live = storedItem(item.id);
      if (!live) return;
      await repo.save('Inventory', { ...live, current_stock: parseNum(live.current_stock) + delta });
      syncWorking();
      paintAll();
    } catch (err) {
      button.disabled = false;
      toast(err.message, { error: true });
    }
  }

  // ---------- create / delete ----------

  async function removeCategory(entry) {
    if (taxonomy.childrenOf(KIND, entry.id).length) {
      return toast('Move the categories inside it out first', { error: true });
    }
    const used = repo.rows('Inventory').filter(
      (i) => String(i.category || '').trim().toLowerCase() === entry.name.trim().toLowerCase(),
    );
    const ok = await confirmDialog({
      title: `Delete "${entry.name}"?`,
      message: used.length
        ? `${used.length} item(s) are filed here. They stay in your inventory but become `
          + 'uncategorised, and any "keep at least" rule here stops applying.'
        : 'It has no items. The row stays in the sheet and can be restored.',
    });
    if (!ok) return;
    try {
      await taxonomy.remove(entry);
      selected = null;
      syncWorking();
      paintAll();
      toast('Deleted');
    } catch (e) { toast(e.message, { error: true }); }
  }

  async function removeItem(item) {
    const ok = await confirmDialog({
      title: 'Delete item?',
      message: `"${item.item_name || item.id}" will be marked deleted and disappear from `
        + 'your phone on the next sync. The row stays in the sheet and can be restored.',
    });
    if (!ok) return;
    try {
      await repo.remove('Inventory', item.id);
      selected = null;
      syncWorking();
      paintAll();
      toast('Deleted');
    } catch (e) { toast(e.message, { error: true }); }
  }

  // ---------- helpers ----------

  /** Items filed in this category or any of its subcategories, buffered names. */
  function itemsIn(cat) {
    const names = new Set(
      taxonomy.withDescendants(KIND, cat)
        .map((t) => (effCat(t.id)?.name || t.name).trim().toLowerCase()),
    );
    names.add(String(storedCat(cat.id)?.name || '').trim().toLowerCase());
    names.delete('');
    return repo.rows('Inventory')
      .filter((i) => names.has(String(i.category || '').trim().toLowerCase()));
  }

  syncWorking();
  if (restore()) toast('Restored unsaved inventory changes');
  paintAll();
}

function bySortOrder(a, b) {
  const d = parseNum(a.sort_order) - parseNum(b.sort_order);
  return d !== 0 ? d : (a.name || '').localeCompare(b.name || '');
}

function itemBlob(item) {
  return [item.item_name, item.brand, item.variant_size, item.category]
    .filter(Boolean).join(' ').toLowerCase();
}
