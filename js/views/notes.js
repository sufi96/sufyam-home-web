// Notes: free-text notes and checklists, grouped into user-named categories.
//
// Phase 1 — plaintext only. The `is_encrypted` column exists in the schema
// from the start so the secure-note work can land later without touching row
// shape, but nothing writes it yet.
//
// Checkbox ticks are batched: ticking six items off a list would otherwise be
// six separate writes (twelve API calls), so they collect for a moment and go
// out as one repo.saveMany().

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { parseNum, parseBool } from '../schema.js';
import { labelPicker } from './pickers.js';
import {
  el, clear, toast, openModal, confirmDialog, emptyState, fmtDateTime,
} from '../ui.js';

const TYPES = [
  { key: 'note', label: 'Note', icon: 'notes' },
  { key: 'checklist', label: 'Checklist', icon: 'checklist' },
];

const UNFILED = 'Unfiled';
const FLUSH_DELAY = 1200;

export function renderNotes(container) {
  let query = '';
  let collapsed = new Set(JSON.parse(localStorage.getItem('sufyam.notes.collapsed') || '[]'));

  // Pending checklist ticks, keyed by note id, flushed as one batch.
  const pending = new Map();
  let flushTimer = null;

  function queueSave(note) {
    pending.set(note.id, note);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, FLUSH_DELAY);
  }

  async function flushPending() {
    if (!pending.size) return;
    const batch = [...pending.values()];
    pending.clear();
    try {
      await repo.saveMany('Notes', batch);
    } catch (err) {
      toast(err.message, { error: true });
      paint();
    }
  }

  // Anything still queued when the user navigates away must not be lost.
  window.addEventListener('beforeunload', flushPending);

  function paint() {
    clear(container);

    if (repo.missingTabs().includes('Notes')) {
      container.append(setupPrompt());
      return;
    }

    const notes = repo.rows('Notes');
    container.append(toolbar(notes));

    const matching = query ? notes.filter((n) => matches(n, query)) : notes;

    if (!matching.length) {
      container.append(el('div', { class: 'card' }, [
        emptyState(
          query ? '🔍' : '🗒',
          query ? `Nothing matches “${query}”.` : 'No notes yet.',
          query ? null : el('button', {
            class: 'btn',
            text: '+ New note',
            onclick: () => openNoteForm({}, paint),
          }),
        ),
      ]));
      return;
    }

    // Searching flattens the grouping: when you're hunting for something, the
    // category headers are noise between you and the hit.
    if (query) {
      container.append(el('div', { class: 'notes-grid' }, matching.map(noteCard)));
      return;
    }

    const pinned = matching.filter((n) => parseBool(n.pinned));
    if (pinned.length) {
      container.append(section('Pinned', 'push_pin', pinned, { pinnedSection: true }));
    }

    const rest = matching.filter((n) => !parseBool(n.pinned));
    const byCategory = new Map();
    for (const note of rest) {
      const key = (note.category || '').trim() || UNFILED;
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(note);
    }

    const names = [...byCategory.keys()].sort((a, b) => {
      if (a === UNFILED) return 1;   // unfiled always sinks to the bottom
      if (b === UNFILED) return -1;
      return a.localeCompare(b);
    });

    for (const name of names) {
      container.append(section(name, 'folder', byCategory.get(name)));
    }
  }

  function toolbar(notes) {
    const categories = [...new Set(notes.map((n) => (n.category || '').trim()).filter(Boolean))];
    return el('div', { class: 'notes-toolbar' }, [
      el('div', { class: 'notes-search' }, [
        el('span', { class: 'micon notes-search-icon', text: 'search' }),
        el('input', {
          class: 'input',
          type: 'search',
          placeholder: 'Search notes, checklists, labels…',
          value: query,
          oninput: (e) => { query = e.target.value.trim().toLowerCase(); paint(); },
        }),
        query ? el('button', {
          class: 'btn btn-ghost btn-sm',
          text: 'Clear',
          onclick: () => { query = ''; paint(); },
        }) : null,
      ]),
      el('div', { style: 'flex:1' }),
      query ? el('span', {
        class: 'notes-count',
        text: `${notes.filter((n) => matches(n, query)).length} of ${notes.length}`,
      }) : null,
      el('button', {
        class: 'btn',
        text: '+ New note',
        onclick: () => openNoteForm({ category: categories[0] || '' }, paint),
      }),
    ]);
  }

  function section(name, icon, items, { pinnedSection = false } = {}) {
    const isCollapsed = collapsed.has(name);
    const total = items.length;

    const header = el('button', {
      class: `notes-section-head${isCollapsed ? ' is-collapsed' : ''}`,
      onclick: () => {
        if (isCollapsed) collapsed.delete(name); else collapsed.add(name);
        localStorage.setItem('sufyam.notes.collapsed', JSON.stringify([...collapsed]));
        paint();
      },
    }, [
      el('span', { class: 'micon notes-section-caret', text: 'expand_more' }),
      el('span', { class: `micon notes-section-icon${pinnedSection ? ' is-pinned' : ''}`, text: icon }),
      el('span', { class: 'notes-section-name', text: name }),
      el('span', { class: 'notes-section-count', text: String(total) }),
    ]);

    return el('div', { class: 'notes-section' }, [
      header,
      isCollapsed ? null : el('div', { class: 'notes-grid' }, items.map(noteCard)),
    ]);
  }

  function noteCard(note) {
    const labels = splitLabels(note.labels);
    const accent = normaliseHex(note.color_hex);

    return el('div', {
      class: 'note-card',
      style: accent ? `--note-accent:${accent}` : '',
      onclick: (e) => {
        if (e.target.closest('.note-check, .note-card-action')) return;
        openNoteForm(note, paint);
      },
    }, [
      el('div', { class: 'note-card-head' }, [
        el('span', {
          class: 'micon note-type-icon',
          text: note.type === 'checklist' ? 'checklist' : 'notes',
        }),
        el('span', { class: 'note-title', text: note.title || '(untitled)' }),
        parseBool(note.pinned)
          ? el('span', { class: 'micon note-pin', text: 'push_pin', title: 'Pinned' })
          : null,
      ]),

      note.type === 'checklist' ? checklistPreview(note) : textPreview(note),

      labels.length
        ? el('div', { class: 'note-labels' }, labels.map((l) => el('span', {
            class: 'chip chip-label', text: l,
          })))
        : null,
    ]);
  }

  function textPreview(note) {
    const body = String(note.content || '').trim();
    if (!body) return el('div', { class: 'note-body is-empty', text: 'Empty note' });
    return el('div', { class: 'note-body', text: body });
  }

  function checklistPreview(note) {
    const items = parseChecklist(note.content);
    if (!items.length) return el('div', { class: 'note-body is-empty', text: 'Empty checklist' });

    const done = items.filter((i) => i.done).length;
    const shown = items.slice(0, 6);

    return el('div', {}, [
      el('div', { class: 'note-progress' }, [
        el('div', {
          class: 'note-progress-fill',
          style: `width:${Math.round((done / items.length) * 100)}%`,
        }),
      ]),
      el('div', { class: 'note-progress-text', text: `${done} of ${items.length} done` }),
      el('div', { class: 'note-checks' }, shown.map((item, i) => el('label', {
        class: `note-check${item.done ? ' is-done' : ''}`,
      }, [
        el('input', {
          type: 'checkbox',
          checked: item.done || null,
          onclick: (e) => {
            e.stopPropagation();
            const next = parseChecklist(note.content);
            next[i].done = e.target.checked;
            // Update the cached row immediately so the UI stays responsive,
            // then let the debounced batch carry it to the sheet.
            const updated = { ...note, content: JSON.stringify(next) };
            Object.assign(note, updated);
            queueSave(updated);
            paint();
          },
        }),
        el('span', { class: 'note-check-text', text: item.text || '(blank)' }),
      ]))),
      items.length > shown.length
        ? el('div', { class: 'note-more', text: `+${items.length - shown.length} more` })
        : null,
    ]);
  }

  function setupPrompt() {
    return el('div', { class: 'center-pane' }, [
      el('div', { class: 'card' }, [
        el('h2', { text: 'Set up Notes' }),
        el('p', {
          text: 'Your spreadsheet does not have a Notes tab yet. '
            + 'This adds it with the right header row; nothing else is touched.',
        }),
        el('button', {
          class: 'btn',
          text: 'Add the Notes tab',
          onclick: async (e) => {
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = 'Adding…';
            try {
              await repo.ensureSchema();
              await repo.loadAll();
              toast('Notes tab created');
              paint();
            } catch (err) {
              btn.disabled = false;
              btn.textContent = 'Add the Notes tab';
              toast(err.message, { error: true });
            }
          },
        }),
      ]),
    ]);
  }

  paint();
}

// ---------- editor ----------

function openNoteForm(note, onSaved) {
  const isEdit = Boolean(note.id);
  const values = {
    title: note.title || '',
    type: note.type || 'note',
    category: (note.category || '').trim(),
    content: note.content || '',
    labels: note.labels || '',
    pinned: parseBool(note.pinned),
    color_hex: normaliseHex(note.color_hex) || '',
  };
  const errorNode = el('div', { class: 'error hidden' });

  openModal({
    title: isEdit ? 'Edit note' : 'New note',
    icon: '🗒',
    wide: true,
    render: (body) => {
      const bodyHost = el('div');

      const renderBody = () => {
        clear(bodyHost);
        bodyHost.append(values.type === 'checklist'
          ? checklistEditor(values)
          : el('textarea', {
              class: 'textarea note-textarea',
              text: values.content,
              placeholder: 'Write anything…',
              oninput: (e) => { values.content = e.target.value; },
            }));
      };

      // Remembers what each type held during this edit, so flipping Note →
      // Checklist → Note gives back the original prose instead of the same
      // text decorated with "[ ]" markers.
      const draft = { [values.type]: values.content };

      const typeToggle = el('div', { class: 'segmented' }, TYPES.map((t) => el('button', {
        class: `segmented-btn${values.type === t.key ? ' is-active' : ''}`,
        onclick: (e) => {
          e.preventDefault();
          if (values.type === t.key) return;
          draft[values.type] = values.content;
          values.content = draft[t.key] !== undefined
            ? draft[t.key]
            : convertContent(values.content, values.type, t.key);
          values.type = t.key;
          for (const b of typeToggle.children) b.classList.remove('is-active');
          e.currentTarget.classList.add('is-active');
          renderBody();
        },
      }, [el('span', { class: 'micon', style: 'font-size:16px', text: t.icon }), t.label])));

      // Existing categories offered as suggestions, but free text so a new one
      // needs no separate "create category" step.
      const categories = [...new Set(repo.rows('Notes')
        .map((n) => (n.category || '').trim())
        .filter(Boolean))].sort();
      const listId = `note-cats-${Math.random().toString(36).slice(2, 8)}`;

      body.append(
        el('div', { class: 'field-row' }, [
          field('Title', el('input', {
            class: 'input',
            type: 'text',
            value: values.title,
            placeholder: 'Wifi details, Shopping, …',
            oninput: (e) => { values.title = e.target.value; },
          }), { required: true, error: errorNode }),
          field('Category', el('div', {}, [
            el('input', {
              class: 'input',
              type: 'text',
              value: values.category,
              list: listId,
              placeholder: 'Type a new one or pick an existing',
              oninput: (e) => { values.category = e.target.value; },
            }),
            el('datalist', { id: listId }, categories.map((c) => el('option', { value: c }))),
          ])),
        ]),

        field('Type', typeToggle),
        field('Content', bodyHost),
        field('Labels', labelPicker(values.labels, (names) => {
          values.labels = names.join('|');
        })),

        el('label', { class: 'note-pin-toggle' }, [
          el('input', {
            type: 'checkbox',
            checked: values.pinned || null,
            onchange: (e) => { values.pinned = e.target.checked; },
          }),
          el('span', { class: 'micon', style: 'font-size:16px', text: 'push_pin' }),
          'Pin to the top',
        ]),

        isEdit ? el('div', { class: 'audit-note' }, [
          el('div', { text: `Created ${fmtDateTime(note.created_at)} by ${note.created_by || '—'}` }),
          el('div', { text: `Updated ${fmtDateTime(note.updated_at)} by ${note.updated_by || '—'}` }),
        ]) : null,
      );

      renderBody();
    },
    actions: (close) => {
      const buttons = [];

      if (isEdit) {
        buttons.push(el('button', {
          class: 'btn btn-danger btn-ghost',
          text: 'Delete',
          style: 'margin-right:auto',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Delete note?',
              message: `"${note.title || 'Untitled'}" will be marked deleted.`,
              note: 'The row stays in the sheet and can be restored.',
              confirmLabel: 'Delete note',
            });
            if (!ok) return;
            try {
              await repo.remove('Notes', note.id);
              toast('Note deleted');
              close();
              onSaved?.();
            } catch (err) { toast(err.message, { error: true }); }
          },
        }));
      }

      const save = el('button', { class: 'btn', text: isEdit ? 'Save note' : 'Create note' });
      save.addEventListener('click', async () => {
        if (!values.title.trim()) {
          errorNode.textContent = 'Give the note a title';
          errorNode.classList.remove('hidden');
          return;
        }
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
          await repo.save('Notes', {
            ...(isEdit ? note : {}),
            title: values.title.trim(),
            type: values.type,
            category: values.category.trim(),
            content: values.content,
            labels: values.labels,
            pinned: values.pinned,
            is_encrypted: false,
            color_hex: values.color_hex,
            sort_order: isEdit ? parseNum(note.sort_order, 0) : nextSortOrder(),
          });
          await taxonomy.ensure(taxonomy.KIND_LABEL, splitLabels(values.labels));
          toast(isEdit ? 'Note saved' : 'Note created');
          close();
          onSaved?.();
        } catch (err) {
          save.disabled = false;
          save.textContent = isEdit ? 'Save note' : 'Create note';
          toast(err.message, { error: true });
        }
      });

      buttons.push(el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), save);
      return buttons;
    },
  });
}

/** Editable checklist: reorderable-free, just add / tick / remove. */
function checklistEditor(values) {
  const host = el('div', { class: 'checklist-editor' });

  const render = () => {
    clear(host);
    const items = parseChecklist(values.content);

    const commit = () => { values.content = JSON.stringify(items); };

    items.forEach((item, i) => {
      host.append(el('div', { class: `checklist-row${item.done ? ' is-done' : ''}` }, [
        el('input', {
          type: 'checkbox',
          checked: item.done || null,
          onchange: (e) => { items[i].done = e.target.checked; commit(); render(); },
        }),
        el('input', {
          class: 'input checklist-text',
          type: 'text',
          value: item.text,
          placeholder: 'Item',
          oninput: (e) => { items[i].text = e.target.value; commit(); },
          onkeydown: (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            items.splice(i + 1, 0, { text: '', done: false });
            commit();
            render();
            host.querySelectorAll('.checklist-text')[i + 1]?.focus();
          },
        }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          title: 'Remove',
          onclick: (e) => { e.preventDefault(); items.splice(i, 1); commit(); render(); },
        }, [el('span', { class: 'micon', style: 'font-size:16px', text: 'close' })]),
      ]));
    });

    host.append(el('button', {
      class: 'btn btn-ghost btn-sm checklist-add',
      onclick: (e) => {
        e.preventDefault();
        items.push({ text: '', done: false });
        commit();
        render();
        const inputs = host.querySelectorAll('.checklist-text');
        inputs[inputs.length - 1]?.focus();
      },
    }, [el('span', { class: 'micon', style: 'font-size:16px', text: 'add' }), 'Add item']));
  };

  render();
  return host;
}

// ---------- helpers ----------

function field(label, control, { required = false, hint = '', error = null } = {}) {
  return el('div', { class: 'field' }, [
    el('label', {}, [label, required ? el('span', { class: 'req', text: '*' }) : null]),
    control,
    hint ? el('div', { class: 'hint', text: hint }) : null,
    error,
  ]);
}

/** Tolerant of hand-editing in Sheets: anything unparseable becomes lines. */
export function parseChecklist(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((i) => (typeof i === 'string'
        ? { text: i, done: false }
        : { text: String(i?.text ?? ''), done: Boolean(i?.done) }));
    }
  } catch {
    // Not JSON — treat each line as an item so a note typed directly into the
    // spreadsheet still opens as a usable checklist.
  }
  return text.split('\n').map((line) => {
    const m = line.match(/^\s*[-*]?\s*\[( |x|X)\]\s*(.*)$/);
    if (m) return { text: m[2], done: m[1].toLowerCase() === 'x' };
    return { text: line.replace(/^\s*[-*]\s*/, ''), done: false };
  }).filter((i) => i.text);
}

/** Keeps the body meaningful when the type changes rather than dropping it. */
function convertContent(content, from, to) {
  if (from === to) return content;
  if (to === 'checklist') {
    return JSON.stringify(parseChecklist(content));
  }
  return parseChecklist(content)
    .map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}`)
    .join('\n');
}

function matches(note, query) {
  const haystack = [
    note.title,
    note.category,
    note.labels,
    note.type === 'checklist'
      ? parseChecklist(note.content).map((i) => i.text).join(' ')
      : note.content,
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function splitLabels(raw) {
  return String(raw || '').split('|').map((s) => s.trim()).filter(Boolean);
}

function nextSortOrder() {
  return repo.rows('Notes').reduce((max, n) => Math.max(max, parseNum(n.sort_order)), 0) + 1;
}

function normaliseHex(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const hex = s.startsWith('#') ? s.slice(1) : s;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : '';
}
