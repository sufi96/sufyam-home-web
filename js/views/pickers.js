// Reusable pickers for the two fields that used to be free text.
//
// Both were footguns: an invented icon_key renders as the fallback glyph on
// the phone, and a hand-typed label silently forks ("weekly" vs "Weekly").
// These pick from the known set instead, and additions go into the Taxonomy
// data bank so every device sees them.

import { ICON_GROUPS, glyphFor, isKnownIcon } from '../icons.js';
import * as taxonomy from '../taxonomy.js';
import { el, clear, toast } from '../ui.js';

/**
 * Icon picker: a button showing the current icon that opens a grouped,
 * searchable grid. `onChange(key)` fires on selection.
 */
export function iconPicker(initial, onChange) {
  let value = isKnownIcon(initial) ? String(initial).toLowerCase() : '';

  const preview = el('span', { class: 'micon', text: value ? glyphFor(value) : 'add' });
  const caption = el('span', { class: 'icon-picker-name', text: value || 'Choose an icon' });
  const panel = el('div', { class: 'icon-panel hidden' });

  const trigger = el('button', {
    type: 'button',
    class: 'icon-picker-trigger',
    onclick: (e) => {
      e.preventDefault();
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) search.focus();
    },
  }, [preview, caption, el('span', { class: 'micon', style: 'margin-left:auto;font-size:18px', text: 'expand_more' })]);

  const grid = el('div');
  const search = el('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search icons…',
    oninput: (e) => renderGrid(e.target.value.trim().toLowerCase()),
  });

  function select(key) {
    value = key;
    preview.textContent = key ? glyphFor(key) : 'add';
    caption.textContent = key || 'Choose an icon';
    panel.classList.add('hidden');
    renderGrid('');
    onChange(key);
  }

  function renderGrid(filter) {
    clear(grid);
    for (const group of ICON_GROUPS) {
      const matches = Object.keys(group.icons).filter((k) => !filter || k.includes(filter));
      if (!matches.length) continue;
      grid.append(el('div', { class: 'icon-group-label', text: group.label }));
      grid.append(el('div', { class: 'icon-grid' }, matches.map((key) => el('button', {
        type: 'button',
        class: `icon-cell${key === value ? ' is-active' : ''}`,
        title: key,
        onclick: (e) => { e.preventDefault(); select(key); },
      }, [el('span', { class: 'micon', text: glyphFor(key) })]))));
    }
    if (!grid.children.length) {
      grid.append(el('div', { class: 'hint', style: 'padding:12px', text: 'No icons match.' }));
    }
  }
  renderGrid('');

  panel.append(
    el('div', { class: 'icon-panel-search' }, [
      search,
      el('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        text: 'Clear',
        onclick: (e) => { e.preventDefault(); select(''); },
      }),
    ]),
    grid,
  );

  return el('div', { class: 'icon-picker' }, [trigger, panel]);
}

/**
 * Label picker: toggleable chips from the Taxonomy bank, plus a box to add a
 * new one. `onChange(namesArray)` fires on every change. Anything typed here
 * is banked on save by the caller via taxonomy.ensure().
 */
export function labelPicker(initialCsv, onChange) {
  const selected = new Set(
    String(initialCsv || '').split('|').map((s) => s.trim()).filter(Boolean),
  );
  const wrap = el('div', { class: 'label-picker' });

  const emit = () => onChange([...selected]);

  function render() {
    clear(wrap);
    const usage = taxonomy.labelUsage();
    const banked = taxonomy.names(taxonomy.KIND_LABEL);

    // Anything already on this row but not in the bank still needs a chip.
    const all = [...new Set([...banked, ...selected])].sort((a, b) => {
      const d = (usage.get(b.toLowerCase()) || 0) - (usage.get(a.toLowerCase()) || 0);
      return d !== 0 ? d : a.localeCompare(b);
    });

    if (all.length) {
      wrap.append(el('div', { class: 'label-chips' }, all.map((name) => {
        const on = selected.has(name);
        return el('button', {
          type: 'button',
          class: `label-chip${on ? ' is-on' : ''}`,
          onclick: (e) => {
            e.preventDefault();
            if (on) selected.delete(name);
            else selected.add(name);
            render();
            emit();
          },
        }, [
          name,
          usage.get(name.toLowerCase())
            ? el('span', { class: 'label-chip-count', text: String(usage.get(name.toLowerCase())) })
            : null,
        ]);
      })));
    }

    const input = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Add a new label…',
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        selected.add(name);
        input.value = '';
        render();
        emit();
      },
    });

    wrap.append(el('div', { class: 'label-add' }, [
      input,
      el('span', { class: 'hint', text: 'Press Enter to add' }),
    ]));

    // One-tap backfill for labels typed before the bank existed.
    const unbanked = taxonomy.unbankedLabels();
    if (unbanked.length) {
      wrap.append(el('div', { class: 'label-backfill' }, [
        el('span', {
          text: `${unbanked.length} label${unbanked.length === 1 ? '' : 's'} used on transactions `
            + `${unbanked.length === 1 ? 'is' : 'are'} not in your data bank yet`,
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-sm',
          text: 'Add them',
          onclick: async (e) => {
            e.preventDefault();
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = 'Adding…';
            try {
              const added = await taxonomy.ensure(taxonomy.KIND_LABEL, unbanked);
              toast(`Banked ${added.length} label${added.length === 1 ? '' : 's'}`);
              render();
            } catch (err) {
              btn.disabled = false;
              btn.textContent = 'Add them';
              toast(err.message, { error: true });
            }
          },
        }),
      ]));
    }
  }

  render();
  return wrap;
}
