// Generic table + form view, driven entirely by the field definitions in
// schema.js. All seven entity tabs share this one implementation, so adding a
// column to an entity is a schema.js edit and nothing more.

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { suggestionsFor } from '../stock.js';
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
    case 'bool':
      return document.createTextNode(parseBool(raw) ? 'Yes' : '—');
    case 'taxonomy':
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
          const clean = normalize(schema, values);
          await repo.save(schema.tab, { ...(isEdit ? { id: row.id } : {}), ...clean });
          // Bank any newly typed taxonomy value, so the next item offers it and
          // the phone's picker knows it too. After the save, not before: a
          // failed save shouldn't leave a stray category behind.
          for (const f of schema.fields) {
            if (f.type !== 'taxonomy' || !clean[f.key]) continue;
            try {
              await taxonomy.ensure(f.kind, [clean[f.key]]);
            } catch { /* the item saved; a missing bank entry is cosmetic */ }
          }
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
    // A switch, not a bare checkbox: these read as settings ("use up, don't
    // restock") rather than as a form field with a tickbox beside it, and a
    // 16px checkbox next to a label was the ugliest thing on the page.
    case 'bool':
      return toggle(field, parseBool(values[field.key]), set);

    // A real dropdown of the category tree, with subcategories indented under
    // their parent. Typing a free-text category was how you'd end up with
    // "Toiletries" and "toiletry" as two separate things.
    case 'taxonomy':
      return taxonomySelect(field, values, set);

    // A brand is usually one you've used before, but the first one never is —
    // a plain select would make the common case easy and the first case
    // impossible. A datalist offers what exists without refusing anything new.
    case 'suggest': {
      const listId = `dl-${field.key}-${Math.random().toString(36).slice(2, 8)}`;
      const options = suggestionsFor(
        repo.rows(field.suggestFrom || 'Inventory'),
        field.suggest || field.key,
      );
      return el('div', {}, [
        el('input', {
          class: 'input',
          type: 'text',
          list: listId,
          value: String(values[field.key] ?? ''),
          placeholder: field.placeholder || '',
          oninput: (e) => set(e.target.value),
        }),
        el('datalist', { id: listId }, options.map((o) => el('option', { value: o }))),
      ]);
    }

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

/** An on/off switch with the field's own label as its text. */
function toggle(field, initial, set) {
  const knob = el('span', { class: 'switch' });
  const row = el('button', {
    type: 'button',
    class: `toggle-row${initial ? ' is-on' : ''}`,
    'aria-pressed': String(initial),
    onclick: (e) => {
      e.preventDefault();
      const next = row.classList.toggle('is-on');
      row.setAttribute('aria-pressed', String(next));
      set(next);
    },
  }, [
    el('span', { class: 'toggle-text' }, [
      el('span', { class: 'toggle-label', text: field.label }),
      field.hint ? el('span', { class: 'toggle-hint', text: field.hint }) : null,
    ]),
    knob,
  ]);
  return row;
}

/**
 * Category dropdown, tree-shaped, with an inline "new category" escape hatch.
 *
 * Parents are selectable as well as their children — plenty of things ("Rice")
 * don't need a subcategory, and forcing one would mean inventing filler like
 * "Rice > Rice".
 */
function taxonomySelect(field, values, set) {
  const wrap = el('div', { class: 'taxonomy-select' });

  const render = () => {
    clear(wrap);
    const current = String(values[field.key] ?? '');
    const entries = taxonomy.flatten(field.kind);

    const select = el('select', {
      class: 'select',
      onchange: (e) => {
        if (e.target.value === '__new__') {
          e.target.value = current; // don't leave the sentinel selected
          promptNewCategory(field, (name) => { set(name); render(); });
          return;
        }
        set(e.target.value);
      },
    }, [
      el('option', { value: '', text: '— none —', selected: !current }),
      ...entries.map(({ entry, depth }) => el('option', {
        value: entry.name,
        // NBSP: a leading normal space is stripped in a <select> on some
        // browsers, which would flatten the indent that shows the nesting.
        text: `${depth ? '    ' : ''}${entry.name}`,
        selected: entry.name === current,
      })),
      el('option', { value: '__new__', text: '+ New category…' }),
    ]);

    // A category typed on an older build, or renamed since, won't be in the
    // list — silently showing "none" would lose it on the next save.
    const orphan = current && !entries.some(({ entry }) => entry.name === current);
    if (orphan) {
      select.append(el('option', { value: current, text: `${current} (not in the list)`, selected: true }));
    }

    wrap.append(select);
    if (orphan) {
      wrap.append(el('div', {
        class: 'hint',
        text: `"${current}" isn't one of your categories. Pick another, or add it in Manage categories.`,
      }));
    }
  };

  render();
  return wrap;
}

function promptNewCategory(field, onCreated) {
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
          placeholder: 'Sponge, Detergent…',
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
          // Only parents: the tree is two deep, so a subcategory can't take
          // children of its own.
          ...taxonomy.roots(field.kind).map((t) => el('option', { value: t.id, text: t.name })),
        ]),
      ]));
    },
    actions: (close) => {
      const btn = el('button', { class: 'btn', text: 'Add' });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const created = await taxonomy.create(field.kind, { name, parent_id: parentId });
          onCreated(created.name);
          close();
        } catch (e) {
          btn.disabled = false;
          toast(e.message, { error: true });
        }
      });
      return [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), btn];
    },
  });
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
      case 'bool':
        out[f.key] = parseBool(v);
        break;
      case 'taxonomy':
      case 'suggest':
        // Trimmed, because these group by exact text elsewhere and a stray
        // space would split "Razor " off from "Razor".
        out[f.key] = String(v ?? '').trim();
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
