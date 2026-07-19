// The editable fields of an inventory category, and of a stock item.
//
// Shared because both the Stock categories screen and the Inventory tree let
// you edit the same things from their detail pane, and a field that behaved
// differently depending on which screen you opened it from would be a bug
// waiting to happen.
//
// Every control reports through `set(key, value)` and nothing here writes to
// the sheet — the caller owns the buffer. That's what lets both screens pool a
// whole session of edits behind one Save.

import { parseNum, parseBool, schemaFor } from '../schema.js';
import { iconPicker, colourPicker } from './pickers.js';
import { el, toDateInput } from '../ui.js';

export function field(label, control, { required = false, hint = '' } = {}) {
  return el('div', { class: 'field' }, [
    el('label', { text: label + (required ? ' *' : '') }),
    control,
    hint ? el('div', { class: 'hint', text: hint }) : null,
  ]);
}

/** An on/off switch. Matches the one the item form uses. */
export function switchRow(label, hint, initial, onChange) {
  const row = el('button', {
    type: 'button',
    class: `toggle-row${initial ? ' is-on' : ''}`,
    'aria-pressed': String(initial),
    onclick: (e) => {
      e.preventDefault();
      const next = row.classList.toggle('is-on');
      row.setAttribute('aria-pressed', String(next));
      onChange(next);
    },
  }, [
    el('span', { class: 'toggle-text' }, [
      el('span', { class: 'toggle-label', text: label }),
      hint ? el('span', { class: 'toggle-hint', text: hint }) : null,
    ]),
    el('span', { class: 'switch' }),
  ]);
  return row;
}

/** Name / icon / colour / threshold for one category. */
export function categoryFields(cat, set) {
  return [
    field('Name', el('input', {
      class: 'input',
      type: 'text',
      value: cat.name || '',
      oninput: (e) => set('name', e.target.value),
    }), { required: true }),

    field('Icon', iconPicker(cat.icon_key, (v) => set('icon_key', v))),
    field('Colour', colourPicker(cat.color_hex, (v) => set('color_hex', v))),

    field('Keep at least', el('input', {
      class: 'input',
      type: 'number',
      min: '0',
      value: String(parseNum(cat.min_threshold) || ''),
      placeholder: '0',
      oninput: (e) => set('min_threshold', parseNum(e.target.value)),
    }), {
      hint: 'Counts everything in this category together, whatever the brand. '
        + 'Set 2 on "Toothbrush" and one spare of each of two brands is enough. '
        + 'Leave at 0 to judge each item on its own.',
    }),
  ];
}

/**
 * The editable fields of one stock item.
 *
 * Category is deliberately NOT here — in the tree, an item's category is where
 * it sits, and offering a dropdown that contradicts its own position would be
 * two sources of truth for the same fact. Drag it instead.
 */
export function itemFields(item, set, { brands = [] } = {}) {
  const units = schemaFor('Inventory').fields.find((f) => f.key === 'unit').options;
  const listId = `dl-brand-${Math.random().toString(36).slice(2, 8)}`;

  return [
    field('Item name', el('input', {
      class: 'input',
      type: 'text',
      value: item.item_name || '',
      oninput: (e) => set('item_name', e.target.value),
    }), { required: true }),

    field('Brand', el('div', {}, [
      el('input', {
        class: 'input',
        type: 'text',
        list: listId,
        value: item.brand || '',
        placeholder: 'Colgate, Gillette…',
        oninput: (e) => set('brand', e.target.value),
      }),
      el('datalist', { id: listId }, brands.map((b) => el('option', { value: b }))),
    ])),

    field('Variant / size', el('input', {
      class: 'input',
      type: 'text',
      value: item.variant_size || '',
      placeholder: '250ml, 4-pack…',
      oninput: (e) => set('variant_size', e.target.value),
    })),

    el('div', { class: 'field-row' }, [
      field('In stock', el('input', {
        class: 'input',
        type: 'number',
        value: String(parseNum(item.current_stock)),
        oninput: (e) => set('current_stock', parseNum(e.target.value)),
      })),
      field('Unit', el('select', {
        class: 'select',
        onchange: (e) => set('unit', e.target.value),
      }, units.map((u) => el('option', {
        value: u,
        text: u,
        selected: (item.unit || 'pcs') === u,
      })))),
    ]),

    field('Keep at least', el('input', {
      class: 'input',
      type: 'number',
      min: '0',
      value: String(parseNum(item.min_threshold) || ''),
      placeholder: '0',
      oninput: (e) => set('min_threshold', parseNum(e.target.value)),
    }), {
      hint: 'For this item on its own. If its category sets a number instead, '
        + 'the category is counted together and this is ignored.',
    }),

    field('Expires', el('input', {
      class: 'input',
      type: 'date',
      value: toDateInput(item.expiration_date),
      oninput: (e) => set('expiration_date', e.target.value),
    })),

    switchRow(
      'Refill / refillable',
      '',
      parseBool(item.is_refill),
      (v) => set('is_refill', v),
    ),
    switchRow(
      'Use up, do not restock',
      'Stays in the list, but never counted as running low.',
      parseBool(item.no_restock),
      (v) => set('no_restock', v),
    ),
  ];
}
