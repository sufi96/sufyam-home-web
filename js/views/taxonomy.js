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
import { categoryBadge, rowTint } from './cattree.js';
import { colourPicker, iconPicker } from './pickers.js';
import { field } from './catfields.js';
import {
  el, clear, toast, openModal, confirmDialog, emptyState,
} from '../ui.js';

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

  const treePane = el('div', { class: 'pane' });
  const detailPane = el('div', { class: 'pane' });

  paintAll();

  function paintAll() {
    clear(container);
    container.append(toolbar(), el('div', { class: 'cat-split' }, [treePane, detailPane]));
    paintList();
    paintDetail();
  }

  function toolbar() {
    const meta = metaOf(activeKind);
    return el('div', { class: 'toolbar' }, [
      el('div', { class: 'tax-tabs' }, KINDS.map((k) => el('button', {
        type: 'button',
        class: `tax-tab${k.kind === activeKind ? ' is-active' : ''}`,
        onclick: () => {
          if (k.kind === activeKind) return;
          activeKind = k.kind;
          query = '';
          selectedId = null;
          paintAll();
        },
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
        onclick: openCreate,
      }),
    ]);
  }

  function visibleRows() {
    const all = taxonomy.list(activeKind);
    const shown = query ? all.filter((r) => r.name.toLowerCase().includes(query)) : all;
    return shown
      .map((row) => ({ row, count: usageOf(activeKind, row.name) }))
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

  function listRow(row, count) {
    return el('div', {
      class: `cat-row depth-0${row.id === selectedId ? ' is-selected' : ''}`,
      style: rowTint(row.color_hex, 0),
      onclick: () => { selectedId = row.id; paintList(); paintDetail(); },
    }, [
      categoryBadge(row, 26, { onColour: true }),
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
    const row = selectedId ? taxonomy.byId(activeKind, selectedId) : null;

    if (!row) {
      detailPane.append(el('div', { class: 'card detail-empty' }, [
        emptyState('👈', `Select a ${meta.singular.toLowerCase()} to edit it.`),
      ]));
      return;
    }

    const count = usageOf(activeKind, row.name);

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
          onchange: (e) => renameField(row.id, e.target),
        }), { required: true }),
        field('Icon', iconPicker(row.icon_key, (v) => setField(row.id, 'icon_key', v))),
        field('Colour', colourPicker(row.color_hex, (v) => setField(row.id, 'color_hex', v))),
      ]),
      el('div', { class: 'detail-actions' }, [
        el('button', {
          class: 'btn btn-ghost btn-danger',
          text: `Delete ${meta.singular.toLowerCase()}`,
          onclick: () => remove(row.id),
        }),
      ]),
    ]));
  }

  /**
   * Writes through immediately rather than buffering behind a Save button —
   * this bank rarely holds more than a few dozen rows, so a session of edits
   * is a handful of small writes, not the twenty-drag batch that buffering in
   * Inventory/Categories exists to collapse.
   *
   * Looks the row up fresh by id rather than trusting a closure over the row
   * object the detail pane was rendered with: the pane doesn't repaint after
   * an icon/colour edit (see below), so a stale object here would carry old
   * field values into taxonomy.update()'s `{...entry, ...patch}` merge and
   * silently undo whatever the previous edit in this same session just wrote.
   *
   * Only the list repaints, not the detail pane: repainting the very picker
   * the user is mid-click in (the colour swatch, the icon dialog) would yank
   * the control out from under them.
   */
  async function setField(rowId, key, value) {
    const current = taxonomy.byId(activeKind, rowId);
    if (!current) return;
    try {
      await taxonomy.update(current, { [key]: value });
      paintList();
    } catch (err) { toast(err.message, { error: true }); }
  }

  async function renameField(rowId, input) {
    const current = taxonomy.byId(activeKind, rowId);
    if (!current) return;
    const clean = input.value.trim();
    if (!clean || clean === current.name) { input.value = current.name; return; }
    if (clean.toLowerCase() !== current.name.trim().toLowerCase()) {
      const dup = taxonomy.names(activeKind).some((n) => n.toLowerCase() === clean.toLowerCase());
      if (dup) { input.value = current.name; toast(`"${clean}" already exists`, { error: true }); return; }
    }
    try {
      const before = current.name;
      const saved = await taxonomy.update(current, { name: clean });
      if (saved.name !== before) await refileRename(activeKind, before, saved.name);
      toast('Saved');
      paintList();
      paintDetail();
    } catch (err) {
      input.value = current.name;
      toast(err.message, { error: true });
    }
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
      if (selectedId === row.id) selectedId = null;
      toast('Deleted');
      paintList();
      paintDetail();
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

function fieldMatches(src, row, key) {
  const raw = String(row[src.field] || '');
  if (src.mode === 'pipe') {
    return raw.split('|').map((s) => s.trim().toLowerCase()).includes(key);
  }
  return raw.trim().toLowerCase() === key;
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
