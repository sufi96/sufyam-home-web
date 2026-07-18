// Generic table + form view, driven entirely by the field definitions in
// schema.js. All seven entity tabs share this one implementation, so adding a
// column to an entity is a schema.js edit and nothing more.

import * as repo from '../repo.js';
import { schemaFor, TABS, dateOnly, parseBool } from '../schema.js';
import {
  el, clear, toast, openModal, confirmDialog, emptyState,
  fmtMoney, fmtDate, fmtDateTime, toDateInput, toDateTimeInput,
} from '../ui.js';

export function renderEntity(container, tabTitle) {
  const schema = schemaFor(tabTitle);
  let query = '';
  let showDeleted = false;

  const tableWrap = el('div', { class: 'table-wrap' });

  const search = el('input', {
    class: 'input search',
    type: 'search',
    placeholder: `Search ${schema.label.toLowerCase()}…`,
    oninput: (e) => { query = e.target.value.toLowerCase(); paint(); },
  });

  const deletedToggle = el('label', {
    style: 'display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-dim);cursor:pointer',
  }, [
    el('input', {
      type: 'checkbox',
      onchange: (e) => { showDeleted = e.target.checked; paint(); },
    }),
    'Show deleted',
  ]);

  const toolbar = el('div', { class: 'toolbar' }, [
    search,
    deletedToggle,
    el('div', { class: 'spacer' }),
    el('button', {
      class: 'btn',
      text: `+ New ${singular(schema.label)}`,
      onclick: () => openForm(schema, null, paint),
    }),
  ]);

  container.append(toolbar, tableWrap);
  paint();

  function paint() {
    const all = repo.rows(tabTitle, { includeDeleted: showDeleted });
    const list = query
      ? all.filter((r) => searchBlob(schema, r).includes(query))
      : all;

    clear(tableWrap);

    if (!list.length) {
      tableWrap.append(
        emptyState(
          '📄',
          all.length
            ? 'Nothing matches that search.'
            : `No ${schema.label.toLowerCase()} yet.`,
          all.length ? null : el('button', {
            class: 'btn',
            text: `+ New ${singular(schema.label)}`,
            onclick: () => openForm(schema, null, paint),
          }),
        ),
      );
      return;
    }

    const cols = schema.listColumns;
    const table = el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          ...cols.map((c) => el('th', {
            class: isNumeric(schema, c) ? 'num' : '',
            text: labelOf(schema, c),
          })),
          el('th', { class: 'num', text: '' }),
        ]),
      ]),
      el('tbody', {}, list.map((row) => renderRow(schema, row, cols, paint))),
    ]);
    tableWrap.append(table);
  }
}

function renderRow(schema, row, cols, refresh) {
  const deleted = parseBool(row.is_deleted);
  const tr = el('tr', { style: deleted ? 'opacity:.5' : '' }, [
    ...cols.map((c) => el('td', { class: isNumeric(schema, c) ? 'num' : '' }, [
      cellNode(schema, c, row),
    ])),
    el('td', { class: 'actions' }, [
      deleted
        ? el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Restore',
            onclick: async () => {
              try {
                await repo.restore(schema.tab, row.id);
                toast('Restored');
                refresh();
              } catch (e) { toast(e.message, { error: true }); }
            },
          })
        : el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Edit',
            onclick: () => openForm(schema, row, refresh),
          }),
      ' ',
      deleted ? null : el('button', {
        class: 'btn btn-ghost btn-sm',
        text: '🗑',
        title: 'Delete',
        onclick: async () => {
          const ok = await confirmDialog({
            title: `Delete ${singular(schema.label).toLowerCase()}?`,
            message:
              `"${schema.title(row) || row.id}" will be marked deleted and disappear from ` +
              `your phone on the next sync. The row stays in the sheet and can be restored.`,
          });
          if (!ok) return;
          try {
            await repo.remove(schema.tab, row.id);
            toast('Deleted');
            refresh();
          } catch (e) { toast(e.message, { error: true }); }
        },
      }),
    ]),
  ]);
  return tr;
}

/** Renders one cell, resolving foreign keys and formatting by field type. */
function cellNode(schema, key, row) {
  const field = schema.fields.find((f) => f.key === key);
  const raw = row[key];

  if (key === 'labels') {
    const labels = String(raw || '').split('|').map((s) => s.trim()).filter(Boolean);
    if (!labels.length) return document.createTextNode('—');
    return el('span', {}, labels.map((l) => el('span', { class: 'chip', text: l })));
  }

  if (!field) return document.createTextNode(raw === '' || raw === undefined ? '—' : String(raw));

  switch (field.type) {
    case 'ref':
      return document.createTextNode(raw ? repo.labelFor(field.ref, raw) : '—');
    case 'money':
      return document.createTextNode(fmtMoney(raw));
    case 'date':
      return document.createTextNode(fmtDate(raw));
    case 'datetime':
      return document.createTextNode(fmtDateTime(raw));
    case 'select':
      return raw ? el('span', { class: 'chip', text: String(raw) }) : document.createTextNode('—');
    default:
      return document.createTextNode(raw === '' || raw === undefined ? '—' : String(raw));
  }
}

// ---------- form ----------

export function openForm(schema, row, onSaved, presets = {}) {
  const isEdit = Boolean(row);
  const values = {};
  const errorNodes = {};

  for (const f of schema.fields) {
    if (isEdit) values[f.key] = row[f.key] ?? '';
    else if (presets[f.key] !== undefined) values[f.key] = presets[f.key];
    else values[f.key] = typeof f.default === 'function' ? f.default() : (f.default ?? '');
  }

  openModal({
    title: `${isEdit ? 'Edit' : 'New'} ${singular(schema.label).toLowerCase()}`,
    render: (body) => {
      for (const f of schema.fields) {
        const errorNode = el('div', { class: 'error hidden' });
        errorNodes[f.key] = errorNode;
        body.append(el('div', { class: 'field' }, [
          el('label', { text: f.label + (f.required ? ' *' : '') }),
          buildInput(f, values),
          f.hint ? el('div', { class: 'hint', text: f.hint }) : null,
          errorNode,
        ]));
      }
    },
    actions: (close) => {
      const saveBtn = el('button', { class: 'btn', text: isEdit ? 'Save changes' : 'Create' });
      saveBtn.addEventListener('click', async () => {
        let valid = true;
        for (const f of schema.fields) {
          const err = errorNodes[f.key];
          const missing = f.required && String(values[f.key] ?? '').trim() === '';
          err.classList.toggle('hidden', !missing);
          if (missing) { err.textContent = `${f.label} is required`; valid = false; }
        }
        if (!valid) return;

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          await repo.save(schema.tab, { ...(isEdit ? { id: row.id } : {}), ...normalize(schema, values) });
          toast(isEdit ? 'Saved' : 'Created');
          close();
          onSaved?.();
        } catch (e) {
          saveBtn.disabled = false;
          saveBtn.textContent = isEdit ? 'Save changes' : 'Create';
          toast(e.message, { error: true });
        }
      });
      return [
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }),
        saveBtn,
      ];
    },
  });
}

function buildInput(field, values) {
  const set = (v) => { values[field.key] = v; };

  switch (field.type) {
    case 'select':
      return el('select', {
        class: 'select',
        onchange: (e) => set(e.target.value),
      }, field.options.map((o) => el('option', {
        value: o,
        text: o,
        selected: String(values[field.key]) === o,
      })));

    case 'ref': {
      const options = repo.rows(field.ref).map((r) => ({
        id: r.id,
        label: schemaFor(field.ref).title(r) || r.id,
      }));
      options.sort((a, b) => a.label.localeCompare(b.label));
      return el('select', {
        class: 'select',
        onchange: (e) => set(e.target.value),
      }, [
        el('option', { value: '', text: field.allowEmpty ? '— none —' : '— select —' }),
        ...options.map((o) => el('option', {
          value: o.id,
          text: o.label,
          selected: String(values[field.key]) === o.id,
        })),
      ]);
    }

    case 'textarea':
      return el('textarea', {
        class: 'textarea',
        text: String(values[field.key] ?? ''),
        oninput: (e) => set(e.target.value),
      });

    case 'date':
      return el('input', {
        class: 'input',
        type: 'date',
        value: toDateInput(values[field.key]),
        oninput: (e) => set(e.target.value),
      });

    case 'datetime':
      return el('input', {
        class: 'input',
        type: 'datetime-local',
        value: toDateTimeInput(values[field.key]),
        oninput: (e) => set(e.target.value),
      });

    case 'money':
    case 'number':
      return el('input', {
        class: 'input',
        type: 'number',
        step: field.type === 'money' ? '0.01' : 'any',
        value: String(values[field.key] ?? ''),
        oninput: (e) => set(e.target.value),
      });

    default:
      return el('input', {
        class: 'input',
        type: 'text',
        value: String(values[field.key] ?? ''),
        placeholder: field.placeholder || '',
        oninput: (e) => set(e.target.value),
      });
  }
}

/**
 * Converts form values into exactly the representation the Flutter models
 * write, so a row created here is byte-identical to one created on the phone:
 *   - date fields      -> 'YYYY-MM-DD'  (record_reminder.dart, inventory_item.dart)
 *   - datetime fields  -> full ISO-8601 (transaction.dart)
 *   - numbers          -> real numbers, not strings
 *   - labels           -> '|'-joined    (transaction.dart)
 */
function normalize(schema, values) {
  const out = {};
  for (const f of schema.fields) {
    const v = values[f.key];
    switch (f.type) {
      case 'date':
        out[f.key] = v ? dateOnly(v) : '';
        break;
      case 'datetime':
        out[f.key] = v ? new Date(v).toISOString() : '';
        break;
      case 'money':
      case 'number': {
        const n = parseFloat(v);
        out[f.key] = Number.isFinite(n) ? n : 0;
        break;
      }
      case 'labels':
        out[f.key] = String(v || '')
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
          .join('|');
        break;
      default:
        out[f.key] = v ?? '';
    }
  }
  return out;
}

// ---------- helpers ----------

function searchBlob(schema, row) {
  return schema.listColumns
    .map((c) => {
      const f = schema.fields.find((x) => x.key === c);
      return f?.type === 'ref' ? repo.labelFor(f.ref, row[c]) : row[c];
    })
    .join(' ')
    .toLowerCase();
}

function isNumeric(schema, key) {
  const f = schema.fields.find((x) => x.key === key);
  return f?.type === 'money' || f?.type === 'number';
}

function labelOf(schema, key) {
  return schema.fields.find((f) => f.key === key)?.label || key;
}

function singular(label) {
  if (label === 'Expenses') return 'Expense';
  if (label === 'Categories') return 'Category';
  if (label === 'Stock moves') return 'Stock move';
  if (label.endsWith('s')) return label.slice(0, -1);
  return label;
}

export { TABS };
