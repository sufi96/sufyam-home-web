// Dedicated Categories view.
//
// Categories are a two-level tree ordered by `sort_order`. The generic table
// view renders that flat, hiding the hierarchy, with ordering editable only by
// typing numbers into a modal. This view shows the tree and makes reordering a
// drag.
//
// Drag is implemented with pointer events rather than HTML5 drag-and-drop:
// native DnD gives no control over the drop position mid-gesture, so rows
// can't be animated out of the way. Here every row is one flat list, the
// dragged row (plus its children) is lifted out, and the remaining rows are
// translated to open a gap — which CSS transitions animate for free.
//
// Depth is chosen by horizontal position, the way outliners do it: drag right
// past the indent threshold to make the row a subcategory of whatever sits
// above it, keep it left to leave it top-level. That's what disambiguates
// "last child of the group above" from "new top-level category" when you drop
// on the boundary between two groups.
//
// Every write still goes through repo.save(), so audit stamps, soft deletes
// and _Changelog rows behave exactly as everywhere else.

import * as repo from '../repo.js';
import { parseNum } from '../schema.js';
import { el, clear, toast, openModal, confirmDialog, emptyState } from '../ui.js';

const TYPES = [
  { key: 'expense', label: 'Expense' },
  { key: 'income', label: 'Income' },
];

const INDENT_PX = 30;      // visual indent of one nesting level
const INDENT_TRIGGER = 18; // horizontal travel before a row becomes a child

export function renderCategories(container) {
  let activeType = localStorage.getItem('sufyam.cat.type') || 'expense';
  let query = '';
  let saving = false;

  const listWrap = el('div');

  function paint() {
    clear(container);
    container.append(buildToolbar(), listWrap);
    paintList();
  }

  function buildToolbar() {
    const segmented = el('div', {
      style: 'display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden',
    }, TYPES.map((t) => el('button', {
      class: 'btn btn-ghost',
      style: `border:0;border-radius:0;${
        t.key === activeType ? 'background:var(--accent-soft);color:var(--accent);font-weight:600' : ''
      }`,
      text: t.label,
      onclick: () => {
        activeType = t.key;
        localStorage.setItem('sufyam.cat.type', t.key);
        paint();
      },
    })));

    return el('div', { class: 'toolbar' }, [
      segmented,
      el('input', {
        class: 'input search',
        type: 'search',
        placeholder: 'Search categories…',
        value: query,
        oninput: (e) => { query = e.target.value.toLowerCase(); paintList(); },
      }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn',
        text: '+ New category',
        onclick: () => openCategoryForm({ type: activeType }, paint),
      }),
    ]);
  }

  /** Flattens the tree into the single ordered list the drag logic works on. */
  function buildFlat() {
    const ofType = repo.rows('Categories').filter((c) => (c.type || 'expense') === activeType);
    const parents = ofType.filter((c) => !c.parent_id).sort(bySortOrder);
    const known = new Set(ofType.map((c) => c.id));

    const flat = [];
    for (const parent of parents) {
      flat.push({ cat: parent, depth: 0 });
      for (const child of ofType.filter((c) => c.parent_id === parent.id).sort(bySortOrder)) {
        flat.push({ cat: child, depth: 1 });
      }
    }
    const orphans = ofType.filter((c) => c.parent_id && !known.has(c.parent_id));
    return { flat, orphans };
  }

  function paintList() {
    clear(listWrap);
    const { flat, orphans } = buildFlat();
    const usage = usageCounts();
    const filtering = Boolean(query);

    const visible = filtering
      ? flat.filter(({ cat, depth }, i) => {
          if ((cat.name || '').toLowerCase().includes(query)) return true;
          // keep a parent visible when one of its children matches
          if (depth === 0) {
            return flat.slice(i + 1).some((n) => n.depth === 1
              && n.cat.parent_id === cat.id
              && (n.cat.name || '').toLowerCase().includes(query));
          }
          return false;
        })
      : flat;

    if (!visible.length && !orphans.length) {
      listWrap.append(emptyState(
        '🏷',
        flat.length ? 'No categories match.' : `No ${activeType} categories yet.`,
        el('button', {
          class: 'btn',
          text: '+ New category',
          onclick: () => openCategoryForm({ type: activeType }, paint),
        }),
      ));
      return;
    }

    listWrap.append(el('div', {
      style: 'margin-bottom:10px;color:var(--text-dim);font-size:12px',
      text: filtering
        ? 'Clear the search to reorder — dragging is disabled while filtering.'
        : '⠿ Drag to reorder. Drag right to make it a subcategory, left to make it top-level.',
    }));

    const list = el('div', { class: 'cat-list' });
    for (const item of visible) {
      list.append(buildRow(item, usage, { draggable: !filtering }));
    }
    listWrap.append(list);

    if (!filtering) attachDrag(list);

    if (orphans.length) {
      listWrap.append(el('div', {
        class: 'card',
        style: 'margin-top:16px;border-color:var(--warn)',
      }, [
        el('h2', { class: 'card-title', style: 'color:var(--warn)', text: 'Orphaned — parent is missing' }),
        ...orphans.map((cat) => buildRow({ cat, depth: 0 }, usage, { draggable: false })),
      ]));
    }
  }

  function buildRow({ cat, depth }, usage, { draggable }) {
    const count = usage.get(cat.id) || 0;
    const colour = normaliseHex(cat.color_hex);

    const nameNode = el('span', {
      class: 'cat-name',
      text: cat.name || '(unnamed)',
      title: 'Click to rename',
    });
    nameNode.addEventListener('click', () => startInlineRename(nameNode, cat, paintList));

    return el('div', {
      class: `cat-row${depth ? ' is-child' : ' is-parent'}`,
      'data-id': cat.id,
      'data-depth': String(depth),
      style: `--indent:${depth * INDENT_PX}px`,
    }, [
      draggable
        ? el('span', { class: 'drag-handle', text: '⠿', title: 'Drag to reorder' })
        : el('span', { style: 'width:10px' }),
      el('span', {
        class: 'cat-dot',
        style: `background:${colour || 'var(--border)'}`,
      }),
      nameNode,
      count ? el('span', { class: 'chip', text: `${count} txn${count === 1 ? '' : 's'}` }) : null,
      el('span', { style: 'flex:1' }),
      el('button', {
        class: 'btn btn-ghost btn-sm cat-action',
        text: 'Edit',
        onclick: () => openCategoryForm(cat, paint),
      }),
      el('button', {
        class: 'btn btn-danger btn-sm cat-action',
        text: '🗑',
        title: 'Delete',
        onclick: () => deleteCategory(cat, count, paint),
      }),
    ]);
  }

  // ---------- drag ----------

  function attachDrag(list) {
    list.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.drag-handle');
      if (!handle || saving || e.button !== 0) return;
      e.preventDefault();
      startDrag(list, handle.closest('.cat-row'), e);
    });
  }

  function startDrag(list, row, downEvent) {
    const rows = [...list.querySelectorAll('.cat-row')];
    const index = rows.indexOf(row);
    const depth = Number(row.dataset.depth);

    // A parent travels with its children; a child moves alone.
    let span = 1;
    if (depth === 0) {
      while (index + span < rows.length && rows[index + span].dataset.depth === '1') span++;
    }
    const group = rows.slice(index, index + span);
    const rest = rows.filter((r) => !group.includes(r));
    const hasChildren = span > 1;

    // Geometry captured before anything moves.
    const listRect = list.getBoundingClientRect();
    const metrics = rest.map((r) => {
      const rect = r.getBoundingClientRect();
      return { el: r, top: rect.top - listRect.top, height: rect.height };
    });
    const groupHeight = group.reduce((h, r) => h + r.getBoundingClientRect().height, 0);
    const startY = downEvent.clientY;
    const startX = downEvent.clientX;
    const baseIndent = depth * INDENT_PX;

    group.forEach((r) => r.classList.add('is-dragging'));
    rest.forEach((r) => r.classList.add('is-shifting'));
    list.classList.add('is-dragging-active');
    document.body.style.userSelect = 'none';

    const hint = el('div', { class: 'drag-hint' });
    document.body.append(hint);

    let insertAt = metrics.findIndex((m) => m.el === rest[0]) === -1 ? 0 : index;
    let dropDepth = depth;

    const onMove = (e) => {
      const dy = e.clientY - startY;
      const dx = e.clientX - startX;
      const rect = list.getBoundingClientRect();
      const pointerY = e.clientY - rect.top;

      // How many remaining rows sit above the pointer.
      insertAt = 0;
      for (const m of metrics) {
        if (pointerY > m.top + m.height / 2) insertAt++;
        else break;
      }

      // Depth from horizontal travel, then clamped to what's legal.
      const above = metrics[insertAt - 1];
      const aboveDepth = above ? Number(above.el.dataset.depth) : -1;
      const wantsIndent = baseIndent + dx > INDENT_TRIGGER;
      const canIndent = above !== undefined && !hasChildren;
      dropDepth = wantsIndent && canIndent ? 1 : 0;

      // Nothing can nest under a row that is itself a child unless they end up
      // sharing a parent — which is the same depth, so this stays 0 or 1.
      if (dropDepth === 1 && aboveDepth === -1) dropDepth = 0;

      // A top-level row dropped between a parent and its children would split
      // that group: everything after the insertion point would be re-parented
      // onto the row being dropped. Snap past the remaining children so it
      // lands on a group boundary instead.
      if (dropDepth === 0) {
        while (insertAt < metrics.length
          && Number(metrics[insertAt].el.dataset.depth) === 1) insertAt++;
      }

      group.forEach((r) => {
        r.style.transform = `translate(${dropDepth * INDENT_PX - baseIndent}px, ${dy}px)`;
      });
      metrics.forEach((m, i) => {
        m.el.style.transform = i >= insertAt ? `translateY(${groupHeight}px)` : '';
      });

      const parentName = dropDepth === 1 ? nameOfParentFor(above) : '';
      hint.textContent = dropDepth === 1
        ? `↳ subcategory of ${parentName}`
        : '↤ top-level category';
      hint.classList.toggle('is-child', dropDepth === 1);
      hint.style.left = `${e.clientX + 16}px`;
      hint.style.top = `${e.clientY + 18}px`;
    };

    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      hint.remove();
      document.body.style.userSelect = '';
      list.classList.remove('is-dragging-active');
      group.forEach((r) => { r.classList.remove('is-dragging'); r.style.transform = ''; });
      metrics.forEach((m) => { m.el.classList.remove('is-shifting'); m.el.style.transform = ''; });

      const order = [
        ...rest.slice(0, insertAt).map((r) => r.dataset.id),
        ...group.map((r) => r.dataset.id),
        ...rest.slice(insertAt).map((r) => r.dataset.id),
      ];
      const depths = new Map(rest.map((r) => [r.dataset.id, Number(r.dataset.depth)]));
      depths.set(group[0].dataset.id, dropDepth);
      group.slice(1).forEach((r) => depths.set(r.dataset.id, 1));

      await persist(order, depths);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function nameOfParentFor(aboveMetric) {
    if (!aboveMetric) return '';
    const cat = repo.byId('Categories', aboveMetric.el.dataset.id);
    if (!cat) return '';
    if (!cat.parent_id) return cat.name || '';
    const parent = repo.byId('Categories', cat.parent_id);
    return parent?.name || '';
  }

  /**
   * Walks the new flat order, derives each row's parent_id and sort_order,
   * and saves only the rows that actually changed. Reordering two adjacent
   * items costs two writes, not one per category.
   */
  async function persist(order, depths) {
    saving = true;
    try {
      let currentParent = '';
      let topCounter = 0;
      let childCounter = 0;
      const updates = [];

      for (const id of order) {
        const cat = repo.byId('Categories', id);
        if (!cat) continue;
        const depth = depths.get(id) === 1 && currentParent ? 1 : 0;

        let parentId;
        let sortOrder;
        if (depth === 0) {
          parentId = '';
          sortOrder = ++topCounter;
          currentParent = id;
          childCounter = 0;
        } else {
          parentId = currentParent;
          sortOrder = ++childCounter;
        }

        if ((cat.parent_id || '') !== parentId || parseNum(cat.sort_order) !== sortOrder) {
          updates.push({ cat, parentId, sortOrder });
        }
      }

      if (!updates.length) return;
      for (const u of updates) {
        await repo.save('Categories', { ...u.cat, parent_id: u.parentId, sort_order: u.sortOrder });
      }
      toast(`Reordered — ${updates.length} updated`);
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      saving = false;
      paintList();
    }
  }

  paint();
}

// ---------- inline rename ----------

function startInlineRename(node, cat, refresh) {
  const original = cat.name || '';
  const input = el('input', {
    class: 'input',
    type: 'text',
    value: original,
    style: 'max-width:260px;padding:4px 8px',
  });
  node.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (!commit || !value || value === original) return refresh();
    try {
      await repo.save('Categories', { ...cat, name: value });
      toast('Renamed');
    } catch (err) {
      toast(err.message, { error: true });
    }
    refresh();
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

// ---------- form ----------

function openCategoryForm(cat, onSaved) {
  const isEdit = Boolean(cat.id);
  const values = {
    name: cat.name || '',
    type: cat.type || 'expense',
    parent_id: cat.parent_id || '',
    color_hex: normaliseHex(cat.color_hex) || '#4caf50',
    icon_key: cat.icon_key || '',
    sort_order: cat.sort_order ?? nextSortOrder(cat.parent_id || '', cat.type || 'expense'),
  };
  const errorNode = el('div', { class: 'error hidden' });

  openModal({
    title: isEdit ? 'Edit category' : 'New category',
    render: (body) => {
      const hexInput = el('input', {
        class: 'input',
        type: 'text',
        value: values.color_hex,
        style: 'max-width:130px',
        oninput: (e) => { values.color_hex = e.target.value; },
      });
      const parentSelect = el('select', {
        class: 'select',
        onchange: (e) => { values.parent_id = e.target.value; },
      });

      const rebuildParents = () => {
        clear(parentSelect);
        parentSelect.append(el('option', { value: '', text: '— top level —' }));
        repo.rows('Categories')
          .filter((c) => (c.type || 'expense') === values.type && !c.parent_id && c.id !== cat.id)
          .sort(bySortOrder)
          .forEach((c) => parentSelect.append(el('option', {
            value: c.id, text: c.name || c.id, selected: values.parent_id === c.id,
          })));
      };
      rebuildParents();

      body.append(
        el('div', { class: 'field' }, [
          el('label', { text: 'Name *' }),
          el('input', {
            class: 'input',
            type: 'text',
            value: values.name,
            oninput: (e) => { values.name = e.target.value; },
          }),
          errorNode,
        ]),
        el('div', { class: 'field' }, [
          el('label', { text: 'Type' }),
          el('select', {
            class: 'select',
            onchange: (e) => { values.type = e.target.value; values.parent_id = ''; rebuildParents(); },
          }, TYPES.map((t) => el('option', {
            value: t.key, text: t.label, selected: values.type === t.key,
          }))),
        ]),
        el('div', { class: 'field' }, [el('label', { text: 'Parent' }), parentSelect]),
        el('div', { class: 'field' }, [
          el('label', { text: 'Colour' }),
          el('div', { style: 'display:flex;gap:10px;align-items:center' }, [
            el('input', {
              type: 'color',
              value: values.color_hex,
              style: 'width:52px;height:38px;padding:2px;border:1px solid var(--border);'
                + 'border-radius:8px;background:var(--surface)',
              oninput: (e) => { values.color_hex = e.target.value; hexInput.value = e.target.value; },
            }),
            hexInput,
          ]),
        ]),
        el('div', { class: 'field' }, [
          el('label', { text: 'Icon key' }),
          el('input', {
            class: 'input',
            type: 'text',
            value: values.icon_key,
            placeholder: 'e.g. cart, fuel, home',
            oninput: (e) => { values.icon_key = e.target.value; },
          }),
        ]),
      );
    },
    actions: (close) => {
      const btn = el('button', { class: 'btn', text: isEdit ? 'Save changes' : 'Create' });
      btn.addEventListener('click', async () => {
        if (!values.name.trim()) {
          errorNode.textContent = 'Name is required';
          errorNode.classList.remove('hidden');
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          const typeChanged = isEdit && (cat.type || 'expense') !== values.type;
          await repo.save('Categories', {
            ...(isEdit ? cat : {}),
            name: values.name.trim(),
            type: values.type,
            parent_id: values.parent_id,
            color_hex: values.color_hex,
            icon_key: values.icon_key,
            sort_order: parseNum(values.sort_order, 0),
          });

          // A parent switching expense<->income would otherwise strand its
          // children under a parent they can no longer be shown with.
          if (typeChanged && !values.parent_id) {
            const children = repo.rows('Categories').filter((c) => c.parent_id === cat.id);
            for (const child of children) {
              await repo.save('Categories', { ...child, type: values.type });
            }
            if (children.length) {
              toast(`Moved ${children.length} subcategor${children.length === 1 ? 'y' : 'ies'} too`);
            }
          }

          toast(isEdit ? 'Saved' : 'Created');
          close();
          onSaved?.();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = isEdit ? 'Save changes' : 'Create';
          toast(err.message, { error: true });
        }
      });
      return [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), btn];
    },
  });
}

// ---------- delete ----------

async function deleteCategory(cat, txnCount, refresh) {
  const children = repo.rows('Categories').filter((c) => c.parent_id === cat.id);

  let message = `"${cat.name}" will be marked deleted and disappear from your phone on the next sync.`;
  if (children.length) {
    message += `\n\n⚠ It has ${children.length} subcategor${children.length === 1 ? 'y' : 'ies'}, `
      + 'which will be left without a parent. Move or delete them first if you care about the grouping.';
  }
  if (txnCount) {
    message += `\n\n⚠ ${txnCount} transaction${txnCount === 1 ? '' : 's'} still reference it. `
      + 'Those keep their amounts but will show an unresolved category.';
  }

  if (!(await confirmDialog({ title: 'Delete category?', message }))) return;
  try {
    await repo.remove('Categories', cat.id);
    toast('Deleted');
    refresh();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------- helpers ----------

function bySortOrder(a, b) {
  const d = parseNum(a.sort_order) - parseNum(b.sort_order);
  return d !== 0 ? d : (a.name || '').localeCompare(b.name || '');
}

function usageCounts() {
  const counts = new Map();
  for (const t of repo.rows('Transactions')) {
    if (!t.category_id) continue;
    counts.set(t.category_id, (counts.get(t.category_id) || 0) + 1);
  }
  return counts;
}

function nextSortOrder(parentId, type) {
  const siblings = repo.rows('Categories').filter(
    (c) => (c.parent_id || '') === parentId && (c.type || 'expense') === type,
  );
  return siblings.reduce((max, c) => Math.max(max, parseNum(c.sort_order)), 0) + 1;
}

/** Accepts '#4CAF50', '4CAF50' or ''; returns '#4caf50' or ''. */
function normaliseHex(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const hex = s.startsWith('#') ? s.slice(1) : s;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : '';
}
