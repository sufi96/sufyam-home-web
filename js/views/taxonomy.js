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
import { normaliseHex } from './cattree.js';
import { colourPicker } from './pickers.js';
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

  const grid = el('div', { class: 'tax-grid' });

  paintAll();

  function paintAll() {
    clear(container);
    container.append(toolbar(), grid);
    paint();
  }

  function refreshToolbar() {
    const old = container.querySelector('.toolbar');
    if (old) old.replaceWith(toolbar());
  }

  function toolbar() {
    const meta = metaOf(activeKind);
    return el('div', { class: 'toolbar' }, [
      el('div', { class: 'label-chips tax-kind-tabs' }, KINDS.map((k) => el('button', {
        type: 'button',
        class: `label-chip${k.kind === activeKind ? ' is-on' : ''}`,
        onclick: () => { activeKind = k.kind; query = ''; paintAll(); },
      }, k.label))),
      el('input', {
        class: 'input search',
        type: 'search',
        placeholder: `Search ${meta.label.toLowerCase()}…`,
        value: query,
        oninput: (e) => { query = e.target.value.trim().toLowerCase(); paint(); },
      }),
      el('select', {
        class: 'select',
        style: 'max-width:150px',
        onchange: (e) => { sortMode = e.target.value; paint(); },
      }, [
        ['usage', 'Most used'], ['name', 'Name A–Z'],
      ].map(([v, t]) => el('option', { value: v, text: t, selected: sortMode === v }))),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn',
        text: `+ New ${meta.singular.toLowerCase()}`,
        onclick: () => openEditor(null),
      }),
    ]);
  }

  function paint() {
    clear(grid);
    const meta = metaOf(activeKind);
    const all = taxonomy.list(activeKind);
    const shown = query ? all.filter((r) => r.name.toLowerCase().includes(query)) : all;
    const rows = shown
      .map((row) => ({ row, count: usageOf(activeKind, row.name) }))
      .sort((a, b) => (sortMode === 'usage'
        ? (b.count - a.count) || a.row.name.localeCompare(b.row.name)
        : a.row.name.localeCompare(b.row.name)));

    if (!rows.length) {
      grid.append(emptyState(
        '🏷',
        all.length ? 'Nothing matches that search.' : meta.empty,
        all.length ? null : el('button', {
          class: 'btn',
          text: `+ New ${meta.singular.toLowerCase()}`,
          onclick: () => openEditor(null),
        }),
      ));
    } else {
      grid.append(...rows.map(({ row, count }) => card(row, count)));
    }

    if (activeKind === taxonomy.KIND_LABEL) {
      const unbanked = taxonomy.unbankedLabels();
      if (unbanked.length) grid.append(backfillBanner(unbanked));
    }
  }

  function card(row, count) {
    const hex = normaliseHex(row.color_hex);
    return el('div', { class: 'tax-card' }, [
      el('span', { class: 'tax-dot', style: hex ? `background:${hex}` : '' }),
      el('span', { class: 'tax-name', text: row.name }),
      count
        ? el('span', {
            class: 'chip chip-accent',
            title: `Used ${count} time${count === 1 ? '' : 's'}`,
            text: String(count),
          })
        : null,
      el('div', { class: 'tax-actions' }, [
        el('button', {
          class: 'btn btn-ghost btn-sm', title: `Edit ${row.name}`, onclick: () => openEditor(row),
        }, [el('span', { class: 'micon', style: 'font-size:16px', text: 'edit' })]),
        el('button', {
          class: 'btn btn-ghost btn-sm btn-danger',
          title: `Delete ${row.name}`,
          onclick: () => remove(row, count),
        }, [el('span', { class: 'micon', style: 'font-size:16px', text: 'delete' })]),
      ]),
    ]);
  }

  function backfillBanner(names) {
    return el('div', { class: 'label-backfill tax-backfill' }, [
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
            paint();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Add them';
            toast(err.message, { error: true });
          }
        },
      }),
    ]);
  }

  function openEditor(row) {
    const meta = metaOf(activeKind);
    const isEdit = Boolean(row);
    let name = row?.name || '';
    let color = row?.color_hex || '';
    const errorNode = el('div', { class: 'error hidden' });

    openModal({
      title: `${isEdit ? 'Edit' : 'New'} ${meta.singular.toLowerCase()}`,
      render: (body) => {
        body.append(
          el('div', { class: 'field' }, [
            el('label', { text: 'Name *' }),
            el('input', {
              class: 'input',
              type: 'text',
              value: name,
              placeholder: meta.singular,
              oninput: (e) => { name = e.target.value; },
            }),
            errorNode,
          ]),
          el('div', { class: 'field' }, [
            el('label', { text: 'Colour' }),
            colourPicker(color, (hex) => { color = hex; }),
          ]),
        );
      },
      actions: (close) => {
        const saveBtn = el('button', { class: 'btn', text: isEdit ? 'Save changes' : 'Create' });
        saveBtn.addEventListener('click', async () => {
          const clean = name.trim();
          if (!clean) {
            errorNode.textContent = 'Name is required';
            errorNode.classList.remove('hidden');
            return;
          }
          errorNode.classList.add('hidden');
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving…';
          try {
            if (isEdit) {
              if (clean.toLowerCase() !== row.name.trim().toLowerCase()) {
                const dup = taxonomy.names(activeKind).some((n) => n.toLowerCase() === clean.toLowerCase());
                if (dup) throw new Error(`"${clean}" already exists`);
              }
              const before = row.name;
              const saved = await taxonomy.update(row, { name: clean, color_hex: color });
              if (saved.name !== before) await refileRename(activeKind, before, saved.name);
              toast('Saved');
            } else {
              await taxonomy.create(activeKind, { name: clean, color_hex: color });
              toast('Created');
            }
            close();
            paint();
            refreshToolbar();
          } catch (err) {
            saveBtn.disabled = false;
            saveBtn.textContent = isEdit ? 'Save changes' : 'Create';
            toast(err.message, { error: true });
          }
        });
        return [
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }),
          saveBtn,
        ];
      },
    });
  }

  async function remove(row, count) {
    const meta = metaOf(activeKind);
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
      toast('Deleted');
      paint();
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
