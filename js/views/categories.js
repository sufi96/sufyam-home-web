// Categories: tree editor on the left, transactions of the selected category
// on the right.
//
// The tree is up to MAX_DEPTH levels deep — category > subcategory >
// sub-subcategory — ordered by `sort_order` within each parent.
//
// Structural edits are BUFFERED. Dragging and renaming mutate a local working
// copy and mark the view dirty; nothing is written until Save. A session of
// twenty drags then costs one batch (2 API calls) instead of twenty batches,
// which is what kept tripping Google's per-minute write quota. Destructive or
// modal actions flush the buffer first so they never operate on stale rows.
//
// Drag uses pointer events rather than HTML5 drag-and-drop: native DnD gives
// no control over the drop position mid-gesture, so rows can't be animated out
// of the way. Depth comes from horizontal position, the way outliners do it.

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { needsInteractiveAuth, signIn } from '../auth.js';
import { parseNum } from '../schema.js';
import { iconEl, isKnownIcon } from '../icons.js';
import { iconPicker, labelPicker } from './pickers.js';
import {
  INDENT_PX, attachTreeDrag, deriveTree, categoryBadge, rowTint, normaliseHex,
} from './cattree.js';
import {
  el, clear, toast, openModal, confirmDialog, emptyState,
  fmtMoney, fmtDate, fmtDateTime, toDateTimeInput,
} from '../ui.js';

const TYPES = [
  { key: 'expense', label: 'Expense' },
  { key: 'income', label: 'Income' },
];

const MAX_DEPTH = 2;
const DEPTH_NAMES = ['category', 'subcategory', 'sub-subcategory'];

export function renderCategories(container) {
  // No expense/income filter: this household only tracks spending, and hiding
  // rows behind a tab meant a mistyped `type` made a category vanish.
  let query = '';
  let saving = false;
  let selectedId = null;
  let rollUp = true; // include descendants' transactions in the right pane
  let sortKey = localStorage.getItem('sufyam.txn.sort') || 'date';
  let sortDir = localStorage.getItem('sufyam.txn.dir') || 'desc';
  const picked = new Set();   // checked transaction ids
  let lastPickedIndex = -1;   // anchor for shift-click ranges

  // Buffered edits: the tree as the user has arranged it, plus renames.
  let working = [];              // [{ id, depth }]
  let renames = new Map();       // id -> new name

  const treePane = el('div', { class: 'pane' });
  const detailPane = el('div', { class: 'pane' });

  // Unsaved arrangement survives a reload. Without this, anything that
  // interrupts a save — a blocked popup, a dropped connection, an accidental
  // refresh — meant redoing the whole rearrangement from scratch.
  const PENDING_KEY = 'sufyam.cat.pending';

  function persistWorking() {
    if (!isDirty()) {
      localStorage.removeItem(PENDING_KEY);
      return;
    }
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        working,
        renames: [...renames],
        savedAt: Date.now(),
      }));
    } catch {
      // Storage unavailable; the in-memory buffer still works this session.
    }
  }

  /** Restores a buffer only if every row in it still exists in the sheet. */
  function restoreWorking() {
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    } catch {
      return false;
    }
    if (!stored?.working?.length) return false;

    const liveIds = new Set(repo.rows('Categories').map((c) => c.id));
    const kept = stored.working.filter((w) => liveIds.has(w.id));
    // A row vanishing (deleted on the phone, say) means the arrangement no
    // longer describes reality — safer to drop the buffer than to write a
    // guess over whatever the sheet now holds.
    if (kept.length !== stored.working.length) {
      localStorage.removeItem(PENDING_KEY);
      return false;
    }
    const missing = [...liveIds].filter((id) => !kept.some((w) => w.id === id));
    if (missing.length) {
      localStorage.removeItem(PENDING_KEY);
      return false;
    }

    working = kept;
    renames = new Map((stored.renames || []).filter(([id]) => liveIds.has(id)));
    return isDirty();
  }

  // Note: this does NOT clear the stored buffer — restoreWorking() runs after
  // it during startup and would find nothing left to restore. persistWorking()
  // drops the key on the next repaint once nothing is dirty.
  function syncWorking() {
    working = buildTree().flat.map(({ cat, depth }) => ({ id: cat.id, depth }));
    renames = new Map();
  }

  // ---------- model ----------

  function buildTree() {
    const ofType = repo.rows('Categories');
    const live = new Map(ofType.map((c) => [c.id, c]));
    const kids = new Map();
    for (const cat of ofType) {
      const key = cat.parent_id && live.has(cat.parent_id) ? cat.parent_id : '';
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(cat);
    }
    for (const list of kids.values()) list.sort(bySortOrder);

    const orphans = ofType.filter((c) => c.parent_id && !live.has(c.parent_id));
    const orphanIds = new Set(orphans.map((c) => c.id));

    const flat = [];
    const walk = (parentId, depth) => {
      for (const cat of kids.get(parentId) || []) {
        if (orphanIds.has(cat.id)) continue;
        flat.push({ cat, depth });
        if (depth < MAX_DEPTH) walk(cat.id, depth + 1);
      }
    };
    walk('', 0);
    return { flat, orphans };
  }

  /** parent_id + sort_order implied by the current working order. */
  function derive() {
    return deriveTree(working, MAX_DEPTH);
  }

  /** Rows whose buffered state differs from what's in the sheet. */
  function dirtyRows() {
    const derived = derive();
    const out = [];
    for (const [id, d] of derived) {
      const cat = repo.byId('Categories', id);
      if (!cat) continue;
      const name = renames.has(id) ? renames.get(id) : cat.name;
      if ((cat.parent_id || '') !== d.parent_id
        || parseNum(cat.sort_order) !== d.sort_order
        || (cat.name || '') !== name) {
        out.push({ ...cat, parent_id: d.parent_id, sort_order: d.sort_order, name });
      }
    }
    return out;
  }

  const isDirty = () => dirtyRows().length > 0;

  async function flush() {
    const dirty = dirtyRows();
    if (!dirty.length) return true;

    // Google's sign-in popup must be opened while the browser still regards
    // the triggering click as user activation. Discovering an expired token
    // *inside* the save — after the first await — means the popup opens
    // unattached to a gesture and gets blocked, which is what made saves fail
    // and left the buffer stranded.
    if (needsInteractiveAuth()) {
      try {
        await signIn();
      } catch {
        toast('Sign-in needed before saving — click Save again', { error: true });
        return false;
      }
    }

    saving = true;
    paintTree();
    try {
      await repo.saveMany('Categories', dirty);
      toast(`Saved — ${dirty.length} categor${dirty.length === 1 ? 'y' : 'ies'} updated`);
      syncWorking();
      return true;
    } catch (err) {
      // The buffer is deliberately left intact so a failed save can simply be
      // retried; nothing the user arranged is thrown away.
      toast(`${err.message} — your changes are still here, try Save again`, { error: true });
      return false;
    } finally {
      saving = false;
      paintAll();
    }
  }

  /** Buffered edits must not linger across a modal or a delete. */
  async function withFlush(fn) {
    if (isDirty() && !(await flush())) return;
    fn();
  }

  // ---------- painting ----------

  function paintAll() { paintTree(); paintDetail(); }

  function paint() {
    clear(container);
    container.append(el('div', { class: 'cat-split' }, [treePane, detailPane]));
    paintAll();
  }

  function paintTree() {
    clear(treePane);
    const { orphans } = buildTree();
    const derived = derive();
    const usage = usageCounts();
    const filtering = Boolean(query);
    const dirty = dirtyRows();

    persistWorking();

    treePane.append(el('div', { class: 'toolbar' }, [
      el('span', { class: 'pane-title', text: 'Categories' }),
      el('input', {
        class: 'input search',
        type: 'search',
        placeholder: 'Search categories…',
        value: query,
        oninput: (e) => { query = e.target.value.toLowerCase(); paintTree(); },
      }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm',
        text: '+ New',
        onclick: () => withFlush(() => openCategoryForm({}, afterWrite)),
      }),
    ]));

    // Save bar only exists when there is something to save.
    if (dirty.length) {
      treePane.append(el('div', { class: 'save-bar' }, [
        el('span', { class: 'save-dot' }),
        el('span', {
          class: 'save-text',
          text: `${dirty.length} unsaved change${dirty.length === 1 ? '' : 's'}`,
        }),
        el('div', { style: 'flex:1' }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          text: 'Discard',
          disabled: saving || null,
          onclick: () => { syncWorking(); paintAll(); toast('Changes discarded'); },
        }),
        el('button', {
          class: 'btn btn-sm',
          text: saving ? 'Saving…' : 'Save',
          disabled: saving || null,
          onclick: flush,
        }),
      ]));
    }

    if (orphans.length) treePane.append(buildOrphanCard(orphans, usage));

    treePane.append(el('div', {
      class: 'list-hint',
      text: filtering
        ? 'Clear the search to reorder — dragging is disabled while filtering.'
        : '⠿ Drag to reorder, right to nest. Click to see transactions, double-click to rename.',
    }));

    const matchesQuery = (id) => {
      const cat = repo.byId('Categories', id);
      const name = renames.get(id) ?? cat?.name ?? '';
      return name.toLowerCase().includes(query);
    };

    const visible = filtering
      ? working.filter(({ id, depth }, i) => {
          if (matchesQuery(id)) return true;
          for (let j = i + 1; j < working.length && working[j].depth > depth; j++) {
            if (matchesQuery(working[j].id)) return true;
          }
          return false;
        })
      : working;

    if (!visible.length) {
      treePane.append(emptyState(
        '🏷',
        working.length ? 'No categories match.' : 'No categories yet.',
        el('button', {
          class: 'btn',
          text: '+ New category',
          onclick: () => openCategoryForm({}, afterWrite),
        }),
      ));
      return;
    }

    const list = el('div', { class: 'cat-list' });
    for (const item of visible) {
      const row = buildRow(item, derived, usage, { draggable: !filtering });
      if (row) list.append(row);
    }
    treePane.append(list);
    if (!filtering && !saving) attachDrag(list);
  }

  function buildRow({ id, depth }, derived, usage, { draggable }) {
    const cat = repo.byId('Categories', id);
    if (!cat) return null;
    const shownDepth = derived.get(id)?.depth ?? depth;
    const name = renames.get(id) ?? cat.name ?? '';
    const count = descendantIds(id).reduce((n, cid) => n + (usage.get(cid) || 0), 0);
    const own = usage.get(id) || 0;

    const nameNode = el('span', { class: 'cat-name', text: name || '(unnamed)' });
    nameNode.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(nameNode, id, name, (value) => {
        renames.set(id, value);
        paintTree();
      });
    });

    const tint = rowTint(cat.color_hex, shownDepth);

    const row = el('div', {
      class: `cat-row depth-${shownDepth}${id === selectedId ? ' is-selected' : ''}`,
      'data-id': id,
      'data-depth': String(shownDepth),
      style: `--indent:${shownDepth * INDENT_PX}px;${tint}`,
      // Selection only re-styles the existing rows. Repainting the tree here
      // would replace this node between the two clicks of a double-click, so
      // the dblclick-to-rename listener would never fire.
      onclick: (e) => {
        if (e.target.closest('input, button')) return;
        if (selectedId !== id) { picked.clear(); lastPickedIndex = -1; }
        selectedId = id;
        for (const other of treePane.querySelectorAll('.cat-row')) {
          other.classList.toggle('is-selected', other.dataset.id === id);
        }
        paintDetail();
      },
    }, [
      draggable
        ? el('span', { class: 'drag-handle', text: '⠿', title: 'Drag to reorder' })
        : el('span', { style: 'width:10px' }),
      categoryBadge(cat, shownDepth === 0 ? 26 : 22, { onColour: shownDepth === 0 }),
      nameNode,
      count ? el('span', {
        class: 'chip',
        title: own === count ? `${own} transactions` : `${own} directly, ${count} including subcategories`,
        text: String(count),
      }) : null,
      el('span', { style: 'flex:1' }),
      el('button', {
        class: 'btn btn-ghost btn-sm cat-action',
        text: 'Edit',
        onclick: (e) => { e.stopPropagation(); withFlush(() => openCategoryForm(cat, afterWrite)); },
      }),
      el('button', {
        class: 'btn btn-danger btn-sm cat-action',
        text: '🗑',
        title: 'Delete',
        onclick: (e) => { e.stopPropagation(); withFlush(() => deleteCategory(cat, own, afterWrite)); },
      }),
    ]);
    return row;
  }

  function afterWrite() {
    syncWorking();
    paintAll();
  }

  // ---------- right pane ----------

  function paintDetail() {
    clear(detailPane);

    if (!selectedId) {
      detailPane.append(sortToolbar(0, { disabled: true }));
      detailPane.append(el('div', { class: 'card detail-empty' }, [
        emptyState('👈', 'Select a category to see its transactions.'),
      ]));
      return;
    }

    const cat = repo.byId('Categories', selectedId);
    if (!cat) {
      selectedId = null;
      return paintDetail();
    }

    const ids = rollUp ? descendantIds(selectedId) : [selectedId];
    const idSet = new Set(ids);
    const dir = sortDir === 'asc' ? 1 : -1;
    const txns = repo.rows('Transactions')
      .filter((t) => idSet.has(t.category_id))
      .sort((a, b) => (sortKey === 'amount'
        ? (parseNum(a.amount) - parseNum(b.amount)) * dir
        : String(a.transaction_date).localeCompare(String(b.transaction_date)) * dir));

    const total = txns.reduce((s, t) => s + parseNum(t.amount), 0);
    const hasChildren = descendantIds(selectedId).length > 1;

    detailPane.append(sortToolbar(txns.length));
    detailPane.append(el('div', { class: 'card detail-card' }, [
      el('div', { class: 'detail-head' }, [
        categoryBadge(cat, 36),
        el('div', { style: 'min-width:0;flex:1' }, [
          el('div', { class: 'detail-title', text: cat.name || '(unnamed)' }),
          el('div', { class: 'detail-crumb', text: breadcrumb(selectedId) }),
        ]),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          text: 'Edit category',
          onclick: () => withFlush(() => openCategoryForm(cat, afterWrite)),
        }),
      ]),

      el('div', { class: 'detail-stats' }, [
        el('div', {}, [
          el('div', { class: 'detail-stat-value', text: fmtMoney(total) }),
          el('div', { class: 'detail-stat-label', text: 'Total' }),
        ]),
        el('div', {}, [
          el('div', { class: 'detail-stat-value', text: String(txns.length) }),
          el('div', { class: 'detail-stat-label', text: 'Transactions' }),
        ]),
        el('div', {}, [
          el('div', {
            class: 'detail-stat-value',
            text: txns.length ? fmtMoney(total / txns.length) : '—',
          }),
          el('div', { class: 'detail-stat-label', text: 'Average' }),
        ]),
      ]),

      hasChildren
        ? el('label', { class: 'rollup-toggle' }, [
            el('input', {
              type: 'checkbox',
              checked: rollUp || null,
              onchange: (e) => { rollUp = e.target.checked; paintDetail(); },
            }),
            'Include subcategories',
          ])
        : null,

      txns.length ? buildBulkBar(txns) : null,

      txns.length
        ? el('label', { class: 'select-all' }, [
            el('input', {
              type: 'checkbox',
              checked: picked.size === txns.length || null,
              onchange: (e) => {
                if (e.target.checked) txns.forEach((t) => picked.add(t.id));
                else picked.clear();
                paintDetail();
              },
            }),
            picked.size ? `${picked.size} of ${txns.length} selected` : 'Select all',
          ])
        : null,

      txns.length
        ? el('div', { class: 'txn-list' }, txns.map((t, i) => buildTxnRow(t, cat, i, txns)))
        : emptyState('📭', rollUp && hasChildren
          ? 'No transactions in this category or its subcategories.'
          : 'No transactions in this category.'),
    ]));
  }

  // ---------- bulk selection ----------

  /**
   * Bulk actions over the checked transactions. Each goes through
   * repo.saveMany(), so re-categorising fifty rows is two API calls rather
   * than a hundred — which is what makes repairing imported data practical.
   */
  function buildBulkBar(txns) {
    const chosen = txns.filter((t) => picked.has(t.id));
    if (!chosen.length) return null;
    const total = chosen.reduce((s, t) => s + parseNum(t.amount), 0);

    const run = async (fn) => {
      try {
        await fn();
        picked.clear();
        afterWrite();
      } catch (err) {
        toast(err.message, { error: true });
      }
    };

    return el('div', { class: 'bulk-bar' }, [
      el('span', { class: 'bulk-count', text: String(chosen.length) }),
      el('span', { class: 'bulk-text', text: `selected · ${fmtMoney(total)}` }),
      el('div', { style: 'flex:1' }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Move to…',
        onclick: () => openBulkCategory(chosen, run),
      }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: 'Labels…',
        onclick: () => openBulkLabels(chosen, run),
      }),
      el('button', {
        class: 'btn btn-danger btn-sm',
        text: 'Delete',
        onclick: async () => {
          const ok = await confirmDialog({
            title: `Delete ${chosen.length} transaction${chosen.length === 1 ? '' : 's'}?`,
            message: `${fmtMoney(total)} across ${chosen.length} row`
              + `${chosen.length === 1 ? '' : 's'} will be marked deleted.`,
            note: 'Nothing is erased — the rows stay in the sheet and can be restored.',
            confirmLabel: 'Delete them',
          });
          if (!ok) return;
          run(() => repo.saveMany('Transactions',
            chosen.map((t) => ({ ...t, is_deleted: true }))));
        },
      }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: 'Clear',
        onclick: () => { picked.clear(); paintDetail(); },
      }),
    ]);
  }

  function openBulkCategory(chosen, run) {
    let target = '';
    const select = el('select', { class: 'select', onchange: (e) => { target = e.target.value; } });
    select.append(el('option', { value: '', text: '— choose a category —' }));
    for (const { cat, depth } of buildTree().flat) {
      select.append(el('option', {
        value: cat.id,
        text: `${'　'.repeat(depth)}${depth ? '↳ ' : ''}${cat.name || cat.id}`,
      }));
    }

    openModal({
      title: `Move ${chosen.length} transaction${chosen.length === 1 ? '' : 's'}`,
      icon: '📁',
      render: (body) => {
        body.append(field('Move to', select, {
          hint: 'Every selected transaction is re-pointed at this category.',
        }));
        body.append(el('div', { class: 'bulk-preview' },
          chosen.slice(0, 6).map((t) => el('div', { class: 'bulk-preview-row' }, [
            el('span', { class: 'bulk-preview-amount', text: fmtMoney(t.amount) }),
            el('span', { class: 'bulk-preview-note', text: t.notes || 'No note' }),
          ]))));
        if (chosen.length > 6) {
          body.append(el('div', { class: 'hint', text: `…and ${chosen.length - 6} more` }));
        }
      },
      actions: (close) => {
        const go = el('button', { class: 'btn', text: 'Move them' });
        go.addEventListener('click', () => {
          if (!target) { toast('Pick a category first', { error: true }); return; }
          close();
          run(async () => {
            await repo.saveMany('Transactions',
              chosen.map((t) => ({ ...t, category_id: target })));
            toast(`Moved ${chosen.length} transaction${chosen.length === 1 ? '' : 's'}`);
          });
        });
        return [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), go];
      },
    });
  }

  function openBulkLabels(chosen, run) {
    let adding = [];
    const removing = new Set();

    const present = new Map();
    for (const t of chosen) {
      for (const raw of String(t.labels || '').split('|')) {
        const name = raw.trim();
        if (name) present.set(name, (present.get(name) || 0) + 1);
      }
    }

    openModal({
      title: `Labels on ${chosen.length} transaction${chosen.length === 1 ? '' : 's'}`,
      icon: '🏷',
      render: (body) => {
        body.append(field('Add these labels', labelPicker('', (names) => { adding = names; }), {
          hint: 'Added to every selected transaction, keeping labels they already have.',
        }));

        if (present.size) {
          body.append(field('Remove existing labels', el('div', { class: 'label-chips' },
            [...present.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([name, n]) => el('button', {
                type: 'button',
                class: 'label-chip',
                onclick: (e) => {
                  const on = removing.has(name);
                  if (on) removing.delete(name); else removing.add(name);
                  e.currentTarget.classList.toggle('is-removing', !on);
                },
              }, [name, el('span', { class: 'label-chip-count', text: String(n) })])),
          ), { hint: 'Click a label to mark it for removal.' }));
        }
      },
      actions: (close) => {
        const go = el('button', { class: 'btn', text: 'Apply' });
        go.addEventListener('click', () => {
          if (!adding.length && !removing.size) {
            toast('Nothing to add or remove', { error: true });
            return;
          }
          close();
          run(async () => {
            const updates = chosen.map((t) => {
              const current = String(t.labels || '').split('|')
                .map((x) => x.trim()).filter(Boolean);
              const kept = current.filter((x) => !removing.has(x));
              return { ...t, labels: [...new Set([...kept, ...adding])].join('|') };
            });
            await repo.saveMany('Transactions', updates);
            await taxonomy.ensure(taxonomy.KIND_LABEL, adding);
            toast(`Updated labels on ${chosen.length} transaction${chosen.length === 1 ? '' : 's'}`);
          });
        });
        return [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), go];
      },
    });
  }

  /** Sort controls, sized to line up with the tree toolbar opposite it. */
  function sortToolbar(count, { disabled = false } = {}) {
    const button = (key, label) => el('button', {
      class: `segmented-btn${sortKey === key ? ' is-active' : ''}`,
      disabled: disabled || null,
      onclick: () => {
        if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortKey = key; sortDir = 'desc'; }
        localStorage.setItem('sufyam.txn.sort', sortKey);
        localStorage.setItem('sufyam.txn.dir', sortDir);
        paintDetail();
      },
    }, [
      label,
      sortKey === key
        ? el('span', { class: 'sort-arrow', text: sortDir === 'asc' ? '↑' : '↓' })
        : null,
    ]);

    return el('div', { class: 'toolbar' }, [
      el('span', { class: 'pane-title', text: 'Transactions' }),
      count ? el('span', { class: 'pane-count', text: String(count) }) : null,
      el('div', { class: 'spacer' }),
      el('span', { class: 'sort-label', text: 'Sort' }),
      el('div', { class: 'segmented' }, [button('date', 'Date'), button('amount', 'Amount')]),
    ]);
  }

  /**
   * Transaction row: amount and date lead, because those are what you scan
   * for. The note is secondary, and the parent category is visually distinct
   * from labels — merging them made it unclear which was which.
   */
  function buildTxnRow(txn, selectedCat, index, allTxns) {
    const cat = repo.byId('Categories', txn.category_id);
    const labels = String(txn.labels || '').split('|').map((s) => s.trim()).filter(Boolean);
    const foreign = cat && cat.id !== selectedCat.id;
    const isPicked = picked.has(txn.id);

    const toggle = (e) => {
      // Shift extends from the last checkbox touched, so a run of rows to
      // repair can be grabbed in two clicks instead of twenty.
      if (e.shiftKey && lastPickedIndex >= 0) {
        const [from, to] = [lastPickedIndex, index].sort((a, b) => a - b);
        for (let i = from; i <= to; i++) picked.add(allTxns[i].id);
      } else if (isPicked) {
        picked.delete(txn.id);
      } else {
        picked.add(txn.id);
      }
      lastPickedIndex = index;
      paintDetail();
    };

    return el('div', {
      class: `txn-row${isPicked ? ' is-picked' : ''}`,
      onclick: (e) => {
        if (e.target.closest('.txn-check')) return;
        // Once a selection exists, plain clicks extend it rather than opening
        // a modal — otherwise multi-select is a constant misclick trap.
        if (picked.size) { toggle(e); return; }
        openTransaction(txn, afterWrite);
      },
    }, [
      el('label', { class: 'txn-check' }, [
        el('input', {
          type: 'checkbox',
          checked: isPicked || null,
          onclick: (e) => { e.stopPropagation(); toggle(e); },
        }),
      ]),
      el('div', { class: 'txn-lead' }, [
        el('div', { class: 'txn-amount', text: fmtMoney(txn.amount) }),
        el('div', { class: 'txn-date', text: fmtDate(txn.transaction_date) }),
      ]),
      el('div', { class: 'txn-body' }, [
        el('div', { class: 'txn-top' }, [
          foreign
            ? el('span', { class: 'txn-cat' }, [
                iconEl(cat.icon_key, { size: 13 }),
                cat.name || '',
              ])
            : null,
          txn.notes
            ? el('span', { class: 'txn-note', text: txn.notes })
            : el('span', { class: 'txn-note is-empty', text: 'No note' }),
        ]),
        labels.length
          ? el('div', { class: 'txn-labels' }, labels.map((l) => el('span', {
              class: 'chip chip-label',
              text: l,
            })))
          : null,
      ]),
      el('span', { class: 'micon txn-chevron', text: 'chevron_right' }),
    ]);
  }

  /** Coloured icon badge used everywhere a category is shown. */
  // ---------- orphans ----------

  function buildOrphanCard(orphans, usage) {
    return el('div', { class: 'card orphan-card' }, [
      el('div', { class: 'orphan-head' }, [
        el('span', { class: 'orphan-icon', text: '⚠' }),
        el('div', {}, [
          el('div', {
            class: 'orphan-title',
            text: `${orphans.length} categor${orphans.length === 1 ? 'y is' : 'ies are'} orphaned`,
          }),
          el('div', {
            class: 'orphan-sub',
            text: 'Their parent was deleted, so they no longer appear in the tree. '
              + 'Pick where each belongs — their transactions are untouched.',
          }),
        ]),
      ]),
      ...orphans.map((cat) => buildOrphanRow(cat, usage)),
    ]);
  }

  function buildOrphanRow(cat, usage) {
    const count = usage.get(cat.id) || 0;
    const select = el('select', { class: 'select', style: 'max-width:200px' });
    select.append(el('option', { value: '', text: '— top-level category —' }));
    for (const { cat: candidate, depth } of buildTree().flat) {
      if (candidate.id === cat.id || depth >= MAX_DEPTH) continue;
      select.append(el('option', {
        value: candidate.id,
        text: `${'　'.repeat(depth)}${depth ? '↳ ' : ''}${candidate.name || candidate.id}`,
      }));
    }

    return el('div', { class: 'orphan-row' }, [
      el('span', { class: 'cat-dot', style: `background:${normaliseHex(cat.color_hex) || 'var(--border)'}` }),
      el('span', { style: 'font-weight:550', text: cat.name || '(unnamed)' }),
      count ? el('span', { class: 'chip', text: `${count} txn` }) : null,
      el('span', { style: 'flex:1' }),
      select,
      el('button', {
        class: 'btn btn-sm',
        text: 'Move here',
        onclick: async (e) => {
          const btn = e.target;
          btn.disabled = true;
          btn.textContent = 'Moving…';
          try {
            await repo.save('Categories', {
              ...cat,
              parent_id: select.value,
              sort_order: nextSortOrder(select.value),
            });
            toast(`"${cat.name}" moved`);
            afterWrite();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Move here';
            toast(err.message, { error: true });
          }
        },
      }),
    ]);
  }

  // ---------- drag ----------

  function attachDrag(list) {
    attachTreeDrag(list, {
      maxDepth: MAX_DEPTH,
      depthNames: DEPTH_NAMES,
      isBusy: () => saving,
      getWorking: () => working,
      setWorking: (next) => { working = next; },
      nameOf: (id) => renames.get(id) ?? repo.byId('Categories', id)?.name ?? '',
      onDrop: paintTree,
    });
  }

  // ---------- helpers bound to this view ----------

  function descendantIds(id) {
    const out = [id];
    const walk = (parent) => {
      for (const c of repo.rows('Categories')) {
        if (c.parent_id === parent) { out.push(c.id); walk(c.id); }
      }
    };
    walk(id);
    return out;
  }

  function breadcrumb(id) {
    const parts = [];
    let cur = repo.byId('Categories', id);
    let guard = 0;
    while (cur && guard++ < 5) {
      parts.unshift(cur.name || '(unnamed)');
      cur = cur.parent_id ? repo.byId('Categories', cur.parent_id) : null;
    }
    parts.pop(); // the row itself is already the title
    return parts.length ? parts.join(' › ') : DEPTH_NAMES[0];
  }

  // Leaving the view with unsaved edits would silently lose them.
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  syncWorking();
  if (restoreWorking()) {
    toast('Restored unsaved category changes');
  }
  paint();
}

// ---------- transaction detail ----------

function openTransaction(txn, onSaved) {
  const values = {
    amount: txn.amount ?? '',
    category_id: txn.category_id || '',
    transaction_date: txn.transaction_date || '',
    notes: txn.notes || '',
    labels: txn.labels || '',
  };

  openModal({
    title: 'Transaction',
    icon: '💸',
    render: (body) => {
      const categorySelect = el('select', {
        class: 'select',
        onchange: (e) => { values.category_id = e.target.value; },
      });
      for (const type of TYPES) {
        const group = el('optgroup', { label: type.label });
        const ofType = repo.rows('Categories').filter((c) => (c.type || 'expense') === type.key);
        const live = new Map(ofType.map((c) => [c.id, c]));
        const walk = (parentId, depth) => {
          ofType
            .filter((c) => (c.parent_id && live.has(c.parent_id) ? c.parent_id : '') === parentId)
            .sort(bySortOrder)
            .forEach((c) => {
              group.append(el('option', {
                value: c.id,
                text: `${'　'.repeat(depth)}${depth ? '↳ ' : ''}${c.name || c.id}`,
                selected: values.category_id === c.id,
              }));
              if (depth < MAX_DEPTH) walk(c.id, depth + 1);
            });
        };
        walk('', 0);
        if (group.children.length) categorySelect.append(group);
      }

      body.append(
        el('div', { class: 'field-row' }, [
          field('Amount', el('input', {
            class: 'input',
            type: 'number',
            step: '0.01',
            value: String(values.amount),
            oninput: (e) => { values.amount = e.target.value; },
          })),
          field('Date & time', el('input', {
            class: 'input',
            type: 'datetime-local',
            value: toDateTimeInput(values.transaction_date),
            oninput: (e) => { values.transaction_date = e.target.value; },
          })),
        ]),
        field('Category', categorySelect, {
          hint: 'Move this transaction to any category, subcategory or sub-subcategory.',
        }),
        field('Labels', labelPicker(values.labels, (names) => {
          values.labels = names.join('|');
        })),
        field('Notes', el('textarea', {
          class: 'textarea',
          text: values.notes,
          placeholder: 'Optional',
          oninput: (e) => { values.notes = e.target.value; },
        })),
        el('div', { class: 'audit-note' }, [
          el('div', { text: `Created ${fmtDateTime(txn.created_at)} by ${txn.created_by || '—'}` }),
          el('div', { text: `Updated ${fmtDateTime(txn.updated_at)} by ${txn.updated_by || '—'}` }),
        ]),
      );
    },
    actions: (close) => {
      const del = el('button', {
        class: 'btn btn-danger btn-ghost',
        text: 'Delete',
        style: 'margin-right:auto',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Delete transaction?',
            message: `${fmtMoney(txn.amount)}${txn.notes ? ` — "${txn.notes}"` : ''} will be marked deleted.`,
            note: 'The row stays in the sheet and can be restored.',
            confirmLabel: 'Delete transaction',
          });
          if (!ok) return;
          try {
            await repo.remove('Transactions', txn.id);
            toast('Transaction deleted');
            close();
            onSaved?.();
          } catch (err) { toast(err.message, { error: true }); }
        },
      });

      const save = el('button', { class: 'btn', text: 'Save changes' });
      save.addEventListener('click', async () => {
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
          await repo.save('Transactions', {
            ...txn,
            amount: parseNum(values.amount),
            category_id: values.category_id,
            transaction_date: values.transaction_date
              ? new Date(values.transaction_date).toISOString()
              : txn.transaction_date,
            notes: values.notes,
            labels: String(values.labels || '')
              .split('|').map((s) => s.trim()).filter(Boolean).join('|'),
          });
          // Anything typed into the picker joins the shared data bank, so the
          // next transaction (and the phone) offers it as a choice.
          const banked = await taxonomy.ensure(
            taxonomy.KIND_LABEL,
            String(values.labels || '').split('|'),
          );
          toast(banked.length
            ? `Transaction saved · ${banked.length} new label${banked.length === 1 ? '' : 's'} banked`
            : 'Transaction saved');
          close();
          onSaved?.();
        } catch (err) {
          save.disabled = false;
          save.textContent = 'Save changes';
          toast(err.message, { error: true });
        }
      });

      return [del, el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), save];
    },
  });
}

// ---------- inline rename ----------

function startInlineRename(node, id, current, commit) {
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
  const finish = (ok) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (ok && value && value !== current) commit(value);
    else commit(current);
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

// ---------- category form ----------

function openCategoryForm(cat, onSaved) {
  const isEdit = Boolean(cat.id);
  const values = {
    name: cat.name || '',
    type: cat.type || 'expense',
    parent_id: cat.parent_id || '',
    color_hex: normaliseHex(cat.color_hex) || '#4caf50',
    icon_key: cat.icon_key || '',
  };
  const errorNode = el('div', { class: 'error hidden' });

  openModal({
    title: isEdit ? 'Edit category' : 'New category',
    icon: '🏷',
    render: (body) => {
      const hexInput = el('input', {
        class: 'input',
        type: 'text',
        value: values.color_hex,
        style: 'max-width:120px;font-variant-numeric:tabular-nums',
        oninput: (e) => { values.color_hex = e.target.value; },
      });
      const swatch = el('input', {
        type: 'color',
        class: 'colour-swatch',
        value: values.color_hex,
        oninput: (e) => { values.color_hex = e.target.value; hexInput.value = e.target.value; },
      });
      const parentSelect = el('select', {
        class: 'select',
        onchange: (e) => { values.parent_id = e.target.value; },
      });

      const descendants = new Set();
      const collect = (id) => {
        for (const c of repo.rows('Categories')) {
          if (c.parent_id === id && !descendants.has(c.id)) { descendants.add(c.id); collect(c.id); }
        }
      };
      if (isEdit) collect(cat.id);

      const rebuildParents = () => {
        clear(parentSelect);
        parentSelect.append(el('option', { value: '', text: '— top level —' }));
        const ofType = repo.rows('Categories');
        const live = new Map(ofType.map((c) => [c.id, c]));
        const inTree = ofType.filter((c) => !c.parent_id || live.has(c.parent_id));
        const walk = (parentId, depth) => {
          inTree.filter((c) => (c.parent_id || '') === parentId).sort(bySortOrder).forEach((c) => {
            if (c.id !== cat.id && !descendants.has(c.id) && depth < MAX_DEPTH) {
              parentSelect.append(el('option', {
                value: c.id,
                text: `${'　'.repeat(depth)}${depth ? '↳ ' : ''}${c.name || c.id}`,
                selected: values.parent_id === c.id,
              }));
            }
            if (depth < MAX_DEPTH) walk(c.id, depth + 1);
          });
        };
        walk('', 0);
      };
      rebuildParents();

      body.append(
        field('Name', el('input', {
          class: 'input',
          type: 'text',
          value: values.name,
          placeholder: 'e.g. Groceries',
          oninput: (e) => { values.name = e.target.value; },
        }), { required: true, error: errorNode }),
        field('Colour', el('div', { class: 'colour-field' }, [swatch, hexInput])),
        field('Parent', parentSelect, { hint: 'Leave as top level for a main category.' }),
        field('Icon', iconPicker(values.icon_key, (key) => { values.icon_key = key; }), {
          hint: isKnownIcon(values.icon_key) || !values.icon_key
            ? 'The same icon set the phone app uses.'
            : `"${values.icon_key}" isn't a known icon key — the phone shows a fallback. Pick one below.`,
        }),
      );
    },
    actions: (close) => {
      const btn = el('button', { class: 'btn', text: isEdit ? 'Save changes' : 'Create category' });
      btn.addEventListener('click', async () => {
        if (!values.name.trim()) {
          errorNode.textContent = 'Name is required';
          errorNode.classList.remove('hidden');
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          await repo.save('Categories', {
            ...(isEdit ? cat : {}),
            name: values.name.trim(),
            // Kept at whatever it was (or 'expense' for new rows) — the phone's
            // model requires it even though this view no longer splits on it.
            type: cat.type || 'expense',
            parent_id: values.parent_id,
            color_hex: values.color_hex,
            icon_key: values.icon_key,
            sort_order: isEdit
              ? parseNum(cat.sort_order, 0)
              : nextSortOrder(values.parent_id),
          });

          toast(isEdit ? 'Saved' : 'Created');
          close();
          onSaved?.();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = isEdit ? 'Save changes' : 'Create category';
          toast(err.message, { error: true });
        }
      });
      return [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), btn];
    },
  });
}

function field(label, control, { required = false, hint = '', error = null } = {}) {
  return el('div', { class: 'field' }, [
    el('label', {}, [label, required ? el('span', { class: 'req', text: '*' }) : null]),
    control,
    hint ? el('div', { class: 'hint', text: hint }) : null,
    error,
  ]);
}

// ---------- delete ----------

async function deleteCategory(cat, txnCount, refresh) {
  const descendants = [];
  const collect = (id) => {
    for (const c of repo.rows('Categories')) {
      if (c.parent_id === id) { descendants.push(c); collect(c.id); }
    }
  };
  collect(cat.id);

  const warnings = [];
  if (descendants.length) {
    warnings.push({
      icon: '🌳',
      text: `${descendants.length} subcategor${descendants.length === 1 ? 'y' : 'ies'} below it `
        + `(${descendants.slice(0, 3).map((c) => c.name).join(', ')}`
        + `${descendants.length > 3 ? '…' : ''}) will be left orphaned. `
        + 'They stay in the sheet and can be re-homed from the warning panel afterwards.',
    });
  }
  if (txnCount) {
    warnings.push({
      icon: '💸',
      text: `${txnCount} transaction${txnCount === 1 ? '' : 's'} still reference it. `
        + 'They keep their amounts but will show an unresolved category.',
    });
  }

  const ok = await confirmDialog({
    title: 'Delete category?',
    message: `"${cat.name}" will be marked deleted and disappear from your phone on the next sync.`,
    warnings,
    note: 'Nothing is erased — the row stays in the sheet and can be restored.',
    confirmLabel: 'Delete category',
  });
  if (!ok) return;

  try {
    await repo.remove('Categories', cat.id);
    toast('Deleted');
    refresh();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------- shared helpers ----------

function bySortOrder(a, b) {
  const d = parseNum(a.sort_order) - parseNum(b.sort_order);
  return d !== 0 ? d : (a.name || '').localeCompare(b.name || '');
}

function usageCounts() {
  const counts = new Map();
  for (const t of repo.rows('Transactions')) {
    if (!t.category_id) continue;
    counts.set(t.category_id, (counts.get(t.category_id) || 0) + 1);
  }
  return counts;
}

function nextSortOrder(parentId) {
  const siblings = repo.rows('Categories').filter(
    (c) => (c.parent_id || '') === (parentId || ''),
  );
  return siblings.reduce((max, c) => Math.max(max, parseNum(c.sort_order)), 0) + 1;
}

// contrastOn / normaliseHex / categoryBadge / rowTint now live in cattree.js,
// shared with the inventory category tree.
