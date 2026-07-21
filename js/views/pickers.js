// Reusable pickers for the two fields that used to be free text.
//
// Both were footguns: an invented icon_key renders as the fallback glyph on
// the phone, and a hand-typed label silently forks ("weekly" vs "Weekly").
// These pick from the known set instead, and additions go into the Taxonomy
// data bank so every device sees them.

import { ALL_ICON_GROUPS, iconEl, isKnownIcon } from '../icons.js';
import * as taxonomy from '../taxonomy.js';
import { el, clear, toast, openModal } from '../ui.js';

/**
 * Icon picker: a button showing the current icon, which opens a full dialog to
 * choose from.
 *
 * It deliberately isn't an inline dropdown any more — a scrollable panel
 * inside the already-scrollable modal body meant two nested scroll regions
 * fighting over the wheel, which made 216 icons miserable to browse.
 */
export function iconPicker(initial, onChange) {
  let value = isKnownIcon(initial) ? String(initial).toLowerCase() : '';

  const previewHost = el('span', { class: 'icon-picker-preview' });
  const caption = el('span', { class: 'icon-picker-name', text: value || 'Choose an icon' });

  const paintPreview = () => {
    clear(previewHost);
    previewHost.append(value
      ? iconEl(value, { size: 21 })
      : el('span', { class: 'micon', style: 'font-size:21px', text: 'add_reaction' }));
  };
  paintPreview();

  const trigger = el('button', {
    type: 'button',
    class: 'icon-picker-trigger',
    onclick: (e) => { e.preventDefault(); open(); },
  }, [
    previewHost,
    caption,
    el('span', { class: 'micon icon-picker-caret', text: 'chevron_right' }),
  ]);

  function set(key) {
    value = key;
    paintPreview();
    caption.textContent = key || 'Choose an icon';
    onChange(key);
  }

  function open() {
    let filter = '';
    const grid = el('div', { class: 'icon-modal-grid' });

    const renderGrid = () => {
      clear(grid);
      let shown = 0;
      for (const group of ALL_ICON_GROUPS) {
        const matches = Object.keys(group.icons).filter((k) => !filter || k.includes(filter));
        if (!matches.length) continue;
        shown += matches.length;
        grid.append(el('div', { class: 'icon-group-label', text: group.label }));
        grid.append(el('div', { class: 'icon-grid' }, matches.map((key) => el('button', {
          type: 'button',
          class: `icon-cell${key === value ? ' is-active' : ''}`,
          title: key,
          onclick: (e) => { e.preventDefault(); set(key); close(); },
        }, [
          iconEl(key, { size: 22 }),
          el('span', { class: 'icon-cell-name', text: key }),
        ]))));
      }
      if (!shown) {
        grid.append(el('div', { class: 'hint', style: 'padding:20px', text: 'No icons match.' }));
      }
    };

    let close = () => {};
    close = openModal({
      title: 'Choose an icon',
      icon: '🎨',
      wide: true,
      render: (body, dismiss) => {
        close = dismiss;
        body.append(
          el('div', { class: 'icon-modal-search' }, [
            el('input', {
              class: 'input',
              type: 'search',
              placeholder: `Search ${ALL_ICON_GROUPS.reduce((n, g) => n + Object.keys(g.icons).length, 0)} icons…`,
              oninput: (e) => { filter = e.target.value.trim().toLowerCase(); renderGrid(); },
            }),
            el('button', {
              type: 'button',
              class: 'btn btn-ghost btn-sm',
              text: 'No icon',
              onclick: (e) => { e.preventDefault(); set(''); dismiss(); },
            }),
          ]),
          grid,
        );
        renderGrid();
      },
      actions: (dismiss) => [
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: dismiss }),
      ],
    });
  }

  return el('div', { class: 'icon-picker' }, [trigger]);
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

  let filter = '';

  function render() {
    clear(wrap);
    const usage = taxonomy.labelUsage();
    const banked = taxonomy.names(taxonomy.KIND_LABEL);

    // Anything already on this row but not in the bank still needs a chip.
    const everything = [...new Set([...banked, ...selected])].sort((a, b) => {
      const d = (usage.get(b.toLowerCase()) || 0) - (usage.get(a.toLowerCase()) || 0);
      return d !== 0 ? d : a.localeCompare(b);
    });

    // Selected labels always show, even when filtered out, so a search can't
    // hide what is currently applied.
    const all = filter
      ? everything.filter((n) => n.toLowerCase().includes(filter) || selected.has(n))
      : everything;

    // The search box only earns its space once the bank is big enough to
    // overflow the capped chip area.
    if (everything.length > 8) {
      wrap.append(el('div', { class: 'label-search' }, [
        el('span', { class: 'micon label-search-icon', text: 'search' }),
        el('input', {
          class: 'input',
          type: 'search',
          placeholder: `Filter ${everything.length} labels…`,
          value: filter,
          oninput: (e) => {
            filter = e.target.value.trim().toLowerCase();
            render();
            wrap.querySelector('.label-search input')?.focus();
          },
        }),
      ]));
    }

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
    } else if (filter) {
      wrap.append(el('div', { class: 'hint', style: 'padding:6px 0', text: 'No labels match.' }));
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


/**
 * A label chip tinted with its own colour from the Taxonomy bank, or the
 * plain accent style when it has none. Used everywhere a label is displayed
 * (not picked) — Transactions, Notes — so a colour chosen for it in Taxonomy
 * actually shows up on the data it labels rather than sitting unused.
 */
export function labelChip(name, extraClass = '') {
  const hex = normaliseHex(taxonomy.byName(taxonomy.KIND_LABEL, name)?.color_hex);
  return el('span', {
    class: `chip chip-label${extraClass ? ` ${extraClass}` : ''}`,
    style: hex ? `background:color-mix(in srgb, ${hex} 18%, transparent);color:${hex}` : '',
    text: name,
  });
}

// A small palette plus a custom swatch. Presets exist because picking from a
// full colour wheel every time produces a set of notes that don't look like a
// set; these are chosen to stay legible as a card accent in both themes.
const PRESETS = [
  '#ef5350', '#ec407a', '#ab47bc', '#5c6bc0',
  '#42a5f5', '#26a69a', '#66bb6a', '#9ccc65',
  '#ffca28', '#ffa726', '#8d6e63', '#78909c',
];

/**
 * Colour picker. `onChange(hex)` fires with '' when cleared.
 * `compact` renders just the swatch, for tight rows. `large` bumps the
 * swatch/dot size up for a page where colour is the main thing being edited.
 */
export function colourPicker(initial, onChange, { compact = false, large = false } = {}) {
  let value = normaliseHex(initial);

  const wrap = el('div', {
    class: `colour-picker${compact ? ' is-compact' : ''}${large ? ' is-large' : ''}`,
  });
  const dots = compact ? null : el('div', { class: 'colour-dots' });

  const paintDots = () => {
    if (!dots) return;
    clear(dots);
    dots.append(el('button', {
      type: 'button',
      class: `colour-dot is-none${value ? '' : ' is-active'}`,
      title: 'No colour',
      onclick: (e) => { e.preventDefault(); set(''); },
    }, [el('span', { class: 'micon', style: 'font-size:15px', text: 'block' })]));

    for (const hex of PRESETS) {
      dots.append(el('button', {
        type: 'button',
        class: `colour-dot${value === hex ? ' is-active' : ''}`,
        style: `background:${hex}`,
        title: hex,
        onclick: (e) => { e.preventDefault(); set(hex); },
      }));
    }
  };

  // The <input type=color> swatch is created once and never torn down for
  // the life of this picker — a previous version rebuilt the whole wrapper
  // (including this element) on every change, and removing the element the
  // browser's native colour dialog is anchored to closes that dialog the
  // instant you click a shade inside it.
  //
  // 'input' fires continuously while dragging inside the native dialog —
  // sometimes dozens of times for one drag. onChange() usually goes straight
  // to a Sheets write (see taxonomy.js), so calling it there turned one drag
  // into a burst of API calls and tripped Google's per-minute rate limit.
  // 'change' fires once, when the dialog closes, which is what onChange()
  // actually needs; 'input' only keeps the preset-dot ring visually in sync
  // while you drag.
  const swatch = el('input', {
    type: 'color',
    class: 'colour-swatch',
    value: value || '#66bb6a',
    title: compact ? 'Colour' : 'Custom colour',
    oninput: (e) => { value = e.target.value; paintDots(); },
    onchange: (e) => { value = e.target.value; onChange(value); paintDots(); },
  });

  function set(hex) {
    value = hex;
    swatch.value = hex || '#66bb6a';
    onChange(hex);
    paintDots();
  }

  if (dots) { wrap.append(dots); paintDots(); }
  wrap.append(swatch);

  return wrap;
}

function normaliseHex(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const hex = s.startsWith('#') ? s.slice(1) : s;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : '';
}
