// Notes: one note holds any mix of rich text, checklists and tables.
//
// There is no note "type" any more — a note is a list of blocks, so a single
// note can open with prose, carry a checklist in the middle and end with a
// table. Categories come from the Taxonomy bank (kind='noteCategory') and are
// managed from here.
//
// Phase 1 is plaintext. The `is_encrypted` column exists so secure notes can
// land later without changing row shape.

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { parseNum, parseBool } from '../schema.js';
import {
  BLOCK_TYPES, parseBlocks, serializeBlocks, blocksToText,
  checklistProgress, blankBlock, isBlockEmpty,
} from '../noteblocks.js';
import { richTextEditor, renderRichText, htmlToText } from '../richtext.js';
import { labelPicker, colourPicker } from './pickers.js';
import {
  el, clear, toast, openModal, confirmDialog, emptyState, fmtDateTime,
} from '../ui.js';

const UNFILED = 'Unfiled';
const FLUSH_DELAY = 1200;

export function renderNotes(container) {
  let query = '';
  const collapsed = new Set(JSON.parse(localStorage.getItem('sufyam.notes.collapsed') || '[]'));

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
            class: 'btn', text: '+ New note', onclick: () => openNoteForm({}, paint),
          }),
        ),
      ]));
      return;
    }

    // Searching flattens the grouping — headers are noise between you and the
    // hit when you already know what you're looking for.
    if (query) {
      container.append(el('div', { class: 'notes-grid' }, matching.map(noteCard)));
      return;
    }

    const pinned = matching.filter((n) => parseBool(n.pinned));
    if (pinned.length) container.append(section('Pinned', 'push_pin', pinned, { pin: true }));

    const rest = matching.filter((n) => !parseBool(n.pinned));
    const buckets = new Map();
    for (const note of rest) {
      const key = (note.category || '').trim() || UNFILED;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(note);
    }

    // Categories appear in the order the taxonomy defines, so the tab reads
    // the way the user arranged it rather than alphabetically.
    const ordered = taxonomy.names(taxonomy.KIND_NOTE_CATEGORY)
      .filter((name) => buckets.has(name));
    const strays = [...buckets.keys()]
      .filter((k) => k !== UNFILED && !ordered.includes(k))
      .sort((a, b) => a.localeCompare(b));

    for (const name of [...ordered, ...strays]) {
      const entry = taxonomy.list(taxonomy.KIND_NOTE_CATEGORY)
        .find((t) => t.name === name);
      container.append(section(name, 'folder', buckets.get(name), { entry }));
    }
    if (buckets.has(UNFILED)) {
      container.append(section(UNFILED, 'folder_open', buckets.get(UNFILED)));
    }
  }

  function toolbar(notes) {
    return el('div', { class: 'notes-toolbar' }, [
      el('div', { class: 'notes-search' }, [
        el('span', { class: 'micon notes-search-icon', text: 'search' }),
        el('input', {
          class: 'input',
          type: 'search',
          placeholder: 'Search notes, checklists, tables, labels…',
          value: query,
          oninput: (e) => { query = e.target.value.trim().toLowerCase(); paint(); },
        }),
      ]),
      el('div', { style: 'flex:1' }),
      query ? el('span', {
        class: 'notes-count',
        text: `${notes.filter((n) => matches(n, query)).length} of ${notes.length}`,
      }) : null,
      el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => openCategoryManager(paint),
      }, [el('span', { class: 'micon', style: 'font-size:17px', text: 'folder_managed' }), 'Categories']),
      el('button', { class: 'btn', text: '+ New note', onclick: () => openNoteForm({}, paint) }),
    ]);
  }

  function section(name, icon, items, { pin = false, entry = null } = {}) {
    const isCollapsed = collapsed.has(name);
    const colour = entry ? normaliseHex(entry.color_hex) : '';

    return el('div', { class: 'notes-section' }, [
      el('button', {
        class: `notes-section-head${isCollapsed ? ' is-collapsed' : ''}`,
        style: colour ? `--section-accent:${colour}` : '',
        onclick: () => {
          if (isCollapsed) collapsed.delete(name); else collapsed.add(name);
          localStorage.setItem('sufyam.notes.collapsed', JSON.stringify([...collapsed]));
          paint();
        },
      }, [
        el('span', { class: 'micon notes-section-caret', text: 'expand_more' }),
        el('span', {
          class: `micon notes-section-icon${pin ? ' is-pinned' : ''}`,
          text: entry?.icon_key ? glyphOr(entry.icon_key, icon) : icon,
        }),
        el('span', { class: 'notes-section-name', text: name }),
        el('span', { class: 'notes-section-count', text: String(items.length) }),
      ]),
      isCollapsed ? null : el('div', { class: 'notes-grid' }, items.map(noteCard)),
    ]);
  }

  function noteCard(note) {
    const blocks = parseBlocks(note.content);
    const labels = splitLabels(note.labels);
    const accent = normaliseHex(note.color_hex);
    const progress = checklistProgress(blocks);

    return el('div', {
      class: 'note-card',
      style: accent ? `--note-accent:${accent};--note-tint:color-mix(in srgb, ${accent} 7%, var(--surface))` : '',
      onclick: (e) => {
        if (e.target.closest('.note-check')) return;
        openNoteForm(note, paint);
      },
    }, [
      el('div', { class: 'note-card-head' }, [
        el('span', { class: 'note-title', text: note.title || '(untitled)' }),
        parseBool(note.pinned)
          ? el('span', { class: 'micon note-pin', text: 'push_pin', title: 'Pinned' })
          : null,
      ]),

      progress.total
        ? el('div', {}, [
            el('div', { class: 'note-progress' }, [
              el('div', {
                class: 'note-progress-fill',
                style: `width:${Math.round((progress.done / progress.total) * 100)}%`,
              }),
            ]),
            el('div', { class: 'note-progress-text', text: `${progress.done} of ${progress.total} done` }),
          ])
        : null,

      el('div', { class: 'note-preview' }, blocks.slice(0, 4).map((b) => previewBlock(b, note))),

      labels.length
        ? el('div', { class: 'note-labels' }, labels.map((l) => el('span', {
            class: 'chip chip-label', text: l,
          })))
        : null,
    ]);
  }

  function previewBlock(block, note) {
    if (block.type === 'checklist') {
      return el('div', { class: 'note-checks' }, block.items.slice(0, 5).map((item, i) => el('label', {
        class: `note-check${item.done ? ' is-done' : ''}`,
      }, [
        el('input', {
          type: 'checkbox',
          checked: item.done || null,
          onclick: (e) => {
            e.stopPropagation();
            // Mutate the cached row so the card stays responsive, then let the
            // debounced batch carry it to the sheet.
            const blocks = parseBlocks(note.content);
            const target = blocks.find((b) => b.id === block.id);
            if (!target) return;
            target.items[i].done = e.target.checked;
            note.content = serializeBlocks(blocks);
            queueSave({ ...note });
            paint();
          },
        }),
        el('span', { class: 'note-check-text', text: item.text || '(blank)' }),
      ])));
    }

    if (block.type === 'table') {
      return el('div', { class: 'note-table-chip' }, [
        el('span', { class: 'micon', style: 'font-size:15px', text: 'table_chart' }),
        `Table · ${block.columns.length} × ${block.rows.length}`,
      ]);
    }

    const text = htmlToText(block.html);
    if (!text) return null;
    return el('div', { class: 'note-body', text });
  }

  function setupPrompt() {
    return el('div', { class: 'center-pane' }, [
      el('div', { class: 'card' }, [
        el('h2', { text: 'Set up Notes' }),
        el('p', {
          text: 'Your spreadsheet does not have a Notes tab yet. This adds it with '
            + 'the right header row; nothing else is touched.',
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

// ---------- category manager ----------

function openCategoryManager(onDone) {
  openModal({
    title: 'Note categories',
    icon: '📁',
    render: (body) => {
      const host = el('div');
      body.append(host);

      const render = () => {
        clear(host);
        const items = taxonomy.list(taxonomy.KIND_NOTE_CATEGORY);
        const usage = taxonomy.noteCategoryUsage();

        if (!items.length) {
          host.append(el('div', { class: 'hint', style: 'padding:8px 0', text: 'No categories yet.' }));
        }

        for (const entry of items) {
          const count = usage.get(entry.name.toLowerCase()) || 0;
          const nameInput = el('input', {
            class: 'input',
            type: 'text',
            value: entry.name,
            onchange: async (e) => {
              const next = e.target.value.trim();
              if (!next || next === entry.name) { e.target.value = entry.name; return; }
              try {
                // Notes reference categories by name, so a rename has to carry
                // the notes with it or they all fall into Unfiled.
                const affected = repo.rows('Notes').filter((n) => (n.category || '').trim() === entry.name);
                await taxonomy.rename(entry, next);
                if (affected.length) {
                  await repo.saveMany('Notes', affected.map((n) => ({ ...n, category: next })));
                }
                toast(affected.length ? `Renamed · ${affected.length} notes moved` : 'Renamed');
                render();
              } catch (err) {
                e.target.value = entry.name;
                toast(err.message, { error: true });
              }
            },
          });

          host.append(el('div', { class: 'cat-manage-row' }, [
            colourPicker(entry.color_hex, async (hex) => {
              try { await taxonomy.update(entry, { color_hex: hex }); render(); }
              catch (err) { toast(err.message, { error: true }); }
            }, { compact: true }),
            nameInput,
            el('span', { class: 'chip', text: `${count}` }),
            el('button', {
              class: 'btn btn-ghost btn-sm',
              title: 'Move up',
              onclick: async () => {
                const ids = items.map((t) => t.id);
                const i = ids.indexOf(entry.id);
                if (i <= 0) return;
                [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                await taxonomy.reorder(taxonomy.KIND_NOTE_CATEGORY, ids);
                render();
              },
            }, [el('span', { class: 'micon', style: 'font-size:16px', text: 'arrow_upward' })]),
            el('button', {
              class: 'btn btn-danger btn-sm',
              title: 'Delete',
              onclick: async () => {
                const ok = await confirmDialog({
                  title: `Delete "${entry.name}"?`,
                  message: 'The category is removed from the list.',
                  warnings: count ? [{
                    icon: '🗒',
                    text: `${count} note${count === 1 ? '' : 's'} use it. They are kept, `
                      + 'but move to Unfiled until you file them somewhere else.',
                  }] : [],
                  note: 'Nothing is erased — the row stays in the sheet and can be restored.',
                  confirmLabel: 'Delete category',
                });
                if (!ok) return;
                try {
                  await taxonomy.remove(entry);
                  const affected = repo.rows('Notes').filter((n) => (n.category || '').trim() === entry.name);
                  if (affected.length) {
                    await repo.saveMany('Notes', affected.map((n) => ({ ...n, category: '' })));
                  }
                  toast('Category deleted');
                  render();
                } catch (err) { toast(err.message, { error: true }); }
              },
            }, [el('span', { class: 'micon', style: 'font-size:16px', text: 'delete' })]),
          ]));
        }

        const input = el('input', {
          class: 'input',
          type: 'text',
          placeholder: 'New category name',
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } },
        });
        const add = async () => {
          const name = input.value.trim();
          if (!name) return;
          try {
            await taxonomy.create(taxonomy.KIND_NOTE_CATEGORY, { name });
            input.value = '';
            toast(`"${name}" added`);
            render();
          } catch (err) { toast(err.message, { error: true }); }
        };

        host.append(el('div', { class: 'cat-manage-add' }, [
          input,
          el('button', { class: 'btn btn-sm', text: 'Add', onclick: add }),
        ]));
      };

      render();
    },
    actions: (close) => [
      el('button', {
        class: 'btn',
        text: 'Done',
        onclick: () => { close(); onDone?.(); },
      }),
    ],
  });
}

// ---------- note editor ----------

function openNoteForm(note, onSaved) {
  const isEdit = Boolean(note.id);
  const values = {
    title: note.title || '',
    category: (note.category || '').trim(),
    labels: note.labels || '',
    pinned: parseBool(note.pinned),
    color_hex: normaliseHex(note.color_hex) || '',
  };
  let blocks = parseBlocks(note.content);
  if (!blocks.length) blocks = [blankBlock('text')];

  const errorNode = el('div', { class: 'error hidden' });

  openModal({
    title: isEdit ? 'Edit note' : 'New note',
    icon: '🗒',
    wide: true,
    render: (body) => {
      const blockHost = el('div', { class: 'block-list' });

      const renderBlocks = () => {
        clear(blockHost);
        blocks.forEach((block, index) => {
          blockHost.append(blockEditor(block, {
            index,
            total: blocks.length,
            onMove: (dir) => {
              const to = index + dir;
              if (to < 0 || to >= blocks.length) return;
              [blocks[index], blocks[to]] = [blocks[to], blocks[index]];
              renderBlocks();
            },
            onRemove: () => {
              blocks.splice(index, 1);
              if (!blocks.length) blocks.push(blankBlock('text'));
              renderBlocks();
            },
          }));
        });

        blockHost.append(el('div', { class: 'block-add' },
          BLOCK_TYPES.map((t) => el('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            onclick: (e) => {
              e.preventDefault();
              blocks.push(blankBlock(t.type));
              renderBlocks();
            },
          }, [
            el('span', { class: 'micon', style: 'font-size:16px', text: t.icon }),
            t.label,
          ]))));
      };

      const categories = taxonomy.names(taxonomy.KIND_NOTE_CATEGORY);
      const categorySelect = el('select', {
        class: 'select',
        onchange: (e) => { values.category = e.target.value; },
      }, [
        el('option', { value: '', text: '— Unfiled —' }),
        ...categories.map((name) => el('option', {
          value: name, text: name, selected: values.category === name,
        })),
        // A category the note already has but the taxonomy doesn't know, e.g.
        // typed before this list existed.
        ...(values.category && !categories.includes(values.category)
          ? [el('option', { value: values.category, text: `${values.category} (not in list)`, selected: true })]
          : []),
      ]);

      body.append(
        el('div', { class: 'field-row' }, [
          field('Title', el('input', {
            class: 'input',
            type: 'text',
            value: values.title,
            placeholder: 'Wifi details, Shopping, …',
            oninput: (e) => { values.title = e.target.value; },
          }), { required: true, error: errorNode }),
          field('Category', categorySelect),
        ]),

        field('Colour', colourPicker(values.color_hex, (hex) => { values.color_hex = hex; })),
        field('Content', blockHost),
        field('Labels', labelPicker(values.labels, (names) => { values.labels = names.join('|'); })),

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

      renderBlocks();
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
          // Drop blocks the user added but never filled, so an accidental
          // "+ Table" doesn't leave an empty grid on the card forever.
          const kept = blocks.filter((b) => !isBlockEmpty(b));
          await repo.save('Notes', {
            ...(isEdit ? note : {}),
            title: values.title.trim(),
            type: 'rich',
            category: values.category.trim(),
            content: serializeBlocks(kept.length ? kept : [blankBlock('text')]),
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

// ---------- block editors ----------

function blockEditor(block, { index, total, onMove, onRemove }) {
  const meta = BLOCK_TYPES.find((t) => t.type === block.type) || BLOCK_TYPES[0];

  const head = el('div', { class: 'block-head' }, [
    el('span', { class: 'micon block-icon', text: meta.icon }),
    el('span', { class: 'block-kind', text: meta.label }),
    el('div', { style: 'flex:1' }),
    el('button', {
      type: 'button', class: 'btn btn-ghost btn-sm', title: 'Move up',
      disabled: index === 0 || null,
      onclick: (e) => { e.preventDefault(); onMove(-1); },
    }, [el('span', { class: 'micon', style: 'font-size:15px', text: 'arrow_upward' })]),
    el('button', {
      type: 'button', class: 'btn btn-ghost btn-sm', title: 'Move down',
      disabled: index === total - 1 || null,
      onclick: (e) => { e.preventDefault(); onMove(1); },
    }, [el('span', { class: 'micon', style: 'font-size:15px', text: 'arrow_downward' })]),
    el('button', {
      type: 'button', class: 'btn btn-ghost btn-sm', title: 'Remove block',
      onclick: (e) => { e.preventDefault(); onRemove(); },
    }, [el('span', { class: 'micon', style: 'font-size:15px', text: 'close' })]),
  ]);

  let bodyNode;
  if (block.type === 'checklist') bodyNode = checklistEditor(block);
  else if (block.type === 'table') bodyNode = tableEditor(block);
  else bodyNode = richTextEditor(block.html, (html) => { block.html = html; });

  return el('div', { class: 'block' }, [head, bodyNode]);
}

function checklistEditor(block) {
  const host = el('div', { class: 'checklist-editor' });

  const render = () => {
    clear(host);
    block.items.forEach((item, i) => {
      host.append(el('div', { class: `checklist-row${item.done ? ' is-done' : ''}` }, [
        el('input', {
          type: 'checkbox',
          checked: item.done || null,
          onchange: (e) => { block.items[i].done = e.target.checked; render(); },
        }),
        el('input', {
          class: 'input checklist-text',
          type: 'text',
          value: item.text,
          placeholder: 'Item',
          oninput: (e) => { block.items[i].text = e.target.value; },
          onkeydown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              block.items.splice(i + 1, 0, { text: '', done: false });
              render();
              host.querySelectorAll('.checklist-text')[i + 1]?.focus();
            }
            if (e.key === 'Backspace' && !e.target.value && block.items.length > 1) {
              e.preventDefault();
              block.items.splice(i, 1);
              render();
              host.querySelectorAll('.checklist-text')[Math.max(0, i - 1)]?.focus();
            }
          },
        }),
        el('button', {
          type: 'button', class: 'btn btn-ghost btn-sm', title: 'Remove',
          onclick: (e) => {
            e.preventDefault();
            block.items.splice(i, 1);
            if (!block.items.length) block.items.push({ text: '', done: false });
            render();
          },
        }, [el('span', { class: 'micon', style: 'font-size:15px', text: 'close' })]),
      ]));
    });

    host.append(el('button', {
      type: 'button', class: 'btn btn-ghost btn-sm checklist-add',
      onclick: (e) => {
        e.preventDefault();
        block.items.push({ text: '', done: false });
        render();
        const inputs = host.querySelectorAll('.checklist-text');
        inputs[inputs.length - 1]?.focus();
      },
    }, [el('span', { class: 'micon', style: 'font-size:16px', text: 'add' }), 'Add item']));
  };

  render();
  return host;
}

function tableEditor(block) {
  const host = el('div', { class: 'table-editor' });

  const render = () => {
    clear(host);

    const head = el('tr', {}, [
      ...block.columns.map((col, c) => el('th', {}, [
        el('input', {
          class: 'table-cell table-head-cell',
          type: 'text',
          value: col,
          oninput: (e) => { block.columns[c] = e.target.value; },
        }),
        el('button', {
          type: 'button', class: 'table-del', title: 'Delete column',
          onclick: (e) => {
            e.preventDefault();
            if (block.columns.length <= 1) return;
            block.columns.splice(c, 1);
            block.rows.forEach((r) => r.splice(c, 1));
            render();
          },
        }, [el('span', { class: 'micon', style: 'font-size:14px', text: 'close' })]),
      ])),
      el('th', { class: 'table-add-col' }, [
        el('button', {
          type: 'button', class: 'btn btn-ghost btn-sm', title: 'Add column',
          onclick: (e) => {
            e.preventDefault();
            block.columns.push(`Column ${block.columns.length + 1}`);
            block.rows.forEach((r) => r.push(''));
            render();
          },
        }, [el('span', { class: 'micon', style: 'font-size:15px', text: 'add' })]),
      ]),
    ]);

    const bodyRows = block.rows.map((row, r) => el('tr', {}, [
      ...row.map((cell, c) => el('td', {}, [
        el('input', {
          class: 'table-cell',
          type: 'text',
          value: cell,
          oninput: (e) => { block.rows[r][c] = e.target.value; },
        }),
      ])),
      el('td', { class: 'table-row-actions' }, [
        el('button', {
          type: 'button', class: 'table-del', title: 'Delete row',
          onclick: (e) => {
            e.preventDefault();
            block.rows.splice(r, 1);
            if (!block.rows.length) block.rows.push(block.columns.map(() => ''));
            render();
          },
        }, [el('span', { class: 'micon', style: 'font-size:14px', text: 'close' })]),
      ]),
    ]));

    host.append(
      el('div', { class: 'table-scroll' }, [
        el('table', { class: 'note-table' }, [
          el('thead', {}, [head]),
          el('tbody', {}, bodyRows),
        ]),
      ]),
      el('button', {
        type: 'button', class: 'btn btn-ghost btn-sm',
        style: 'margin-top:6px',
        onclick: (e) => {
          e.preventDefault();
          block.rows.push(block.columns.map(() => ''));
          render();
        },
      }, [el('span', { class: 'micon', style: 'font-size:16px', text: 'add' }), 'Add row']),
    );
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

function matches(note, query) {
  return [
    note.title,
    note.category,
    note.labels,
    blocksToText(parseBlocks(note.content)),
  ].join(' ').toLowerCase().includes(query);
}

function splitLabels(raw) {
  return String(raw || '').split('|').map((s) => s.trim()).filter(Boolean);
}

function nextSortOrder() {
  return repo.rows('Notes').reduce((max, n) => Math.max(max, parseNum(n.sort_order)), 0) + 1;
}

function glyphOr(key, fallback) {
  return key || fallback;
}

function normaliseHex(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const hex = s.startsWith('#') ? s.slice(1) : s;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : '';
}

export { renderRichText };
