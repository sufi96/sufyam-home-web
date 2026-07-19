// Managing the inventory category tree: "Cleaning" > "Sponge", "Detergent".
//
// Two levels, each with an icon and a colour like expense categories have, and
// — the part that earns the screen — a "keep at least" number. Putting that
// number on a category is what makes "two toothbrushes, whichever brand" work:
// every item inside is counted together, so the requirement belongs to the
// category, not to any one brand's row. See stock.js.
//
// Deliberately a modal rather than a nav destination. It's something you set
// up once and revisit rarely, and it's only meaningful next to the item list.

import * as repo from '../repo.js';
import * as taxonomy from '../taxonomy.js';
import { parseNum } from '../schema.js';
import { glyphFor } from '../icons.js';
import { iconPicker, colourPicker } from './pickers.js';
import { el, clear, toast, openModal, confirmDialog } from '../ui.js';

const KIND = taxonomy.KIND_INVENTORY_CATEGORY;

export function openCategoryManager(onClose) {
  openModal({
    title: 'Inventory categories',
    wide: true,
    render: (body) => {
      const list = el('div', { class: 'cat-manager' });

      const paint = () => {
        clear(list);
        const nodes = taxonomy.tree(KIND);

        if (!nodes.length) {
          list.append(el('p', {
            class: 'hint',
            text: 'No categories yet. Add one — for example "Cleaning", then "Sponge" inside it.',
          }));
        }

        for (const { entry, children } of nodes) {
          list.append(row(entry, 0, paint));
          for (const child of children) list.append(row(child, 1, paint));
          list.append(el('button', {
            class: 'btn btn-ghost btn-sm cat-add-sub',
            text: `+ Add inside ${entry.name}`,
            onclick: () => openEditor({ parentId: entry.id }, paint),
          }));
        }
      };

      paint();
      body.append(
        list,
        el('button', {
          class: 'btn cat-add-top',
          text: '+ New top-level category',
          onclick: () => openEditor({ parentId: '' }, paint),
        }),
      );
    },
    actions: (close) => [
      el('button', {
        class: 'btn',
        text: 'Done',
        onclick: () => { close(); onClose?.(); },
      }),
    ],
  });
}

function row(entry, depth, refresh) {
  const items = itemsIn(entry);
  const threshold = parseNum(entry.min_threshold);
  const pooled = items.reduce((n, i) => n + parseNum(i.current_stock), 0);

  return el('div', { class: `cat-manager-row depth-${depth}` }, [
    el('span', {
      class: 'micon cat-icon',
      text: glyphFor(entry.icon_key || 'category'),
      style: entry.color_hex ? `color:${entry.color_hex}` : '',
    }),
    el('div', { class: 'cat-manager-main' }, [
      el('div', { class: 'cat-manager-name', text: entry.name }),
      el('div', { class: 'cat-manager-sub' }, [
        el('span', { text: `${items.length} item${items.length === 1 ? '' : 's'}` }),
        threshold > 0
          ? el('span', {
              class: `pill ${pooled < threshold ? 'pill-low' : 'pill-ok'}`,
              text: `${pooled} of ${threshold} together`,
              title: 'Everything in this category is counted as one pool.',
            })
          : null,
      ]),
    ]),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: 'Edit',
      onclick: () => openEditor({ entry }, refresh),
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm btn-danger',
      text: '🗑',
      title: 'Delete',
      onclick: () => remove(entry, refresh),
    }),
  ]);
}

/** Items filed under this category, plus anything in its subcategories. */
function itemsIn(entry) {
  const names = new Set(
    taxonomy.withDescendants(KIND, entry).map((t) => t.name.trim().toLowerCase()),
  );
  return repo.rows('Inventory')
    .filter((i) => names.has(String(i.category || '').trim().toLowerCase()));
}

function openEditor({ entry = null, parentId = '' }, refresh) {
  const isEdit = Boolean(entry);
  const values = {
    name: entry?.name || '',
    icon_key: entry?.icon_key || '',
    color_hex: entry?.color_hex || '',
    min_threshold: entry ? parseNum(entry.min_threshold) : 0,
    parent_id: entry ? (entry.parent_id || '') : parentId,
  };

  const parent = values.parent_id ? taxonomy.byId(KIND, values.parent_id) : null;

  openModal({
    title: isEdit ? `Edit ${entry.name}` : (parent ? `New category in ${parent.name}` : 'New category'),
    render: (body) => {
      body.append(el('div', { class: 'field' }, [
        el('label', { text: 'Name *' }),
        el('input', {
          class: 'input',
          type: 'text',
          value: values.name,
          placeholder: parent ? 'Sponge, Detergent…' : 'Cleaning, Toiletries…',
          oninput: (e) => { values.name = e.target.value; },
        }),
      ]));

      body.append(el('div', { class: 'field' }, [
        el('label', { text: 'Icon' }),
        iconPicker(values.icon_key, (v) => { values.icon_key = v; }),
      ]));

      body.append(el('div', { class: 'field' }, [
        el('label', { text: 'Colour' }),
        colourPicker(values.color_hex, (v) => { values.color_hex = v; }),
      ]));

      body.append(el('div', { class: 'field' }, [
        el('label', { text: 'Keep at least' }),
        el('input', {
          class: 'input',
          type: 'number',
          min: '0',
          value: String(values.min_threshold || ''),
          placeholder: '0',
          oninput: (e) => { values.min_threshold = parseNum(e.target.value); },
        }),
        el('div', {
          class: 'hint',
          text: 'Counts everything in this category together, whatever the brand. '
            + 'Set 2 on "Toothbrush" and one spare of each of two brands is enough. '
            + 'Leave at 0 to judge each item on its own.',
        }),
      ]));
    },
    actions: (close) => {
      const btn = el('button', { class: 'btn', text: isEdit ? 'Save' : 'Add' });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          if (isEdit) {
            // updateCategory re-points the items too: rows reference
            // categories by name, so a rename on its own would orphan every
            // item filed under the old one.
            const moved = await taxonomy.updateCategory(entry, {
              name: values.name,
              icon_key: values.icon_key,
              color_hex: values.color_hex,
              min_threshold: values.min_threshold,
            });
            toast(moved ? `Saved — ${moved} item(s) re-filed` : 'Saved');
          } else {
            await taxonomy.create(KIND, {
              name: values.name,
              icon_key: values.icon_key,
              color_hex: values.color_hex,
              min_threshold: values.min_threshold,
              parent_id: values.parent_id,
            });
            toast('Added');
          }
          close();
          refresh();
        } catch (e) {
          btn.disabled = false;
          toast(e.message, { error: true });
        }
      });
      return [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), btn];
    },
  });
}

async function remove(entry, refresh) {
  const children = taxonomy.childrenOf(KIND, entry.id);
  if (children.length) {
    toast(`Remove or move the ${children.length} category inside it first`, { error: true });
    return;
  }

  // Items keep the category name as plain text, so deleting doesn't destroy
  // anything — but they'd drop out of every grouping without warning, which is
  // worth saying out loud.
  const used = repo.rows('Inventory')
    .filter((i) => String(i.category || '').trim().toLowerCase() === entry.name.trim().toLowerCase());

  const ok = await confirmDialog({
    title: `Delete "${entry.name}"?`,
    message: used.length
      ? `${used.length} item(s) are filed here. They'll stay in your inventory but become `
        + 'uncategorised, and any "keep at least" rule on this category stops applying.'
      : 'It has no items. The row stays in the sheet and can be restored.',
  });
  if (!ok) return;

  try {
    await taxonomy.remove(entry);
    toast('Deleted');
    refresh();
  } catch (e) {
    toast(e.message, { error: true });
  }
}
