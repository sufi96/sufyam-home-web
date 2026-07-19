// Inventory as one editable tree: category > subcategory > the items in it,
// with the selected row's details on the right.
//
// Dragging an item onto a category is how it gets filed, which is why the
// detail pane has no category dropdown: in a tree the item's position already
// states its category, and two controls for one fact is how they end up
// disagreeing.
//
// Edits are BUFFERED — names, brands, counts, structure — and Save writes
// categories and items in one batch each. The exception is the +/- stepper,
// which writes straight through; see adjust().
//
// Two structures, deliberately:
//   catOrder  the category arrangement, [{ id, depth }]. The buffer that drag
//             rearranges.
//   layout()  what's actually rendered: catOrder with each category's items
//             slotted in beneath it, ordered by the chosen sort.
//
// Items are placed by their `category` field rather than by a position in the
// buffer. That's what lets a collapsed category still be dragged correctly —
// its hidden items aren't on screen to be carried along, but they don't need
// to be, because moving a category never changes which items belong to it.

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
  el, clear, toast, openModal, confirmDialog, emptyState, fmtDate, fmtNumber,
} from '../ui.js';

const KIND = taxonomy.KIND_INVENTORY_CATEGORY;
const MAX_DEPTH = 2; // category > subcategory > item
const CAT_EDITABLE = ['name', 'icon_key', 'color_hex', 'min_threshold'];
const ITEM_EDITABLE = [
  'item_name', 'brand', 'variant_size', 'current_stock', 'unit',
  'min_threshold', 'expiration_date', 'is_refill', 'no_restock', 'category',
];
const PENDING_KEY = 'sufyam.inv.pending';
const COLLAPSE_KEY = 'sufyam.inv.collapsed';

// Items have no sort_order column, so their order can't be stored. Sorting
// them by a rule instead is honest about that — a hand-arranged order would
// look like it worked and then reset on the next load.
const ITEM_SORTS = {
  name: (a, b) => String(a.item_name || '').localeCompare(String(b.item_name || '')),
  stock: (a, b) => parseNum(a.current_stock) - parseNum(b.current_stock),
  brand: (a, b) => String(a.brand || '').localeCompare(String(b.brand || '')),
};

const key = (v) => String(v || '').trim().toLowerCase();

export function renderInventory(container) {
  let query = '';
  let filter = 'all';
  let itemSort = localStorage.getItem('sufyam.inv.sort') || 'name';
  let saving = false;
  let selected = null;      // { kind: 'cat' | 'item', id }

  let catOrder = [];        // [{ id, depth }] — categories only
  let catEdits = new Map();
  let itemEdits = new Map();
  let baseline = new Map(); // id -> 'parentId|sortOrder' as at load

  let collapsed = new Set(readCollapsed());
  // What's currently on screen, in order. attachTreeDrag rearranges this;
  // absorb() turns the result back into stored intent.
  let renderedRows = [];

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
  const effItems = () => repo.rows('Inventory').map((i) => effItem(i.id)).filter(Boolean);

  /** The stored category arrangement, depth-first. */
  function readCatOrder() {
    const cats = taxonomy.list(KIND);
    const live = new Map(cats.map((c) => [c.id, c]));
    const kids = new Map();
    for (const cat of cats) {
      const parent = cat.parent_id && live.has(cat.parent_id) ? cat.parent_id : '';
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(cat);
    }
    for (const list of kids.values()) list.sort(bySortOrder);

    const out = [];
    const walk = (parentId, depth) => {
      for (const cat of kids.get(parentId) || []) {
        out.push({ id: cat.id, depth });
        if (depth < 1) walk(cat.id, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }

  /** Categories with their items slotted in — what gets rendered. */
  function layout() {
    const derived = deriveCats();
    const byCategory = new Map();
    for (const item of effItems()) {
      const k = key(item.category);
      if (!byCategory.has(k)) byCategory.set(k, []);
      byCategory.get(k).push(item);
    }

    const known = new Set();
    const out = [];
    for (const { id } of catOrder) {
      const cat = effCat(id);
      if (!cat) continue;
      const depth = derived.get(id)?.depth ?? 0;
      out.push({ id, depth, kind: 'cat' });
      known.add(key(cat.name));

      const items = (byCategory.get(key(cat.name)) || []).slice()
        .sort(ITEM_SORTS[itemSort] || ITEM_SORTS.name);
      for (const item of items) out.push({ id: item.id, depth: depth + 1, kind: 'item' });
    }

    // Items whose category matches nothing go last, at the top level, where
    // they're visible rather than quietly missing from the list.
    for (const item of effItems()) {
      if (!known.has(key(item.category))) out.push({ id: item.id, depth: 0, kind: 'item' });
    }
    return out;
  }

  const deriveCats = () => deriveTree(catOrder, 1);

  function syncWorking() {
    catOrder = readCatOrder();
    catEdits = new Map();
    itemEdits = new Map();
    baseline = snapshot();
  }

  /**
   * The arrangement as a comparable string per category.
   *
   * Compared against a snapshot taken at load rather than against a freshly
   * derived canonical form. Sheets written by older versions have gappy or
   * duplicated sort_order values, and deriving those afresh renumbers them —
   * which made every row read as unsaved from the moment the page opened, and
   * left Discard with nothing it could do about it.
   */
  function snapshot() {
    const derived = deriveCats();
    const out = new Map();
    for (const [id, v] of derived) out.set(id, `${v.parent_id}|${v.sort_order}`);
    return out;
  }

  function dirtyRows() {
    const derived = deriveCats();
    const cats = [];
    const items = [];

    for (const [id, want] of derived) {
      const stored = storedCat(id);
      if (!stored) continue;
      const now = effCat(id);
      const moved = baseline.get(id) !== `${want.parent_id}|${want.sort_order}`;
      const changed = CAT_EDITABLE.some((k) => String(now[k] ?? '') !== String(stored[k] ?? ''));
      if (moved || changed) {
        cats.push({ ...now, parent_id: want.parent_id, sort_order: want.sort_order });
      }
    }

    // An item is dirty only when something was actually edited — including its
    // category, which drag writes into the buffer like any other field. The
    // buffer drops a key again when it matches what's stored, so this can't
    // report a change that isn't one.
    for (const [id, patch] of itemEdits) {
      const stored = storedItem(id);
      if (!stored || !Object.keys(patch).length) continue;
      items.push({ ...stored, ...patch });
    }

    return { cats, items, count: cats.length + items.length };
  }

  const isDirty = () => dirtyRows().count > 0;

  function persist() {
    if (!isDirty()) return localStorage.removeItem(PENDING_KEY);
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        catOrder, catEdits: [...catEdits], itemEdits: [...itemEdits], baseline: [...baseline],
      }));
    } catch { /* storage unavailable; the in-memory buffer still works */ }
  }

  function restore() {
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    } catch { return false; }
    if (!stored?.catOrder?.length) return false;

    // Every category in the buffer must still exist, and none may have
    // appeared since. Otherwise the arrangement no longer describes reality
    // and writing it would put a guess over whatever the sheet now holds.
    const liveCats = new Set(taxonomy.list(KIND).map((c) => c.id));
    const kept = stored.catOrder.filter((c) => liveCats.has(c.id));
    const missing = [...liveCats].filter((id) => !kept.some((c) => c.id === id));
    if (kept.length !== stored.catOrder.length || missing.length) {
      localStorage.removeItem(PENDING_KEY);
      return false;
    }

    const liveItems = new Set(repo.rows('Inventory').map((i) => i.id));
    catOrder = kept;
    catEdits = new Map((stored.catEdits || []).filter(([id]) => liveCats.has(id)));
    itemEdits = new Map((stored.itemEdits || []).filter(([id]) => liveItems.has(id)));
    if (stored.baseline) baseline = new Map(stored.baseline);
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
        style: 'max-width:155px',
        onchange: (e) => { filter = e.target.value; paintTree(); },
      }, [
        ['all', 'Everything'], ['low', 'Needs buying'], ['winding', 'Using up'],
      ].map(([v, t]) => el('option', { value: v, text: t, selected: filter === v }))),
      el('select', {
        class: 'select',
        style: 'max-width:140px',
        title: 'How items are ordered inside each category',
        onchange: (e) => {
          itemSort = e.target.value;
          localStorage.setItem('sufyam.inv.sort', itemSort);
          paintTree();
        },
      }, [
        ['name', 'Sort: name'], ['stock', 'Sort: stock'], ['brand', 'Sort: brand'],
      ].map(([v, t]) => el('option', { value: v, text: t, selected: itemSort === v }))),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: collapsed.size ? 'Expand all' : 'Collapse all',
        onclick: () => {
          collapsed = collapsed.size
            ? new Set()
            : new Set(catOrder.map((c) => c.id));
          writeCollapsed(collapsed);
          paintTree();
          refreshToolbar();
        },
      }),
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
        class: 'btn btn-ghost',
        text: '+ Category',
        onclick: () => withFlush(openCreateCategory),
      }),
      el('button', {
        class: 'btn',
        text: '+ Item',
        onclick: () => withFlush(() => openForm(schemaFor('Inventory'), null, () => {
          syncWorking();
          paintAll();
        })),
      }),
    ]);
  }

  /** Rows hidden because an ancestor category is collapsed. */
  function visibleRows(rows) {
    const out = [];
    let hideUnder = null; // depth of the collapsed category we're inside
    for (const row of rows) {
      if (hideUnder !== null && row.depth > hideUnder) continue;
      hideUnder = null;
      out.push(row);
      if (row.kind === 'cat' && collapsed.has(row.id)) hideUnder = row.depth;
    }
    return out;
  }

  function paintTree() {
    clear(treePane);
    persist();

    const groups = buildGroups(effItems(), effCategories());
    const filtering = Boolean(query) || filter !== 'all';
    const all = layout();

    // A filter cuts across the tree, so collapsing is ignored while one is on
    // — hiding matches inside a collapsed category would look like no results.
    const rows = (filtering ? all : visibleRows(all)).filter((r) => matches(r, groups));

    if (!rows.length) {
      treePane.append(emptyState(
        '📦',
        all.length ? 'Nothing matches that.' : 'No stock items yet.',
        all.length ? null : el('button', {
          class: 'btn',
          text: '+ New item',
          onclick: () => openForm(schemaFor('Inventory'), null, () => { syncWorking(); paintAll(); }),
        }),
      ));
      return;
    }

    const list = el('div', { class: 'cat-list inv-tree' });
    for (const row of rows) {
      const node = row.kind === 'cat'
        ? catRow(row, groups, { draggable: !filtering })
        : itemRow(row, groups, { draggable: !filtering });
      if (node) list.append(node);
    }
    treePane.append(list);

    // The array the drag rearranges has to be exactly what's on screen, so
    // it's rebuilt here from the rows just rendered.
    renderedRows = rows.map(({ id, depth }) => ({ id, depth }));

    if (!filtering && !saving) attachDrag(list);
  }

  function matches({ id, kind }, groups) {
    if (kind === 'item') {
      const item = effItem(id);
      if (!item) return false;
      if (query && !itemBlob(item).includes(query)) return false;
      if (filter === 'all') return true;
      const level = stockStatus(item, groups).level;
      return filter === 'low' ? (level === 'low' || level === 'out') : level === 'winding';
    }

    const cat = effCat(id);
    if (!cat) return false;
    const inside = itemsIn(cat);
    // A category stays visible when anything inside it matches, so filtering
    // never leaves items floating without their heading.
    if (filter !== 'all') {
      const any = inside.some((i) => {
        const level = stockStatus(i, groups).level;
        return filter === 'low' ? (level === 'low' || level === 'out') : level === 'winding';
      });
      if (!any) return false;
    }
    if (!query) return true;
    return cat.name.toLowerCase().includes(query)
      || inside.some((i) => itemBlob(i).includes(query));
  }

  const kindOf = (id) => (storedCat(id) ? 'cat' : 'item');

  function attachDrag(list) {
    attachTreeDrag(list, {
      maxDepth: MAX_DEPTH,
      depthNames: ['category', 'subcategory', 'item'],
      isBusy: () => saving,
      // The drag rearranges the rendered layout; absorb() then turns whatever
      // it produced back into the two things actually stored — the category
      // arrangement, and each moved item's category.
      getWorking: () => renderedRows,
      setWorking: (next) => { renderedRows = next; },
      nameOf: (id) => (kindOf(id) === 'cat' ? effCat(id)?.name : effItem(id)?.item_name) || '',
      // Categories and items share this list but obey different rules: an item
      // can't hold children and a category can't live inside an item. The
      // generic clamp only knows about depth, so the type rules go here.
      limitDepth: ({ id, wanted, aboveId, aboveDepth, defaultMax }) => {
        const dragged = kindOf(id);
        const above = aboveId ? kindOf(aboveId) : null;
        if (dragged === 'cat') {
          const ceiling = above === 'item' ? Math.max(0, aboveDepth - 1) : 1;
          return Math.max(0, Math.min(wanted, ceiling, defaultMax));
        }
        if (!above) return 0;
        return Math.max(0, Math.min(wanted, above === 'cat' ? aboveDepth + 1 : aboveDepth));
      },
      hintFor: ({ id, depth, parentName }) => {
        if (kindOf(id) === 'cat') {
          return depth === 0 ? '↤ top-level category' : `↳ subcategory of ${parentName}`;
        }
        return depth === 0 ? '↤ outside every category' : `↳ into ${parentName}`;
      },
      onDrop: ({ id }) => {
        absorb(id);
        paintTree();
        paintDetail();
        refreshToolbar();
      },
    });
  }

  /**
   * Turns a rearranged render order back into stored intent.
   *
   * Only the dragged row's meaning changes: moving a category never changes
   * which items belong to it, so item categories are read back only when an
   * item was what moved. That's also what makes dragging a collapsed category
   * safe — its hidden items aren't on screen, and don't need to be.
   */
  function absorb(draggedId) {
    if (kindOf(draggedId) === 'item') {
      const derived = deriveTree(renderedRows, MAX_DEPTH);
      const parentId = derived.get(draggedId)?.parent_id;
      const category = parentId ? (effCat(parentId)?.name || '') : '';
      buffer(itemEdits, draggedId, storedItem(draggedId), 'category', category);
    }
    // Only the visible categories were on screen to be rearranged. A collapsed
    // category's subcategories weren't, so they're re-attached behind whichever
    // visible category they were following — without this they'd simply drop
    // out of the arrangement and get re-parented to whatever came before them.
    const visible = renderedRows
      .filter((r) => kindOf(r.id) === 'cat')
      .map(({ id, depth }) => ({ id, depth: Math.min(depth, 1) }));
    const visibleIds = new Set(visible.map((c) => c.id));

    const hiddenAfter = new Map();
    let anchor = null;
    for (const cat of catOrder) {
      if (visibleIds.has(cat.id)) { anchor = cat.id; continue; }
      if (!hiddenAfter.has(anchor)) hiddenAfter.set(anchor, []);
      hiddenAfter.get(anchor).push(cat);
    }

    const next = [...(hiddenAfter.get(null) || [])];
    for (const cat of visible) {
      next.push(cat);
      for (const hidden of hiddenAfter.get(cat.id) || []) next.push(hidden);
    }
    catOrder = next;
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
    const isCollapsed = collapsed.has(id);
    const colour = normaliseHex(cat.color_hex) || '#7a8794';

    return el('div', {
      class: `cat-row is-cat depth-${depth}${isSelected('cat', id) ? ' is-selected' : ''}`,
      'data-id': id,
      'data-depth': String(depth),
      style: `--indent:${depth * INDENT_PX}px;--cat-colour:${colour};${rowTint(cat.color_hex, depth)}`,
      onclick: (e) => { if (!e.target.closest('input, button')) select('cat', id); },
    }, [
      draggable
        ? el('span', { class: 'drag-handle', text: '⠿', title: 'Drag to reorder or nest' })
        : el('span', { style: 'width:10px' }),
      el('button', {
        class: `twisty${isCollapsed ? ' is-collapsed' : ''}`,
        title: isCollapsed ? 'Show what\'s inside' : 'Hide what\'s inside',
        text: '▾',
        onclick: (e) => {
          e.stopPropagation();
          if (collapsed.has(id)) collapsed.delete(id);
          else collapsed.add(id);
          writeCollapsed(collapsed);
          paintTree();
          refreshToolbar();
        },
      }),
      categoryBadge(cat, depth === 0 ? 26 : 22, { onColour: depth === 0 }),
      el('span', { class: 'cat-name', text: cat.name || '(unnamed)' }),
      items.length
        ? el('span', { class: 'chip', title: `${items.length} item(s) inside`, text: String(items.length) })
        : null,
      threshold > 0
        ? el('span', {
            class: `chip ${pool && pool.stock < threshold ? 'chip-danger' : 'chip-accent'}`,
            title: 'Everything in this category counts as one pool, whatever the brand.',
            text: `${fmtNumber(pool ? pool.stock : 0)} of ${fmtNumber(threshold)}`,
          })
        : null,
      isCollapsed && items.length
        ? el('span', { class: 'chip chip-muted', text: 'hidden' })
        : null,
    ]);
  }

  function itemRow({ id, depth }, groups, { draggable }) {
    const item = effItem(id);
    if (!item) return null;
    const status = stockStatus(item, groups);
    const unit = item.unit || '';
    const colour = normaliseHex(parentColourOf(item)) || '';

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
      el('span', { class: 'item-name' }, [
        el('span', { class: 'item-label', text: item.item_name || '(unnamed)' }),
        item.brand ? el('span', { class: 'brand-badge', text: item.brand }) : null,
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

  function parentColourOf(item) {
    const cat = effCategories().find((c) => key(c.name) === key(item.category));
    return cat?.color_hex || '';
  }

  // ---------- right pane ----------

  function paintDetail() {
    clear(detailPane);
    if (!selected) {
      return detailPane.append(el('div', { class: 'card detail-empty' }, [
        emptyState('👈', 'Select a category or an item to edit it.'),
      ]));
    }
    return selected.kind === 'cat' ? paintCatDetail() : paintItemDetail();
  }

  function paintCatDetail() {
    const id = selected.id;
    const stored = storedCat(id);
    if (!stored) { selected = null; return paintDetail(); }

    const cat = effCat(id);
    const parent = cat.parent_id ? effCat(cat.parent_id) : null;
    const items = itemsIn(cat);
    const groups = buildGroups(effItems(), effCategories());
    const pool = groups.get(id);
    const threshold = parseNum(cat.min_threshold);

    const set = (k, v) => {
      buffer(catEdits, id, stored, k, v);
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
        items.length ? null : el('div', { class: 'hint', text: 'Drag items here to file them.' }),
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
    const parent = effCategories().find((c) => key(c.name) === key(item.category));
    const groups = buildGroups(effItems(), effCategories());
    const status = stockStatus(item, groups);

    const set = (k, v) => {
      buffer(itemEdits, id, stored, k, v);
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
  function buffer(map, id, stored, k, value) {
    const next = { ...(map.get(id) || {}) };
    if (String(value ?? '') === String(stored[k] ?? '')) delete next[k];
    else next[k] = value;
    if (Object.keys(next).length) map.set(id, next);
    else map.delete(id);
  }

  // ---------- saving ----------

  async function save() {
    const { cats, items, count } = dirtyRows();
    if (!count || saving) return;

    // Items reference categories by name, so two categories sharing one would
    // make every item under them ambiguous.
    const seen = new Map();
    for (const cat of effCategories()) {
      const k = key(cat.name);
      if (!k) return toast('A category needs a name', { error: true });
      if (seen.has(k)) return toast(`Two categories are both called "${cat.name}"`, { error: true });
      seen.set(k, cat.id);
    }

    saving = true;
    refreshToolbar();
    try {
      // Categories first: an item's `category` is a name, so it has to be
      // written against names that already exist in the sheet.
      if (cats.length) await repo.saveMany('Taxonomy', cats);

      // A renamed category takes its items with it, including items the user
      // never touched and which therefore aren't in `items`.
      const renamed = new Map();
      for (const cat of cats) {
        const before = storedCat(cat.id)?.name ?? '';
        if (before && before !== cat.name) renamed.set(key(before), cat.name);
      }
      const queued = new Map(items.map((i) => [i.id, i]));
      if (renamed.size) {
        for (const row of repo.rows('Inventory')) {
          const to = renamed.get(key(queued.get(row.id)?.category ?? row.category));
          if (!to) continue;
          queued.set(row.id, { ...(queued.get(row.id) || row), category: to });
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
    if (parseNum(item.current_stock) + delta < 0) return;

    button.disabled = true;
    try {
      if (isDirty()) await save();
      const live = storedItem(item.id);
      if (!live) return;
      await repo.save('Inventory', {
        ...live,
        current_stock: parseNum(live.current_stock) + delta,
      });
      syncWorking();
      paintAll();
    } catch (err) {
      button.disabled = false;
      toast(err.message, { error: true });
    }
  }

  // ---------- create / delete ----------

  function openCreateCategory() {
    let name = '';
    let parentId = '';

    openModal({
      title: 'New category',
      render: (body) => {
        body.append(el('div', { class: 'field' }, [
          el('label', { text: 'Name *' }),
          el('input', {
            class: 'input',
            type: 'text',
            placeholder: 'Cleaning, Toothbrush…',
            oninput: (e) => { name = e.target.value; },
          }),
        ]));
        body.append(el('div', { class: 'field' }, [
          el('label', { text: 'Inside' }),
          el('select', {
            class: 'select',
            onchange: (e) => { parentId = e.target.value; },
          }, [
            el('option', { value: '', text: '— top level —' }),
            ...taxonomy.roots(KIND).map((t) => el('option', { value: t.id, text: t.name })),
          ]),
          el('div', { class: 'hint', text: 'You can drag it somewhere else afterwards.' }),
        ]));
      },
      actions: (close) => {
        const btn = el('button', { class: 'btn', text: 'Add' });
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            // Written straight away rather than buffered: it needs a row in the
            // sheet before there's an id to hang buffered edits on. Its icon,
            // colour and threshold are then edited in the right-hand pane.
            const created = await taxonomy.create(KIND, { name, parent_id: parentId });
            close();
            syncWorking();
            selected = { kind: 'cat', id: created.id };
            paintAll();
          } catch (e) {
            btn.disabled = false;
            toast(e.message, { error: true });
          }
        });
        return [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), btn];
      },
    });
  }

  async function removeCategory(entry) {
    if (taxonomy.childrenOf(KIND, entry.id).length) {
      return toast('Move the categories inside it out first', { error: true });
    }
    const used = repo.rows('Inventory').filter((i) => key(i.category) === key(entry.name));
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

  /** Items filed in this category or any of its subcategories. */
  function itemsIn(cat) {
    const names = new Set(
      taxonomy.withDescendants(KIND, cat).map((t) => key(effCat(t.id)?.name || t.name)),
    );
    names.delete('');
    return effItems().filter((i) => names.has(key(i.category)));
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

function readCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]');
  } catch { return []; }
}

function writeCollapsed(set) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch { /* storage unavailable; collapse just won't persist */ }
}
