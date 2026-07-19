// The inventory category tree: "Cleaning" > "Sponge", "Detergent".
//
// Deliberately the same screen as expense categories, down to the drag and the
// colour-filled top-level rows — the shared parts live in cattree.js. Two
// category editors that behaved differently would be two things to learn, and
// this is the one you sit in front of while sorting out a shelf.
//
// What it adds over the expense tree is the "keep at least" number. Putting
// that on a category is what makes "two toothbrushes, whichever brand" work:
// everything inside is counted as one pool, so the requirement belongs to the
// category rather than to any one brand's row. See stock.js.
//
// Structural edits are BUFFERED, same as expenses: dragging and renaming
// mutate a working copy and nothing is written until Save, so a session of
// twenty drags costs one batch instead of twenty.

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { parseNum } from '../schema.js';
import { iconPicker, colourPicker } from './pickers.js';
import {
  INDENT_PX, attachTreeDrag, deriveTree, categoryBadge, rowTint, normaliseHex,
} from './cattree.js';
import { buildGroups } from '../stock.js';
import {
  el, clear, toast, openModal, confirmDialog, emptyState, fmtNumber,
} from '../ui.js';

const KIND = taxonomy.KIND_INVENTORY_CATEGORY;
const MAX_DEPTH = 1; // parent > sub. Stock doesn't need a third level.
const DEPTH_NAMES = ['category', 'subcategory'];
const PENDING_KEY = 'sufyam.invcat.pending';

export function renderInventoryCategories(container, { onBack } = {}) {
  let query = '';
  let saving = false;
  let working = [];        // [{ id, depth }]
  let renames = new Map(); // id -> new name

  const treePane = el('div', { class: 'pane' });

  // ---------- model ----------

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
    renames = new Map();
  }

  const derive = () => deriveTree(working, MAX_DEPTH);

  /** Rows whose buffered state differs from what's in the sheet. */
  function dirtyRows() {
    const derived = derive();
    const out = [];
    for (const [id, want] of derived) {
      const cat = repo.byId('Taxonomy', id);
      if (!cat) continue;
      const name = renames.get(id) ?? cat.name;
      if ((cat.parent_id || '') !== want.parent_id
        || parseNum(cat.sort_order) !== want.sort_order
        || name !== cat.name) {
        out.push({ ...cat, name, parent_id: want.parent_id, sort_order: want.sort_order });
      }
    }
    return out;
  }

  const isDirty = () => dirtyRows().length > 0;

  // Unsaved arrangement survives a reload, the same as the expense tree.
  // Restored only when every row in the buffer still exists — a row vanishing
  // means the arrangement no longer describes reality, and writing it would
  // put a guess over whatever the sheet now holds.
  function persistWorking() {
    if (!isDirty()) {
      localStorage.removeItem(PENDING_KEY);
      return;
    }
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ working, renames: [...renames] }));
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
    renames = new Map((stored.renames || []).filter(([id]) => liveIds.has(id)));
    return isDirty();
  }

  // ---------- painting ----------

  function paint() {
    clear(container);
    container.append(toolbar(), treePane);
    paintTree();
  }

  function toolbar() {
    const dirty = dirtyRows();
    return el('div', { class: 'toolbar' }, [
      onBack ? el('button', {
        class: 'btn btn-ghost',
        text: '← Back to stock',
        onclick: () => withUnsavedCheck(onBack),
      }) : null,
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
        onclick: () => { syncWorking(); persistWorking(); paint(); },
      }),
      el('button', {
        class: 'btn',
        text: saving ? 'Saving…' : 'Save',
        disabled: !dirty.length || saving,
        onclick: save,
      }),
      el('button', {
        class: 'btn',
        text: '+ New category',
        onclick: () => withFlush(() => openEditor({ parentId: '' })),
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
      ? flat.filter(({ id }) => nameOf(id).toLowerCase().includes(query))
      : flat;

    if (!visible.length) {
      treePane.append(emptyState(
        '🏷️',
        flat.length
          ? 'No categories match that.'
          : 'No categories yet. Add "Cleaning", then drag "Sponge" under it.',
        flat.length ? null : el('button', {
          class: 'btn',
          text: '+ New category',
          onclick: () => openEditor({ parentId: '' }),
        }),
      ));
      return;
    }

    const groups = buildGroups(repo.rows('Inventory'), taxonomy.list(KIND));
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
        nameOf,
        onDrop: () => { paintTree(); refreshToolbar(); },
      });
    }
  }

  function refreshToolbar() {
    const old = container.querySelector('.toolbar');
    if (old) old.replaceWith(toolbar());
  }

  function buildRow({ id, depth }, groups, { draggable }) {
    const cat = repo.byId('Taxonomy', id);
    if (!cat) return null;

    const name = renames.get(id) ?? cat.name ?? '';
    const items = itemsIn(cat);
    const threshold = parseNum(cat.min_threshold);
    const pool = groups.get(cat.id);

    const nameNode = el('span', { class: 'cat-name', text: name || '(unnamed)' });
    nameNode.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(nameNode, name, (value) => {
        renames.set(id, value);
        paintTree();
        refreshToolbar();
      });
    });

    return el('div', {
      class: `cat-row depth-${depth}`,
      'data-id': id,
      'data-depth': String(depth),
      style: `--indent:${depth * INDENT_PX}px;${rowTint(cat.color_hex, depth)}`,
    }, [
      draggable
        ? el('span', { class: 'drag-handle', text: '⠿', title: 'Drag to reorder or nest' })
        : el('span', { style: 'width:10px' }),
      categoryBadge(cat, depth === 0 ? 26 : 22, { onColour: depth === 0 }),
      nameNode,
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
      el('span', { style: 'flex:1' }),
      el('button', {
        class: 'btn btn-ghost btn-sm cat-action',
        text: 'Edit',
        onclick: (e) => { e.stopPropagation(); withFlush(() => openEditor({ entry: cat })); },
      }),
      el('button', {
        class: 'btn btn-danger btn-sm cat-action',
        text: '🗑',
        title: 'Delete',
        onclick: (e) => { e.stopPropagation(); withFlush(() => remove(cat)); },
      }),
    ]);
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
        } else {
          toast('Saved');
        }
      } else {
        toast('Saved');
      }

      syncWorking();
      localStorage.removeItem(PENDING_KEY);
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      saving = false;
      paint();
    }
  }

  /** Writes any pending arrangement before an action that reads live rows. */
  async function withFlush(action) {
    if (isDirty()) await save();
    action();
  }

  async function withUnsavedCheck(action) {
    if (!isDirty()) return action();
    const ok = await confirmDialog({
      title: 'Leave without saving?',
      message: 'Your rearrangement is kept on this device and will still be here '
        + 'when you come back, but it hasn\'t been written to the sheet.',
    });
    if (ok) action();
  }

  // ---------- editor ----------

  function openEditor({ entry = null, parentId = '' }) {
    const isEdit = Boolean(entry);
    const values = {
      name: entry?.name || '',
      icon_key: entry?.icon_key || '',
      color_hex: entry?.color_hex || '',
      min_threshold: entry ? parseNum(entry.min_threshold) : 0,
      parent_id: entry ? (entry.parent_id || '') : parentId,
    };
    const parent = values.parent_id ? taxonomy.byId(KIND, values.parent_id) : null;

    openModal({
      title: isEdit
        ? `Edit ${entry.name}`
        : (parent ? `New category in ${parent.name}` : 'New category'),
      render: (body) => {
        body.append(field('Name', el('input', {
          class: 'input',
          type: 'text',
          value: values.name,
          placeholder: parent ? 'Sponge, Detergent…' : 'Cleaning, Toiletries…',
          oninput: (e) => { values.name = e.target.value; },
        }), { required: true }));

        body.append(field('Icon', iconPicker(values.icon_key, (v) => { values.icon_key = v; })));
        body.append(field('Colour', colourPicker(values.color_hex, (v) => { values.color_hex = v; })));

        body.append(field('Keep at least', el('input', {
          class: 'input',
          type: 'number',
          min: '0',
          value: String(values.min_threshold || ''),
          placeholder: '0',
          oninput: (e) => { values.min_threshold = parseNum(e.target.value); },
        }), {
          hint: 'Counts everything in this category together, whatever the brand. '
            + 'Set 2 on "Toothbrush" and one spare of each of two brands is enough. '
            + 'Leave at 0 to judge each item on its own.',
        }));

        if (!isEdit) {
          body.append(el('p', {
            class: 'hint',
            text: 'New categories start at the top level. Drag them onto a parent afterwards.',
          }));
        }
      },
      actions: (close) => {
        const btn = el('button', { class: 'btn', text: isEdit ? 'Save' : 'Add' });
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            if (isEdit) {
              const moved = await taxonomy.updateCategory(entry, {
                name: values.name,
                icon_key: values.icon_key,
                color_hex: values.color_hex,
                min_threshold: values.min_threshold,
              });
              toast(moved ? `Saved — ${moved} item(s) re-filed` : 'Saved');
            } else {
              await taxonomy.create(KIND, {
                name: values.name,
                icon_key: values.icon_key,
                color_hex: values.color_hex,
                min_threshold: values.min_threshold,
                parent_id: values.parent_id,
              });
              toast('Added');
            }
            close();
            syncWorking();
            paint();
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
      syncWorking();
      paint();
    } catch (e) {
      toast(e.message, { error: true });
    }
  }

  // ---------- helpers ----------

  function nameOf(id) {
    return renames.get(id) ?? repo.byId('Taxonomy', id)?.name ?? '';
  }

  /** Items filed here or in any subcategory. */
  function itemsIn(entry) {
    const names = new Set(
      taxonomy.withDescendants(KIND, entry).map((t) => t.name.trim().toLowerCase()),
    );
    return repo.rows('Inventory')
      .filter((i) => names.has(String(i.category || '').trim().toLowerCase()));
  }

  syncWorking();
  if (restoreWorking()) toast('Restored unsaved category changes');
  paint();
}

function bySortOrder(a, b) {
  const d = parseNum(a.sort_order) - parseNum(b.sort_order);
  return d !== 0 ? d : (a.name || '').localeCompare(b.name || '');
}

function field(label, control, { required = false, hint = '' } = {}) {
  return el('div', { class: 'field' }, [
    el('label', { text: label + (required ? ' *' : '') }),
    control,
    hint ? el('div', { class: 'hint', text: hint }) : null,
  ]);
}

/** Double-click a name to edit it in place; Enter commits, Escape cancels. */
function startInlineRename(node, current, commit) {
  const input = el('input', {
    class: 'input',
    type: 'text',
    value: current,
    style: 'max-width:220px;padding:4px 8px',
  });
  node.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener('click', (e) => e.stopPropagation());

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== current) commit(value);
    else input.replaceWith(node);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}
