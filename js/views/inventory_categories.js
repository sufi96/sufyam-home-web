// The inventory category tree: "Cleaning" > "Sponge", "Detergent".
//
// Deliberately the same screen as expense categories — tree on the left, the
// selected row's details on the right, shared drag and colouring from
// cattree.js. Two category editors that behaved differently would be two
// things to learn, and this is the one you sit in front of while sorting out
// a shelf.
//
// What it adds over the expense tree is the "keep at least" number. Putting
// that on a category is what makes "two toothbrushes, whichever brand" work:
// everything inside is counted as one pool, so the requirement belongs to the
// category rather than to any one brand's row. See stock.js.
//
// EVERYTHING is buffered — structure, names, icons, colours, thresholds. The
// right-hand pane edits a working copy and repaints the tree live, so you can
// recolour six categories and see the result before a single request goes out;
// Save then writes the lot in one batch. That's one API call for a session of
// edits instead of one per keystroke-ish change, which is what kept tripping
// Google's per-minute write quota.

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { parseNum } from '../schema.js';
import {
  INDENT_PX, attachTreeDrag, deriveTree, categoryBadge, rowTint,
} from './cattree.js';
import { categoryFields, field } from './catfields.js';
import { buildGroups } from '../stock.js';
import {
  el, clear, toast, openModal, confirmDialog, emptyState, fmtNumber,
} from '../ui.js';

const KIND = taxonomy.KIND_INVENTORY_CATEGORY;
const MAX_DEPTH = 1; // parent > sub. Stock doesn't need a third level.
const DEPTH_NAMES = ['category', 'subcategory'];
const PENDING_KEY = 'sufyam.invcat.pending';

const EDITABLE = ['name', 'icon_key', 'color_hex', 'min_threshold'];

export function renderInventoryCategories(container) {
  let query = '';
  let saving = false;
  let selectedId = null;

  let working = [];      // [{ id, depth }] — the arrangement
  let edits = new Map(); // id -> partial row, the field edits

  const treePane = el('div', { class: 'pane' });
  const detailPane = el('div', { class: 'pane' });

  // ---------- model ----------

  /** The row as the user currently has it: what's stored, plus buffered edits. */
  function effective(id) {
    const stored = repo.byId('Taxonomy', id);
    if (!stored) return null;
    return { ...stored, ...(edits.get(id) || {}) };
  }

  /**
   * Every category as the user currently has it.
   *
   * Pooling has to be computed from these rather than from what's stored, or a
   * threshold you just typed wouldn't count until you saved — the row would
   * claim "0 of 2" while showing two items sitting right there.
   */
  function effectiveCategories() {
    return taxonomy.list(KIND).map((c) => effective(c.id)).filter(Boolean);
  }

  function buildTree() {
    const all = taxonomy.list(KIND);
    const live = new Map(all.map((c) => [c.id, c]));
    const kids = new Map();
    for (const cat of all) {
      const key = cat.parent_id && live.has(cat.parent_id) ? cat.parent_id : '';
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(cat);
    }
    for (const list of kids.values()) list.sort(bySortOrder);

    const flat = [];
    const walk = (parentId, depth) => {
      for (const cat of kids.get(parentId) || []) {
        flat.push({ cat, depth });
        if (depth < MAX_DEPTH) walk(cat.id, depth + 1);
      }
    };
    walk('', 0);
    return flat;
  }

  function syncWorking() {
    working = buildTree().map(({ cat, depth }) => ({ id: cat.id, depth }));
    edits = new Map();
  }

  const derive = () => deriveTree(working, MAX_DEPTH);

  /** Rows whose buffered state differs from what's in the sheet. */
  function dirtyRows() {
    const derived = derive();
    const out = [];
    for (const [id, want] of derived) {
      const stored = repo.byId('Taxonomy', id);
      if (!stored) continue;
      const now = effective(id);

      const structural = (stored.parent_id || '') !== want.parent_id
        || parseNum(stored.sort_order) !== want.sort_order;
      const fieldChanged = EDITABLE.some((k) => String(now[k] ?? '') !== String(stored[k] ?? ''));

      if (structural || fieldChanged) {
        out.push({ ...now, parent_id: want.parent_id, sort_order: want.sort_order });
      }
    }
    return out;
  }

  const isDirty = () => dirtyRows().length > 0;

  // Unsaved work survives a reload. Restored only when every row in the buffer
  // still exists — a row vanishing (deleted on the phone, say) means the
  // arrangement no longer describes reality, and writing it would put a guess
  // over whatever the sheet now holds.
  function persistWorking() {
    if (!isDirty()) {
      localStorage.removeItem(PENDING_KEY);
      return;
    }
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ working, edits: [...edits] }));
    } catch { /* storage unavailable; the in-memory buffer still works */ }
  }

  function restoreWorking() {
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    } catch { return false; }
    if (!stored?.working?.length) return false;

    const liveIds = new Set(taxonomy.list(KIND).map((c) => c.id));
    const kept = stored.working.filter((w) => liveIds.has(w.id));
    const missing = [...liveIds].filter((id) => !kept.some((w) => w.id === id));
    if (kept.length !== stored.working.length || missing.length) {
      localStorage.removeItem(PENDING_KEY);
      return false;
    }
    working = kept;
    edits = new Map((stored.edits || []).filter(([id]) => liveIds.has(id)));
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
        placeholder: 'Search categories…',
        value: query,
        oninput: (e) => { query = e.target.value.trim().toLowerCase(); paintTree(); },
      }),
      el('div', { class: 'spacer' }),
      dirty.length
        ? el('span', { class: 'chip chip-warn', text: `${dirty.length} unsaved` })
        : null,
      el('button', {
        class: 'btn btn-ghost',
        text: 'Discard',
        disabled: !dirty.length || saving,
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Discard changes?',
            message: `${dirty.length} categor${dirty.length === 1 ? 'y' : 'ies'} will go back to `
              + 'what the sheet holds. This cannot be undone.',
          });
          if (!ok) return;
          syncWorking();
          persistWorking();
          paintAll();
        },
      }),
      el('button', {
        class: 'btn',
        text: saving ? 'Saving…' : 'Save',
        disabled: !dirty.length || saving,
        onclick: save,
      }),
      el('button', {
        class: 'btn',
        text: '+ New',
        onclick: () => withFlush(openCreate),
      }),
    ]);
  }

  function paintTree() {
    clear(treePane);
    persistWorking();

    const derived = derive();
    const flat = working.map(({ id, depth }) => ({ id, depth: derived.get(id)?.depth ?? depth }));
    const filtering = Boolean(query);
    const visible = filtering
      ? flat.filter(({ id }) => (effective(id)?.name || '').toLowerCase().includes(query))
      : flat;

    if (!visible.length) {
      treePane.append(emptyState(
        '🏷️',
        flat.length
          ? 'No categories match that.'
          : 'No categories yet. Add "Cleaning", then drag "Sponge" under it.',
        flat.length ? null : el('button', { class: 'btn', text: '+ New category', onclick: openCreate }),
      ));
      return;
    }

    const groups = buildGroups(repo.rows('Inventory'), effectiveCategories());
    const list = el('div', { class: 'cat-list' });
    for (const entry of visible) {
      const row = buildRow(entry, groups, { draggable: !filtering });
      if (row) list.append(row);
    }
    treePane.append(list);

    // Reordering while a filter hides rows would move things relative to rows
    // that aren't on screen, so drag is off until the search is cleared.
    if (!filtering && !saving) {
      attachTreeDrag(list, {
        maxDepth: MAX_DEPTH,
        depthNames: DEPTH_NAMES,
        isBusy: () => saving,
        getWorking: () => working,
        setWorking: (next) => { working = next; },
        nameOf: (id) => effective(id)?.name || '',
        onDrop: () => { paintTree(); paintDetail(); refreshToolbar(); },
      });
    }
  }

  function buildRow({ id, depth }, groups, { draggable }) {
    const cat = effective(id);
    if (!cat) return null;

    const items = itemsIn(cat);
    const threshold = parseNum(cat.min_threshold);
    const pool = groups.get(id);

    return el('div', {
      class: `cat-row depth-${depth}${id === selectedId ? ' is-selected' : ''}`,
      'data-id': id,
      'data-depth': String(depth),
      style: `--indent:${depth * INDENT_PX}px;${rowTint(cat.color_hex, depth)}`,
      onclick: (e) => {
        if (e.target.closest('input, button')) return;
        selectedId = id;
        // Only re-style the existing rows; repainting the tree here would
        // rebuild the node mid-click.
        for (const other of treePane.querySelectorAll('.cat-row')) {
          other.classList.toggle('is-selected', other.dataset.id === id);
        }
        paintDetail();
      },
    }, [
      draggable
        ? el('span', { class: 'drag-handle', text: '⠿', title: 'Drag to reorder or nest' })
        : el('span', { style: 'width:10px' }),
      categoryBadge(cat, depth === 0 ? 26 : 22, { onColour: depth === 0 }),
      el('span', { class: 'cat-name', text: cat.name || '(unnamed)' }),
      items.length
        ? el('span', {
            class: 'chip',
            title: `${items.length} item(s) here or in its subcategories`,
            text: String(items.length),
          })
        : null,
      // The pooled figure belongs on the category, because that's what it's a
      // statement about — not about any one item inside it.
      threshold > 0
        ? el('span', {
            class: `chip ${pool && pool.stock < threshold ? 'chip-danger' : 'chip-accent'}`,
            title: 'Everything in this category counts as one pool, whatever the brand.',
            text: `${fmtNumber(pool ? pool.stock : 0)} of ${fmtNumber(threshold)}`,
          })
        : null,
    ]);
  }

  // ---------- right pane ----------

  function paintDetail() {
    clear(detailPane);

    if (!selectedId || !repo.byId('Taxonomy', selectedId)) {
      selectedId = null;
      detailPane.append(el('div', { class: 'card detail-empty' }, [
        emptyState('👈', 'Select a category to edit it.'),
      ]));
      return;
    }

    const cat = effective(selectedId);
    const id = selectedId;
    const stored = repo.byId('Taxonomy', id);
    const items = itemsIn(cat);
    const parent = cat.parent_id ? effective(cat.parent_id) : null;

    // Every control writes to the buffer and repaints the row in place, so the
    // colour or icon you just chose is visible in the tree immediately without
    // anything being written to the sheet.
    const set = (key, value) => {
      const next = { ...(edits.get(id) || {}) };
      if (String(value ?? '') === String(stored[key] ?? '')) delete next[key];
      else next[key] = value;

      if (Object.keys(next).length) edits.set(id, next);
      else edits.delete(id);

      paintTree();
      refreshToolbar();
      persistWorking();
    };

    const groups = buildGroups(repo.rows('Inventory'), effectiveCategories());
    const pool = groups.get(id);
    const threshold = parseNum(cat.min_threshold);

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
        el('div', { class: 'pane-title', text: `${items.length} item(s)` }),
        items.length
          ? el('div', {}, items.slice(0, 12).map((i) => el('div', { class: 'mini-row' }, [
              el('div', { style: 'flex:1;min-width:0' }, [
                el('div', { class: 'mini-title', text: i.item_name || '(unnamed)' }),
                el('div', {
                  class: 'mini-sub',
                  text: [i.brand, i.variant_size].filter(Boolean).join(' · '),
                }),
              ]),
              el('span', {
                class: 'chip',
                text: `${fmtNumber(parseNum(i.current_stock))} ${i.unit || ''}`.trim(),
              }),
            ])))
          : el('div', { class: 'hint', text: 'Nothing filed here yet.' }),
        items.length > 12
          ? el('div', { class: 'hint', text: `…and ${items.length - 12} more.` })
          : null,
      ]),

      el('div', { class: 'detail-actions' }, [
        el('button', {
          class: 'btn btn-ghost btn-danger',
          text: 'Delete category',
          onclick: () => withFlush(() => remove(stored)),
        }),
      ]),
    ]));
  }

  // ---------- saving ----------

  async function save() {
    const rows = dirtyRows();
    if (!rows.length || saving) return;

    // Renaming re-points the items filed under the old name, because items
    // reference categories by name — a bare rename would orphan all of them.
    const renamed = rows
      .map((row) => {
        const before = repo.byId('Taxonomy', row.id)?.name ?? '';
        return before !== row.name ? { before, after: row.name } : null;
      })
      .filter(Boolean);

    // Two categories ending up with the same name would make item rows
    // ambiguous, since that's the only thing they reference.
    const seen = new Set();
    for (const row of rows) {
      const key = String(row.name || '').trim().toLowerCase();
      if (!key) return toast('A category needs a name', { error: true });
      if (seen.has(key)) return toast(`Two categories are both called "${row.name}"`, { error: true });
      seen.add(key);
    }
    for (const other of taxonomy.list(KIND)) {
      if (rows.some((r) => r.id === other.id)) continue;
      if (seen.has(other.name.trim().toLowerCase())) {
        return toast(`"${other.name}" already exists`, { error: true });
      }
    }

    saving = true;
    refreshToolbar();
    try {
      await repo.saveMany('Taxonomy', rows);

      if (renamed.length) {
        const byOld = new Map(renamed.map((r) => [r.before.trim().toLowerCase(), r.after]));
        const affected = repo.rows('Inventory')
          .filter((i) => byOld.has(String(i.category || '').trim().toLowerCase()))
          .map((i) => ({ ...i, category: byOld.get(String(i.category).trim().toLowerCase()) }));
        if (affected.length) {
          await repo.saveMany('Inventory', affected);
          toast(`Saved — ${affected.length} item(s) re-filed`);
        } else toast('Saved');
      } else toast('Saved');

      syncWorking();
      localStorage.removeItem(PENDING_KEY);
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      saving = false;
      paintAll();
    }
  }

  /** Writes any pending work before an action that reads live rows. */
  async function withFlush(action) {
    if (isDirty()) await save();
    action();
  }

  // ---------- create / delete ----------

  function openCreate() {
    let name = '';
    let parentId = '';

    openModal({
      title: 'New category',
      render: (body) => {
        body.append(field('Name', el('input', {
          class: 'input',
          type: 'text',
          placeholder: 'Cleaning, Toothbrush…',
          oninput: (e) => { name = e.target.value; },
        }), { required: true }));

        body.append(field('Inside', el('select', {
          class: 'select',
          onchange: (e) => { parentId = e.target.value; },
        }, [
          el('option', { value: '', text: '— top level —' }),
          // Only parents: the tree is two deep, so a subcategory can't take
          // children of its own.
          ...taxonomy.roots(KIND).map((t) => el('option', { value: t.id, text: t.name })),
        ]), { hint: 'You can drag it somewhere else afterwards.' }));
      },
      actions: (close) => {
        const btn = el('button', { class: 'btn', text: 'Add' });
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            // Written straight away rather than buffered: it needs a row in the
            // sheet before there's an id to hang buffered edits on. Its icon,
            // colour and threshold are then edited in the right-hand pane like
            // anything else.
            const created = await taxonomy.create(KIND, { name, parent_id: parentId });
            close();
            syncWorking();
            selectedId = created.id;
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

  async function remove(entry) {
    const children = taxonomy.childrenOf(KIND, entry.id);
    if (children.length) {
      toast(`Move the ${children.length} category inside it out first`, { error: true });
      return;
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
      toast('Deleted');
      if (selectedId === entry.id) selectedId = null;
      syncWorking();
      paintAll();
    } catch (e) {
      toast(e.message, { error: true });
    }
  }

  // ---------- helpers ----------

  /** Items filed here or in any subcategory, by the buffered names. */
  function itemsIn(entry) {
    const names = new Set(
      taxonomy.withDescendants(KIND, entry)
        .map((t) => (effective(t.id)?.name || t.name).trim().toLowerCase()),
    );
    // The stored name counts too: until Save runs, items still carry it.
    names.add(String(repo.byId('Taxonomy', entry.id)?.name || '').trim().toLowerCase());
    names.delete('');

    return repo.rows('Inventory')
      .filter((i) => names.has(String(i.category || '').trim().toLowerCase()));
  }

  syncWorking();
  if (restoreWorking()) toast('Restored unsaved category changes');
  paintAll();
}

function bySortOrder(a, b) {
  const d = parseNum(a.sort_order) - parseNum(b.sort_order);
  return d !== 0 ? d : (a.name || '').localeCompare(b.name || '');
}
