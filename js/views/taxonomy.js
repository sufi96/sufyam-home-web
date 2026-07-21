// Taxonomy: the data bank behind labels, note categories and record types.
//
// Inventory categories live in the same sheet (kind='inventoryCategory') but
// are deliberately left out of this page — they're edited from the Inventory
// tree, where a rename re-files items through taxonomy.updateCategory() and
// deletion is blocked while subcategories exist. Neither rule applies to the
// flat kinds here, and reimplementing a lookalike of that tree screen for one
// kind would drift from it within a week.
//
// A rename or delete here still has to reach past the Taxonomy sheet itself:
// labels and categories are stored on other rows *by name*, so KINDS below
// lists every place a kind's name is copied elsewhere, and refileRename() /
// refileRemove() keep those in sync the same way notes.js's own category
// manager already does for note categories.

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { schemaFor } from '../schema.js';
import { categoryBadge, rowTint } from './cattree.js';
import { colourPicker, iconPicker } from './pickers.js';
import { field } from './catfields.js';
import {
  el, clear, toast, openModal, confirmDialog, emptyState, fmtMoney, fmtDate,
} from '../ui.js';

// How one matching row renders under "Appears in", per source tab — reuses
// the .txn-row lead+body layout the Categories page draws its own
// transaction list with, amount and date first, so a label's expenses read
// the same way there and here.
const USAGE_ROW = {
  Transactions: (r) => el('div', { class: 'txn-row is-static' }, [
    el('div', { class: 'txn-lead' }, [
      el('div', { class: 'txn-amount', text: fmtMoney(r.amount) }),
      el('div', { class: 'txn-date', text: fmtDate(r.transaction_date) }),
    ]),
    el('div', { class: 'txn-body' }, [
      el('div', { class: 'txn-top' }, [
        r.notes
          ? el('span', { class: 'txn-note', text: r.notes })
          : el('span', { class: 'txn-note is-empty', text: 'No note' }),
      ]),
    ]),
  ]),
  Notes: (r) => el('div', { class: 'txn-row is-static' }, [
    el('div', { class: 'txn-lead' }, [
      el('div', { class: 'txn-amount', text: r.title || '(untitled)' }),
      el('div', { class: 'txn-date', text: fmtDate(r.updated_at) }),
    ]),
  ]),
  Records_Reminders: (r) => el('div', { class: 'txn-row is-static' }, [
    el('div', { class: 'txn-lead' }, [
      el('div', { class: 'txn-amount', text: r.title || '(untitled)' }),
      el('div', { class: 'txn-date', text: `Due ${fmtDate(r.due_date)}` }),
    ]),
  ]),
};

const MAX_USAGE_ROWS = 6;

const KINDS = [
  {
    kind: taxonomy.KIND_LABEL,
    label: 'Labels',
    singular: 'Label',
    empty: 'No labels yet. Add one here, or tag an expense or a note and it\'ll show up unbanked below.',
    sources: [
      { tab: 'Transactions', field: 'labels', mode: 'pipe' },
      { tab: 'Notes', field: 'labels', mode: 'pipe' },
    ],
  },
  {
    kind: taxonomy.KIND_NOTE_CATEGORY,
    label: 'Note categories',
    singular: 'Category',
    empty: 'No note categories yet.',
    sources: [{ tab: 'Notes', field: 'category', mode: 'exact' }],
  },
  {
    kind: taxonomy.KIND_RECORD_TYPE,
    label: 'Record types',
    singular: 'Type',
    empty: 'No record types yet.',
    sources: [{ tab: 'Records_Reminders', field: 'type', mode: 'exact' }],
  },
];

const metaOf = (kind) => KINDS.find((k) => k.kind === kind);

export function renderTaxonomy(container) {
  let activeKind = taxonomy.KIND_LABEL;
  let query = '';
  let sortMode = 'usage'; // 'usage' | 'name'
  let selectedId = null;
  let saving = false;

  // Buffered edits for the selected row: { id, patch }. Name, icon and colour
  // all live on the SAME sheet row, so writing each one as it changes cost
  // three round-trips (six API calls with the changelog append each one drags
  // along) to set three fields. Google's write quota is 60/minute, which a
  // handful of labels edited back to back was enough to exhaust. Held here
  // and flushed as one repo.save() instead.
  let pending = null;

  const treePane = el('div', { class: 'pane' });
  const detailPane = el('div', { class: 'pane' });
  const saveHost = el('div');

  const isDirty = () => Boolean(pending && Object.keys(pending.patch).length);

  /** A row as the user currently sees it — stored values plus unsaved edits. */
  function effective(row) {
    if (!row) return row;
    return pending && pending.id === row.id ? { ...row, ...pending.patch } : row;
  }

  paintAll();

  function paintAll() {
    clear(container);
    container.append(toolbar(), saveHost, el('div', { class: 'cat-split' }, [treePane, detailPane]));
    paintSaveBar();
    paintList();
    paintDetail();
  }

  function toolbar() {
    const meta = metaOf(activeKind);
    return el('div', { class: 'toolbar' }, [
      el('div', { class: 'tax-tabs' }, KINDS.map((k) => el('button', {
        type: 'button',
        class: `tax-tab${k.kind === activeKind ? ' is-active' : ''}`,
        onclick: () => withFlush(() => {
          if (k.kind === activeKind) return;
          activeKind = k.kind;
          query = '';
          selectedId = null;
          paintAll();
        }),
      }, k.label))),
      el('input', {
        class: 'input search',
        type: 'search',
        placeholder: `Search ${meta.label.toLowerCase()}…`,
        value: query,
        oninput: (e) => { query = e.target.value.trim().toLowerCase(); paintList(); },
      }),
      el('select', {
        class: 'select',
        style: 'max-width:150px',
        onchange: (e) => { sortMode = e.target.value; paintList(); },
      }, [
        ['usage', 'Most used'], ['name', 'Name A–Z'],
      ].map(([v, t]) => el('option', { value: v, text: t, selected: sortMode === v }))),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn',
        text: `+ New ${meta.singular.toLowerCase()}`,
        onclick: () => withFlush(openCreate),
      }),
    ]);
  }

  function paintSaveBar() {
    clear(saveHost);
    if (!isDirty()) return;
    const row = taxonomy.byId(activeKind, pending.id);
    saveHost.append(el('div', { class: 'save-bar' }, [
      el('span', { class: 'save-dot' }),
      el('span', {
        class: 'save-text',
        text: `Unsaved changes to "${row?.name || 'this entry'}"`,
      }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: 'Discard',
        disabled: saving,
        onclick: () => { pending = null; paintAll(); },
      }),
      el('button', {
        class: 'btn btn-sm',
        text: saving ? 'Saving…' : 'Save',
        disabled: saving,
        onclick: () => save(),
      }),
    ]));
  }

  function visibleRows() {
    const all = taxonomy.list(activeKind);
    const shown = query ? all.filter((r) => r.name.toLowerCase().includes(query)) : all;
    // One pass over the source tabs for every row, rather than a full scan of
    // Transactions and Notes per label — that was O(labels × transactions) on
    // each repaint, and the list repaints on every keystroke in the search box.
    const counts = usageCounts(activeKind);
    return shown
      .map((row) => ({ row, count: counts.get(row.name.trim().toLowerCase()) || 0 }))
      .sort((a, b) => (sortMode === 'usage'
        ? (b.count - a.count) || a.row.name.localeCompare(b.row.name)
        : a.row.name.localeCompare(b.row.name)));
  }

  function paintList() {
    clear(treePane);
    const meta = metaOf(activeKind);
    const all = taxonomy.list(activeKind);
    const rows = visibleRows();

    if (!rows.length) {
      treePane.append(emptyState(
        '🏷',
        all.length ? 'Nothing matches that search.' : meta.empty,
        all.length ? null : el('button', { class: 'btn', text: `+ New ${meta.singular.toLowerCase()}`, onclick: openCreate }),
      ));
    } else {
      treePane.append(el('div', { class: 'cat-list' }, rows.map(({ row, count }) => listRow(row, count))));
    }

    if (activeKind === taxonomy.KIND_LABEL) {
      const unbanked = taxonomy.unbankedLabels();
      if (unbanked.length) treePane.append(backfillBanner(unbanked));
    }
  }

  function listRow(storedRow, count) {
    // Rendered from the buffered view so an unsaved colour or icon shows up
    // here the moment it's picked, not only after Save.
    const row = effective(storedRow);
    return el('div', {
      // Depth 1 rather than 0: the same soft tint the Categories tree gives a
      // subcategory. A depth-0 row is filled with the colour at full strength
      // and flips its text to black or white to survive that — fine when it's
      // heading a group of paler rows beneath it, but a whole list of them is
      // a wall of saturated blocks.
      class: `cat-row tax-row${row.id === selectedId ? ' is-selected' : ''}`,
      style: rowTint(row.color_hex, 1),
      onclick: () => withFlush(() => { selectedId = row.id; paintList(); paintDetail(); }),
    }, [
      categoryBadge(row, 26),
      el('span', { class: 'tax-row-name', text: row.name || '(unnamed)' }),
      count
        ? el('span', { class: 'chip', title: `Used ${count} time${count === 1 ? '' : 's'}`, text: String(count) })
        : null,
    ]);
  }

  function backfillBanner(names) {
    return el('div', { class: 'label-backfill', style: 'margin-top:10px' }, [
      el('span', {
        text: `${names.length} label${names.length === 1 ? '' : 's'} used on transactions or notes `
          + `${names.length === 1 ? 'is' : 'are'} not in this bank yet.`,
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        text: 'Add them',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Adding…';
          try {
            const added = await taxonomy.ensure(taxonomy.KIND_LABEL, names);
            toast(`Banked ${added.length} label${added.length === 1 ? '' : 's'}`);
            paintList();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Add them';
            toast(err.message, { error: true });
          }
        },
      }),
    ]);
  }

  // ---------- detail pane ----------

  function paintDetail() {
    clear(detailPane);
    const meta = metaOf(activeKind);
    const stored = selectedId ? taxonomy.byId(activeKind, selectedId) : null;

    if (!stored) {
      detailPane.append(el('div', { class: 'card detail-empty' }, [
        emptyState('👈', `Select a ${meta.singular.toLowerCase()} to edit it.`),
      ]));
      return;
    }

    const row = effective(stored);
    // Usage is looked up by the STORED name: other tabs still reference the
    // old one until a rename is actually saved and refiled.
    const groups = usageDetails(activeKind, stored.name);
    const count = groups.reduce((n, g) => n + g.rows.length, 0);

    detailPane.append(el('div', { class: 'card' }, [
      el('div', { class: 'detail-head' }, [
        categoryBadge(row, 36),
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'detail-title', text: row.name || '(unnamed)' }),
          el('div', {
            class: 'detail-crumb',
            text: count ? `Used ${count} time${count === 1 ? '' : 's'}` : 'Not used anywhere yet',
          }),
        ]),
      ]),
      el('div', { class: 'cat-detail-body' }, [
        field('Name', el('input', {
          class: 'input',
          type: 'text',
          value: row.name || '',
          oninput: (e) => setField(stored.id, 'name', e.target.value),
        }), { required: true }),
        field('Icon', iconPicker(row.icon_key, (v) => setField(stored.id, 'icon_key', v))),
        field('Colour', colourPicker(row.color_hex, (v) => setField(stored.id, 'color_hex', v), { large: true })),
      ]),
      el('div', { class: 'detail-actions' }, [
        el('button', {
          class: 'btn btn-ghost btn-danger',
          text: `Delete ${meta.singular.toLowerCase()}`,
          onclick: () => remove(stored.id),
        }),
      ]),
    ]));

    // A separate card, not another section of the one above — editing a
    // label and seeing where it's used are different jobs, and running them
    // together read as one long form.
    if (groups.length) detailPane.append(usageCard(groups));
  }

  /**
   * Records one field edit in the buffer. Nothing is written here — save()
   * flushes all three fields as a single row write.
   *
   * A value that matches what's stored drops out of the buffer again, so
   * typing a name and undoing it leaves the page clean rather than dirty.
   *
   * The list repaints (to preview the change) but the detail pane does not:
   * rebuilding the very picker the user is mid-click in — the colour swatch,
   * the open icon dialog — would yank the control out from under them.
   */
  function setField(rowId, key, value) {
    const stored = taxonomy.byId(activeKind, rowId);
    if (!stored) return;
    if (!pending || pending.id !== rowId) pending = { id: rowId, patch: {} };
    if (String(value ?? '') === String(stored[key] ?? '')) delete pending.patch[key];
    else pending.patch[key] = value;
    if (!Object.keys(pending.patch).length) pending = null;
    paintList();
    paintSaveBar();
  }

  async function save() {
    if (!isDirty() || saving) return true;
    const { id, patch } = pending;
    const stored = taxonomy.byId(activeKind, id);
    if (!stored) { pending = null; return true; }

    const before = stored.name;
    const after = patch.name === undefined ? before : String(patch.name).trim();
    if (!after) return toast('Name is required', { error: true }) || false;
    if (after.toLowerCase() !== before.trim().toLowerCase()
      && taxonomy.names(activeKind).some((n) => n.toLowerCase() === after.toLowerCase())) {
      toast(`"${after}" already exists`, { error: true });
      return false;
    }

    saving = true;
    paintSaveBar();
    try {
      // One write for the row, whatever mix of name/icon/colour changed.
      await taxonomy.update(stored, { ...patch, name: after });
      // Only a rename has to reach into the other tabs, and only then.
      if (after !== before) await refileRename(activeKind, before, after);
      pending = null;
      toast('Saved');
      return true;
    } catch (err) {
      toast(err.message, { error: true });
      return false;
    } finally {
      saving = false;
      paintAll();
    }
  }

  /** Saves any buffered edit before an action that would otherwise strand it. */
  async function withFlush(action) {
    if (isDirty() && !(await save())) return;
    action();
  }

  // ---------- create / delete ----------

  function openCreate() {
    const meta = metaOf(activeKind);
    let name = '';

    openModal({
      title: `New ${meta.singular.toLowerCase()}`,
      render: (body) => {
        body.append(el('div', { class: 'field' }, [
          el('label', { text: 'Name *' }),
          el('input', {
            class: 'input',
            type: 'text',
            placeholder: meta.singular,
            oninput: (e) => { name = e.target.value; },
          }),
          el('div', { class: 'hint', text: 'Icon and colour are set afterwards, in the detail pane.' }),
        ]));
      },
      actions: (close) => {
        const btn = el('button', { class: 'btn', text: 'Add' });
        btn.addEventListener('click', async () => {
          const clean = name.trim();
          if (!clean) return;
          btn.disabled = true;
          try {
            const created = await taxonomy.create(activeKind, { name: clean });
            close();
            selectedId = created.id;
            paintList();
            paintDetail();
            toast('Created');
          } catch (err) {
            btn.disabled = false;
            toast(err.message, { error: true });
          }
        });
        return [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), btn];
      },
    });
  }

  async function remove(rowId) {
    const row = taxonomy.byId(activeKind, rowId);
    if (!row) return;
    const meta = metaOf(activeKind);
    const count = usageOf(activeKind, row.name);
    const ok = await confirmDialog({
      title: `Delete "${row.name}"?`,
      message: `"${row.name}" will be removed from your ${meta.label.toLowerCase()} bank.`,
      warnings: count ? [{
        icon: '🏷',
        text: `Used ${count} time${count === 1 ? '' : 's'}. It will be cleared from wherever it appears — `
          + 'nothing else is deleted.',
      }] : [],
      note: 'The row stays in the sheet and can be restored.',
    });
    if (!ok) return;
    try {
      await taxonomy.remove(row);
      if (count) await refileRemove(activeKind, row.name);
      // Any buffered edit to this row died with it.
      if (pending?.id === row.id) pending = null;
      if (selectedId === row.id) selectedId = null;
      toast('Deleted');
      paintAll();
    } catch (err) { toast(err.message, { error: true }); }
  }
}

// ---------- cross-sheet sync ----------

function usageOf(kind, name) {
  const key = name.trim().toLowerCase();
  let count = 0;
  for (const src of metaOf(kind).sources) {
    for (const row of repo.rows(src.tab)) {
      if (fieldMatches(src, row, key)) count++;
    }
  }
  return count;
}

/**
 * How many rows carry each name of this kind, keyed by lowercase name — the
 * whole list's counts in a single pass over the source tabs.
 *
 * A row that somehow carries the same label twice still counts once, matching
 * what a per-row `some()` check would have said.
 */
function usageCounts(kind) {
  const counts = new Map();
  for (const src of metaOf(kind).sources) {
    for (const row of repo.rows(src.tab)) {
      const raw = String(row[src.field] || '');
      const tokens = src.mode === 'pipe' ? raw.split('|') : [raw];
      const seen = new Set();
      for (const token of tokens) {
        const key = token.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return counts;
}

function fieldMatches(src, row, key) {
  const raw = String(row[src.field] || '');
  if (src.mode === 'pipe') {
    return raw.split('|').map((s) => s.trim().toLowerCase()).includes(key);
  }
  return raw.trim().toLowerCase() === key;
}

/** The actual rows a label/category appears on, grouped by source tab. */
function usageDetails(kind, name) {
  const key = name.trim().toLowerCase();
  const groups = [];
  for (const src of metaOf(kind).sources) {
    const rows = repo.rows(src.tab).filter((row) => fieldMatches(src, row, key));
    if (rows.length) groups.push({ tab: src.tab, rows });
  }
  return groups;
}

function usageCard(groups) {
  return el('div', { class: 'card tax-usage-card' }, [
    el('div', { class: 'card-title', text: 'Appears in' }),
    ...groups.map(({ tab, rows }) => usageGroup(tab, rows)),
  ]);
}

function usageGroup(tab, rows) {
  const build = USAGE_ROW[tab] || ((r) => el('div', { class: 'txn-row is-static' }, [
    el('div', { class: 'txn-lead' }, [el('div', { class: 'txn-amount', text: schemaFor(tab).title(r) || '(untitled)' })]),
  ]));
  return el('div', { class: 'usage-group' }, [
    el('div', { class: 'usage-group-label', text: `${schemaFor(tab).label} (${rows.length})` }),
    el('div', { class: 'txn-list is-boxed' }, rows.slice(0, MAX_USAGE_ROWS).map(build)),
    rows.length > MAX_USAGE_ROWS
      ? el('div', { class: 'hint', text: `+${rows.length - MAX_USAGE_ROWS} more` })
      : null,
  ]);
}

async function refileRename(kind, before, after) {
  const key = before.trim().toLowerCase();
  for (const src of metaOf(kind).sources) {
    const changed = [];
    for (const row of repo.rows(src.tab)) {
      if (src.mode === 'pipe') {
        const tokens = String(row[src.field] || '').split('|').map((s) => s.trim()).filter(Boolean);
        if (!tokens.some((t) => t.toLowerCase() === key)) continue;
        const seen = new Set();
        const next = [];
        for (const t of tokens) {
          const v = t.toLowerCase() === key ? after : t;
          const k = v.toLowerCase();
          // A rename that collides with a label already on the same row would
          // otherwise write it twice.
          if (seen.has(k)) continue;
          seen.add(k);
          next.push(v);
        }
        changed.push({ ...row, [src.field]: next.join('|') });
      } else if (String(row[src.field] || '').trim().toLowerCase() === key) {
        changed.push({ ...row, [src.field]: after });
      }
    }
    if (changed.length) await repo.saveMany(src.tab, changed);
  }
}

async function refileRemove(kind, name) {
  const key = name.trim().toLowerCase();
  for (const src of metaOf(kind).sources) {
    const changed = [];
    for (const row of repo.rows(src.tab)) {
      if (src.mode === 'pipe') {
        const tokens = String(row[src.field] || '').split('|').map((s) => s.trim()).filter(Boolean);
        if (!tokens.some((t) => t.toLowerCase() === key)) continue;
        changed.push({ ...row, [src.field]: tokens.filter((t) => t.toLowerCase() !== key).join('|') });
      } else if (String(row[src.field] || '').trim().toLowerCase() === key) {
        changed.push({ ...row, [src.field]: '' });
      }
    }
    if (changed.length) await repo.saveMany(src.tab, changed);
  }
}
