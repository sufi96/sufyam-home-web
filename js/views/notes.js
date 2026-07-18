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
import * as vault from '../vault.js';
import { isEnvelope } from '../crypto.js';
import { parseNum, parseBool } from '../schema.js';
import {
  BLOCK_TYPES, parseBlocks, serializeBlocks, blocksToText,
  checklistProgress, blankBlock, isBlockEmpty,
} from '../noteblocks.js';
import { richTextEditor, renderRichText, htmlToText } from '../richtext.js';
import { labelPicker, colourPicker } from './pickers.js';
import {
  el, clear, append, toast, openModal, confirmDialog, emptyState, fmtDateTime,
} from '../ui.js';

const UNFILED = 'Unfiled';
const FLUSH_DELAY = 1200;

// Decrypted bodies for this session, so the tab renders and searches without
// re-running AES for every repaint. Cleared on lock.
const plaintext = new Map();

const isSecure = (note) => isEnvelope(note.content);

/** A note's readable body, or null when it's encrypted and still locked. */
function bodyOf(note) {
  if (!isSecure(note)) return note.content;
  return plaintext.has(note.id) ? plaintext.get(note.id) : null;
}

async function decryptAll() {
  plaintext.clear();
  if (!vault.isUnlocked()) return;
  for (const note of repo.rows('Notes')) {
    if (note.id === vault.VAULT_ID || !isSecure(note)) continue;
    try {
      plaintext.set(note.id, await vault.decrypt(note.content));
    } catch {
      // A row encrypted under a different passphrase, or corrupted. Left out
      // of the cache so it renders as locked rather than as an error.
    }
  }
}

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

    const notes = repo.rows('Notes').filter((n) => n.id !== vault.VAULT_ID);
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
      lockButton(),
      vault.vaultExists() ? el('button', {
        class: 'btn btn-ghost btn-sm btn-icon',
        title: 'Vault settings',
        onclick: () => openVaultSettings(paint),
      }, [el('span', { class: 'micon', style: 'font-size:17px', text: 'key' })]) : null,
      el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => openCategoryManager(paint),
      }, [el('span', { class: 'micon', style: 'font-size:17px', text: 'folder_managed' }), 'Categories']),
      el('button', { class: 'btn', text: '+ New note', onclick: () => openNoteForm({}, paint) }),
    ]);
  }

  function lockButton() {
    if (!vault.vaultExists()) return null;
    const unlocked = vault.isUnlocked();
    return el('button', {
      class: `btn btn-ghost btn-sm${unlocked ? '' : ' is-locked'}`,
      title: unlocked ? 'Lock secure notes' : 'Unlock secure notes',
      onclick: async () => {
        if (unlocked) {
          vault.lock();
          plaintext.clear();
          toast('Locked');
          paint();
        } else if (await promptUnlock()) {
          await decryptAll();
          paint();
        }
      },
    }, [
      el('span', { class: 'micon', style: 'font-size:17px', text: unlocked ? 'lock_open' : 'lock' }),
      unlocked ? 'Lock' : 'Unlock',
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
    const readable = bodyOf(note);
    if (readable === null) return lockedCard(note);
    const blocks = parseBlocks(readable);
    const labels = splitLabels(note.labels);
    const accent = normaliseHex(note.color_hex);
    const progress = checklistProgress(blocks);

    return el('div', {
      class: 'note-card',
      style: accent ? `--note-accent:${accent};--note-tint:color-mix(in srgb, ${accent} 7%, var(--surface))` : '',
      onclick: () => openNoteViewer(note, { onChanged: paint, onToggle: queueSave }),
    }, [
      el('div', { class: 'note-card-head' }, [
        isSecure(note)
          ? el('span', { class: 'micon note-secure', text: 'lock', title: 'Encrypted' })
          : null,
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

      el('div', { class: 'note-preview' }, blocks.slice(0, 4).map(previewBlock)),

      labels.length
        ? el('div', { class: 'note-labels' }, labels.map((l) => el('span', {
            class: 'chip chip-label', text: l,
          })))
        : null,

      authorLine(note),
    ]);
  }

  /**
   * A locked note still shows its title, category and labels — those stay in
   * plain columns so the tab remains navigable without the passphrase. Only
   * the body is ciphertext.
   */
  function lockedCard(note) {
    return el('div', {
      class: 'note-card is-locked',
      onclick: () => promptUnlock(),
    }, [
      el('div', { class: 'note-card-head' }, [
        el('span', { class: 'micon note-secure', text: 'lock' }),
        el('span', { class: 'note-title', text: note.title || '(untitled)' }),
      ]),
      el('div', { class: 'locked-body' }, [
        el('span', { class: 'micon locked-icon', text: 'lock' }),
        el('div', { class: 'locked-text', text: 'Encrypted — unlock to read' }),
      ]),
      splitLabels(note.labels).length
        ? el('div', { class: 'note-labels' }, splitLabels(note.labels).map((l) => el('span', {
            class: 'chip chip-label', text: l,
          })))
        : null,

      authorLine(note),
    ]);
  }

  /**
   * Card previews are read-only summaries. Checkboxes used to be live here,
   * but a card is something you scan — mis-ticking an item while trying to
   * open a note is worse than the shortcut was worth. Ticking lives in the
   * viewer now.
   */
  function previewBlock(block) {
    if (block.type === 'checklist') {
      const shown = block.items.slice(0, 4);
      const extra = block.items.length - shown.length;
      return el('div', { class: 'preview-checks' }, [
        ...shown.map((item) => el('div', {
          class: `preview-check${item.done ? ' is-done' : ''}`,
        }, [
          el('span', {
            class: 'micon preview-check-box',
            text: item.done ? 'check_box' : 'check_box_outline_blank',
          }),
          el('span', { class: 'preview-check-text', text: item.text || '(blank)' }),
        ])),
        extra > 0
          ? el('div', { class: 'preview-more', text: `+${extra} more item${extra === 1 ? '' : 's'}` })
          : null,
      ]);
    }

    if (block.type === 'table') {
      return el('div', { class: 'note-table-chip' }, [
        el('span', { class: 'micon', style: 'font-size:15px', text: 'table_chart' }),
        el('span', { class: 'note-table-chip-title', text: block.title || 'Table' }),
        el('span', {
          class: 'note-table-chip-size',
          text: `${block.columns.length} × ${block.rows.length}`,
        }),
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

  (async () => {
    if (!vault.isUnlocked() && vault.isRemembered()) {
      if (await vault.restore()) await decryptAll();
    }
    paint();
  })();
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
  let blocks = parseBlocks(isEdit ? bodyOf(note) : note.content);
  if (!blocks.length) blocks = [blankBlock('text')];
  values.secure = isSecure(note);

  const errorNode = el('div', { class: 'error hidden' });

  openModal({
    title: isEdit ? 'Edit note' : 'New note',
    icon: '🗒',
    size: 'xl',
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

      const categorySelect = el('select', {
        class: 'select',
        onchange: (e) => { values.category = e.target.value; },
      });

      const rebuildCategories = () => {
        clear(categorySelect);
        const categories = taxonomy.names(taxonomy.KIND_NOTE_CATEGORY);
        categorySelect.append(el('option', { value: '', text: '— Unfiled —' }));
        for (const name of categories) {
          categorySelect.append(el('option', {
            value: name, text: name, selected: values.category === name,
          }));
        }
        // A category the note already carries but the taxonomy doesn't know,
        // e.g. typed before this list existed.
        if (values.category && !categories.includes(values.category)) {
          categorySelect.append(el('option', {
            value: values.category,
            text: `${values.category} (not in list)`,
            selected: true,
          }));
        }
      };
      rebuildCategories();

      // Creating a category shouldn't mean abandoning the note you're writing.
      const newCategoryRow = el('div', { class: 'inline-add hidden' });
      const newCategoryInput = el('input', {
        class: 'input',
        type: 'text',
        placeholder: 'New category name',
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); addCategory(); }
          if (e.key === 'Escape') { e.preventDefault(); newCategoryRow.classList.add('hidden'); }
        },
      });

      async function addCategory() {
        const name = newCategoryInput.value.trim();
        if (!name) return;
        try {
          await taxonomy.create(taxonomy.KIND_NOTE_CATEGORY, { name });
          values.category = name;
          newCategoryInput.value = '';
          newCategoryRow.classList.add('hidden');
          rebuildCategories();
          toast(`"${name}" added`);
        } catch (err) {
          toast(err.message, { error: true });
        }
      }

      newCategoryRow.append(
        newCategoryInput,
        el('button', { type: 'button', class: 'btn btn-sm', text: 'Add', onclick: addCategory }),
      );

      const categoryField = el('div', {}, [
        el('div', { class: 'select-with-add' }, [
          categorySelect,
          el('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            title: 'New category',
            onclick: (e) => {
              e.preventDefault();
              newCategoryRow.classList.toggle('hidden');
              if (!newCategoryRow.classList.contains('hidden')) newCategoryInput.focus();
            },
          }, [el('span', { class: 'micon', style: 'font-size:17px', text: 'add' })]),
        ]),
        newCategoryRow,
      ]);

      append(
        body,
        el('div', { class: 'field-row' }, [
          field('Title', el('input', {
            class: 'input',
            type: 'text',
            value: values.title,
            placeholder: 'Wifi details, Shopping, …',
            oninput: (e) => { values.title = e.target.value; },
          }), { required: true, error: errorNode }),
          field('Category', categoryField),
        ]),

        field('Colour', colourPicker(values.color_hex, (hex) => { values.color_hex = hex; })),
        field('Content', blockHost),
        field('Labels', labelPicker(values.labels, (names) => { values.labels = names.join('|'); })),

        el('label', { class: `switch-row${values.secure ? ' is-on' : ''}` }, [
          el('span', { class: 'micon switch-icon', text: 'lock' }),
          el('div', { class: 'switch-text' }, [
            el('div', { class: 'switch-title', text: 'Encrypt this note' }),
            el('div', {
              class: 'switch-sub',
              text: 'The body is stored as ciphertext. Title, category and labels stay readable '
                + 'so the note can still be found.',
            }),
          ]),
          el('span', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: values.secure || null,
              onchange: async (e) => {
                const row = e.target.closest('.switch-row');
                if (e.target.checked) {
                  const ready = await ensureVaultReady();
                  if (!ready) { e.target.checked = false; return; }
                }
                values.secure = e.target.checked;
                row.classList.toggle('is-on', values.secure);
              },
            }),
            el('span', { class: 'switch-track' }, [el('span', { class: 'switch-thumb' })]),
          ]),
        ]),

        el('label', { class: `switch-row${values.pinned ? ' is-on' : ''}` }, [
          el('span', { class: 'micon switch-icon', text: 'push_pin' }),
          el('div', { class: 'switch-text' }, [
            el('div', { class: 'switch-title', text: 'Pin to the top' }),
            el('div', { class: 'switch-sub', text: 'Keeps this note in its own section above the categories' }),
          ]),
          el('span', { class: 'switch' }, [
            el('input', {
              type: 'checkbox',
              checked: values.pinned || null,
              onchange: (e) => {
                values.pinned = e.target.checked;
                e.target.closest('.switch-row').classList.toggle('is-on', values.pinned);
              },
            }),
            el('span', { class: 'switch-track' }, [el('span', { class: 'switch-thumb' })]),
          ]),
        ]),

        auditBlock(note),
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
          const body = serializeBlocks(kept.length ? kept : [blankBlock('text')]);
          const stored = values.secure ? await vault.encrypt(body) : body;

          const saved = await repo.save('Notes', {
            ...(isEdit ? note : {}),
            title: values.title.trim(),
            type: 'rich',
            category: values.category.trim(),
            content: stored,
            labels: values.labels,
            pinned: values.pinned,
            is_encrypted: values.secure,
            color_hex: values.color_hex,
            sort_order: isEdit ? parseNum(note.sort_order, 0) : nextSortOrder(),
          });

          // Keep the session cache in step so the note stays readable without
          // a round trip through the vault.
          if (values.secure) plaintext.set(saved.id, body);
          else plaintext.delete(saved.id);
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

// ---------- viewer ----------

/**
 * Read-only view of a note. Opening a note to read it shouldn't drop you into
 * an editor — but checklists stay tickable here, because ticking things off is
 * the most common reason to open one at all.
 */
function openNoteViewer(note, { onChanged, onToggle }) {
  const readable = bodyOf(note);
  if (readable === null) return;   // locked — the card opens the unlock prompt
  const blocks = parseBlocks(readable);
  const labels = splitLabels(note.labels);
  const accent = normaliseHex(note.color_hex);
  const progress = checklistProgress(blocks);

  openModal({
    title: note.title || '(untitled)',
    icon: '🗒',
    size: 'xl',
    render: (body) => {
      const meta = [];
      if (note.category) {
        meta.push(el('span', { class: 'view-chip' }, [
          el('span', { class: 'micon', style: 'font-size:15px', text: 'folder' }),
          note.category,
        ]));
      }
      if (parseBool(note.pinned)) {
        meta.push(el('span', { class: 'view-chip is-pinned' }, [
          el('span', { class: 'micon', style: 'font-size:15px', text: 'push_pin' }),
          'Pinned',
        ]));
      }
      if (progress.total) {
        meta.push(el('span', { class: 'view-chip' }, [
          el('span', { class: 'micon', style: 'font-size:15px', text: 'checklist' }),
          `${progress.done} of ${progress.total} done`,
        ]));
      }
      if (isSecure(note)) {
        meta.push(el('span', { class: 'view-chip is-secure' }, [
          el('span', { class: 'micon', style: 'font-size:15px', text: 'lock' }),
          'Encrypted',
        ]));
      }
      const who = personName(note.created_by);
      if (who) {
        meta.push(el('span', { class: 'view-chip' }, [
          el('span', { class: 'micon', style: 'font-size:15px', text: 'person' }),
          who,
        ]));
      }
      if (meta.length) body.append(el('div', { class: 'view-meta' }, meta));

      const host = el('div', {
        class: 'view-body',
        style: accent ? `--note-accent:${accent}` : '',
      });

      const renderBody = () => {
        clear(host);
        for (const block of parseBlocks(bodyOf(note))) {
          host.append(viewBlock(block, note, () => { renderBody(); onToggle?.(note); }));
        }
      };
      renderBody();
      body.append(host);

      if (labels.length) {
        body.append(el('div', { class: 'view-labels' }, labels.map((l) => el('span', {
          class: 'chip chip-label', text: l,
        }))));
      }

      const audit = auditBlock(note);
      if (audit) body.append(audit);
    },
    actions: (close) => [
      el('button', {
        class: 'btn btn-ghost btn-danger',
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
            onChanged?.();
          } catch (err) { toast(err.message, { error: true }); }
        },
      }),
      el('button', { class: 'btn btn-ghost', text: 'Close', onclick: close }),
      el('button', {
        class: 'btn',
        onclick: () => { close(); openNoteForm(note, onChanged); },
      }, [el('span', { class: 'micon', style: 'font-size:17px', text: 'edit' }), 'Edit']),
    ],
  });
}

function viewBlock(block, note, onChange) {
  if (block.type === 'checklist') {
    return el('div', { class: 'view-checklist' }, block.items.map((item, i) => el('label', {
      class: `view-check${item.done ? ' is-done' : ''}`,
    }, [
      el('input', {
        type: 'checkbox',
        checked: item.done || null,
        onchange: (e) => {
          const blocks = parseBlocks(bodyOf(note));
          const target = blocks.find((b) => b.id === block.id);
          if (!target) return;
          target.items[i].done = e.target.checked;
          setBody(note, serializeBlocks(blocks));
          onChange();
        },
      }),
      el('span', { text: item.text || '(blank)' }),
    ])));
  }

  if (block.type === 'table') {
    return el('div', {}, [
      block.title ? el('div', { class: 'view-table-title', text: block.title }) : null,
      el('div', { class: 'table-scroll' }, [
        el('table', { class: 'note-table is-view' }, [
          el('thead', {}, [el('tr', {}, block.columns.map((c) => el('th', { text: c })))]),
          el('tbody', {}, block.rows.map((row) => el('tr', {},
            row.map((cell) => el('td', { text: cell }))))),
        ]),
      ]),
    ]);
  }

  return renderRichText(block.html);
}

/**
 * Audit trail, or nothing at all. A note being created has no timestamps yet,
 * and a hand-edited row can hold the literal strings "null"/"undefined" —
 * neither should be rendered as if it were a real value.
 */
function auditBlock(note) {
  const when = usable(note.created_at) || usable(note.updated_at);
  if (!when) return null;
  const rows = [];
  if (usable(note.created_at)) {
    rows.push(el('div', { text: `Created ${fmtDateTime(note.created_at)}${byLine(note.created_by)}` }));
  }
  if (usable(note.updated_at)) {
    rows.push(el('div', { text: `Updated ${fmtDateTime(note.updated_at)}${byLine(note.updated_by)}` }));
  }
  return rows.length ? el('div', { class: 'audit-note' }, rows) : null;
}

function usable(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s && s !== 'null' && s !== 'undefined' ? String(v).trim() : '';
}

function byLine(who) {
  const clean = usable(who);
  return clean ? ` by ${clean}` : '';
}

// ---------- vault setup ----------

/**
 * Makes sure the vault exists and is open, creating it on first use.
 * Resolves false if the user backs out, so the caller can undo its toggle.
 */
async function ensureVaultReady() {
  if (vault.isUnlocked()) return true;
  if (vault.vaultExists()) return promptUnlock();
  return promptCreateVault();
}

function promptCreateVault() {
  return new Promise((resolve) => {
    let settled = false;
    // Captured from render() rather than looked up in the document: this
    // dialog opens on top of the note editor, so a global querySelector would
    // find the editor's body and close button instead of these.
    let submit = () => {};
    let dismiss = () => {};

    openModal({
      title: 'Create a passphrase',
      icon: '\u{1F510}',
      render: (body, close) => {
        dismiss = close;
        const error = el('div', { class: 'error hidden' });
        const first = el('input', { class: 'input', type: 'password', placeholder: 'Passphrase' });
        const second = el('input', {
          class: 'input',
          type: 'password',
          placeholder: 'Repeat it',
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } },
        });
        const strength = el('div', { class: 'hint' });

        first.addEventListener('input', () => {
          const n = first.value.length;
          strength.textContent = n === 0 ? ''
            : n < 8 ? `${8 - n} more character${8 - n === 1 ? '' : 's'} needed`
              : n < 14 ? 'Acceptable \u2014 longer is better'
                : 'Good length';
        });

        submit = async () => {
          error.classList.add('hidden');
          if (first.value !== second.value) {
            error.textContent = 'The two entries do not match';
            error.classList.remove('hidden');
            return;
          }
          try {
            await vault.create(first.value);
            await vault.remember();
            settled = true;
            toast('Vault created');
            dismiss();
            resolve(true);
          } catch (err) {
            error.textContent = err.message;
            error.classList.remove('hidden');
          }
        };

        append(
          body,
          el('p', {
            class: 'confirm-message',
            text: 'Secure notes are encrypted with a passphrase before they reach the '
              + 'spreadsheet. Anyone opening the sheet without it sees only ciphertext.',
          }),
          el('div', { class: 'confirm-warnings' }, [
            el('div', { class: 'confirm-warning' }, [
              el('span', { class: 'confirm-warning-icon', text: '\u26A0' }),
              el('span', {
                text: 'There is no recovery. If you forget this passphrase the encrypted '
                  + 'notes cannot be read again \u2014 not by this app, not by Google, not by anyone.',
              }),
            ]),
            el('div', { class: 'confirm-warning' }, [
              el('span', { class: 'confirm-warning-icon', text: '\u{1F465}' }),
              el('span', {
                text: 'Everyone you share the sheet with needs this same passphrase to read '
                  + 'secure notes. Tell them outside the sheet, not inside it.',
              }),
            ]),
          ]),
          field('Passphrase', first, { required: true }),
          strength,
          field('Confirm', second, { required: true, error }),
        );
        setTimeout(() => first.focus(), 50);
      },
      actions: (close) => [
        el('button', {
          class: 'btn btn-ghost',
          text: 'Cancel',
          onclick: () => { close(); if (!settled) resolve(false); },
        }),
        el('button', { class: 'btn', text: 'Create vault', onclick: () => submit() }),
      ],
    });
  });
}

function promptUnlock() {
  return new Promise((resolve) => {
    let settled = false;
    let submit = () => {};
    let dismiss = () => {};

    openModal({
      title: 'Unlock secure notes',
      icon: '\u{1F512}',
      render: (body, close) => {
        dismiss = close;
        const error = el('div', { class: 'error hidden' });
        const input = el('input', {
          class: 'input',
          type: 'password',
          placeholder: 'Passphrase',
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } },
        });
        const remember = el('input', { type: 'checkbox', checked: true });

        submit = async () => {
          error.classList.add('hidden');
          try {
            if (!(await vault.unlock(input.value))) {
              error.textContent = 'That passphrase does not open this vault';
              error.classList.remove('hidden');
              return;
            }
            if (remember.checked) await vault.remember();
            settled = true;
            toast('Unlocked');
            dismiss();
            resolve(true);
          } catch (err) {
            error.textContent = err.message;
            error.classList.remove('hidden');
          }
        };

        append(
          body,
          el('p', {
            class: 'confirm-message',
            text: 'Enter the passphrase for this sheet\u2019s secure notes.',
          }),
          field('Passphrase', input, { error }),
          el('label', { class: 'switch-row is-on' }, [
            el('span', { class: 'micon switch-icon', text: 'devices' }),
            el('div', { class: 'switch-text' }, [
              el('div', { class: 'switch-title', text: 'Remember on this device' }),
              el('div', {
                class: 'switch-sub',
                text: 'Stores the derived key in this browser, never the passphrase itself',
              }),
            ]),
            el('span', { class: 'switch' }, [
              remember,
              el('span', { class: 'switch-track' }, [el('span', { class: 'switch-thumb' })]),
            ]),
          ]),
        );
        setTimeout(() => input.focus(), 50);
      },
      actions: (close) => [
        el('button', {
          class: 'btn btn-ghost',
          text: 'Cancel',
          onclick: () => { close(); if (!settled) resolve(false); },
        }),
        el('button', { class: 'btn', text: 'Unlock', onclick: () => submit() }),
      ],
    });
  });
}

function openVaultSettings(onChanged) {
  openModal({
    title: 'Vault',
    icon: '\u{1F511}',
    render: (body, close) => {
      const secureCount = repo.rows('Notes')
        .filter((n) => n.id !== vault.VAULT_ID && isEnvelope(n.content)).length;

      append(
        body,
        el('div', { class: 'vault-status' }, [
          el('span', {
            class: 'micon',
            style: `font-size:20px;color:${vault.isUnlocked() ? 'var(--accent)' : 'var(--text-dim)'}`,
            text: vault.isUnlocked() ? 'lock_open' : 'lock',
          }),
          el('div', {}, [
            el('div', {
              class: 'switch-title',
              text: vault.isUnlocked() ? 'Unlocked' : 'Locked',
            }),
            el('div', {
              class: 'switch-sub',
              text: `${secureCount} encrypted note${secureCount === 1 ? '' : 's'} on this sheet`,
            }),
          ]),
        ]),

        el('div', { class: 'vault-actions' }, [
          vault.isUnlocked() ? el('button', {
            class: 'btn btn-ghost btn-block',
            onclick: () => { vault.lock(); plaintext.clear(); close(); toast('Locked'); onChanged?.(); },
          }, [el('span', { class: 'micon', style: 'font-size:17px', text: 'lock' }), 'Lock now']) : null,

          el('button', {
            class: 'btn btn-ghost btn-block',
            onclick: async () => {
              close();
              if (await promptChangePassphrase()) onChanged?.();
            },
          }, [el('span', { class: 'micon', style: 'font-size:17px', text: 'password' }), 'Change passphrase']),

          vault.isRemembered() ? el('button', {
            class: 'btn btn-ghost btn-danger btn-block',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Forget on this device?',
                message: 'The key stored in this browser is deleted. Your notes stay encrypted '
                  + 'and unchanged.',
                note: 'You will need the passphrase again on this device.',
                confirmLabel: 'Forget it',
              });
              if (!ok) return;
              vault.forget();
              vault.lock();
              plaintext.clear();
              close();
              toast('Key forgotten on this device');
              onChanged?.();
            },
          }, [el('span', { class: 'micon', style: 'font-size:17px', text: 'devices_off' }), 'Forget on this device']) : null,
        ]),

        el('p', {
          class: 'confirm-note',
          text: 'The passphrase itself is never stored. Only a key derived from it is kept, '
            + 'and only when you ask this device to remember.',
        }),
      );
    },
    actions: (close) => [el('button', { class: 'btn', text: 'Done', onclick: close })],
  });
}

function promptChangePassphrase() {
  return new Promise((resolve) => {
    let settled = false;
    let submit = () => {};
    let dismiss = () => {};

    openModal({
      title: 'Change passphrase',
      icon: '\u{1F510}',
      render: (body, close) => {
        dismiss = close;
        const error = el('div', { class: 'error hidden' });
        const current = el('input', { class: 'input', type: 'password', placeholder: 'Current passphrase' });
        const next = el('input', { class: 'input', type: 'password', placeholder: 'New passphrase' });
        const again = el('input', {
          class: 'input',
          type: 'password',
          placeholder: 'Repeat the new one',
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } },
        });

        submit = async () => {
          error.classList.add('hidden');
          if (next.value !== again.value) {
            error.textContent = 'The two new entries do not match';
            error.classList.remove('hidden');
            return;
          }
          const button = body.parentElement.querySelector('.modal-foot .btn:not(.btn-ghost)');
          if (button) { button.disabled = true; button.textContent = 'Re-encrypting\u2026'; }
          try {
            const n = await vault.changePassphrase(current.value, next.value);
            await decryptAll();
            settled = true;
            toast(`Passphrase changed \u00b7 ${n} note${n === 1 ? '' : 's'} re-encrypted`);
            dismiss();
            resolve(true);
          } catch (err) {
            error.textContent = err.message;
            error.classList.remove('hidden');
            if (button) { button.disabled = false; button.textContent = 'Change it'; }
          }
        };

        append(
          body,
          el('p', {
            class: 'confirm-message',
            text: 'Every encrypted note is decrypted and re-encrypted under the new '
              + 'passphrase, as a single write \u2014 if it fails, nothing moved and the old '
              + 'passphrase still opens everything.',
          }),
          field('Current', current, { required: true }),
          field('New', next, { required: true }),
          field('Confirm', again, { required: true, error }),
        );
        setTimeout(() => current.focus(), 50);
      },
      actions: (close) => [
        el('button', {
          class: 'btn btn-ghost',
          text: 'Cancel',
          onclick: () => { close(); if (!settled) resolve(false); },
        }),
        el('button', { class: 'btn', text: 'Change it', onclick: () => submit() }),
      ],
    });
  });
}

// ---------- block editors ----------

function blockEditor(block, { index, total, onMove, onRemove }) {
  const meta = BLOCK_TYPES.find((t) => t.type === block.type) || BLOCK_TYPES[0];

  const head = el('div', { class: 'block-head' }, [
    el('span', { class: 'micon block-icon', text: meta.icon }),
    el('span', { class: 'block-kind', text: meta.label }),
    block.type === 'table' && block.title
      ? el('span', { class: 'block-title', text: block.title })
      : null,
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

    // Named tables so a note holding several of them stays navigable.
    host.append(el('input', {
      class: 'input table-title',
      type: 'text',
      value: block.title || '',
      placeholder: 'Table title (optional)',
      oninput: (e) => { block.title = e.target.value; },
    }));

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
  // A locked note is searchable by its plain columns only — its body is
  // ciphertext, and searching ciphertext is meaningless.
  const readable = bodyOf(note);
  return [
    note.title,
    note.category,
    note.labels,
    readable === null ? '' : blocksToText(parseBlocks(readable)),
  ].join(' ').toLowerCase().includes(query);
}

/** Writes a body back, keeping the encrypted cache and the row consistent. */
function setBody(note, content) {
  if (isSecure(note)) plaintext.set(note.id, content);
  else note.content = content;
}

/** Small "who and when" footer for a card. */
function authorLine(note) {
  const who = personName(note.created_by);
  const when = usable(note.updated_at) || usable(note.created_at);
  if (!who && !when) return null;
  return el('div', { class: 'note-author' }, [
    who ? el('span', { class: 'note-author-badge', text: initialsOf(who) }) : null,
    el('span', { class: 'note-author-name', text: who || '—' }),
    when ? el('span', { class: 'note-author-when', text: shortWhen(when) }) : null,
  ]);
}

/**
 * The readable part of an account: the local part of an email, tidied. The
 * full address adds nothing on a card and pushes the useful part out of view.
 */
function personName(value) {
  const raw = usable(value);
  if (!raw) return '';
  const local = raw.includes('@') ? raw.split('@')[0] : raw;
  return local.replace(/[._-]+/g, ' ').trim() || raw;
}

function initialsOf(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]).toUpperCase();
}

/** Relative for anything recent, an absolute date once that stops helping. */
function shortWhen(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-MY', { day: '2-digit', month: 'short' });
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
