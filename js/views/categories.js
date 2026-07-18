// Dedicated Categories view.
//
// The tree is up to MAX_DEPTH levels deep — category > subcategory >
// sub-subcategory — ordered by `sort_order` within each parent. The generic
// table view renders that flat, hiding the hierarchy entirely, with ordering
// editable only by typing numbers into a modal.
//
// Drag uses pointer events rather than HTML5 drag-and-drop: native DnD gives
// no control over the drop position mid-gesture, so rows can't be animated out
// of the way. Here every row is one flat list, the dragged row and its whole
// subtree are lifted out, and the remaining rows translate to open a gap —
// which CSS transitions animate for free.
//
// Depth comes from horizontal position, the way outliners do it: drag right to
// nest under the row above, left to pull back out. That is what disambiguates
// "last child of the group above" from "new top-level category" when you drop
// on the boundary between two groups.
//
// Reorders go through repo.saveMany() so a multi-row change costs two API
// calls rather than two per row — the difference between staying under
// Google's per-minute write quota and tripping it.

import * as repo from '../repo.js';
import { parseNum } from '../schema.js';
import { el, clear, toast, openModal, confirmDialog, emptyState } from '../ui.js';

const TYPES = [
  { key: 'expense', label: 'Expense' },
  { key: 'income', label: 'Income' },
];

const MAX_DEPTH = 2;       // 0 = category, 1 = subcategory, 2 = sub-subcategory
const INDENT_PX = 26;      // visual indent per nesting level
const INDENT_TRIGGER = 14; // horizontal travel before the level changes

const DEPTH_NAMES = ['category', 'subcategory', 'sub-subcategory'];

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
    const segmented = el('div', { class: 'segmented' }, TYPES.map((t) => el('button', {
      class: `segmented-btn${t.key === activeType ? ' is-active' : ''}`,
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

  /**
   * Flattens the tree into the ordered list the drag logic works on, and
   * separates out rows whose parent no longer exists.
   */
  function buildFlat() {
    const ofType = repo.rows('Categories').filter((c) => (c.type || 'expense') === activeType);
    const live = new Map(ofType.map((c) => [c.id, c]));
    const childrenOf = new Map();

    for (const cat of ofType) {
      const key = cat.parent_id && live.has(cat.parent_id) ? cat.parent_id : '';
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(cat);
    }
    for (const list of childrenOf.values()) list.sort(bySortOrder);

    // A row pointing at a parent that isn't here any more. Kept out of the
    // tree so it can be re-homed deliberately rather than silently reappearing
    // at the top level.
    const orphans = ofType.filter((c) => c.parent_id && !live.has(c.parent_id));
    const orphanIds = new Set(orphans.map((c) => c.id));

    const flat = [];
    const walk = (parentId, depth) => {
      for (const cat of childrenOf.get(parentId) || []) {
        if (orphanIds.has(cat.id)) continue;
        flat.push({ cat, depth });
        if (depth < MAX_DEPTH) walk(cat.id, depth + 1);
      }
    };
    walk('', 0);

    return { flat, orphans };
  }

  function paintList() {
    clear(listWrap);
    const { flat, orphans } = buildFlat();
    const usage = usageCounts();
    const filtering = Boolean(query);

    const matches = (cat) => (cat.name || '').toLowerCase().includes(query);
    const visible = filtering
      ? flat.filter(({ cat, depth }, i) => {
          if (matches(cat)) return true;
          // keep an ancestor visible when a descendant matches
          for (let j = i + 1; j < flat.length && flat[j].depth > depth; j++) {
            if (matches(flat[j].cat)) return true;
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

    if (orphans.length) listWrap.append(buildOrphanCard(orphans, usage));

    listWrap.append(el('div', {
      class: 'list-hint',
      text: filtering
        ? 'Clear the search to reorder — dragging is disabled while filtering.'
        : '⠿ Drag to reorder. Drag right to nest it under the row above, left to pull it back out.',
    }));

    const list = el('div', { class: 'cat-list' });
    for (const item of visible) list.append(buildRow(item, usage, { draggable: !filtering }));
    listWrap.append(list);

    if (!filtering) attachDrag(list);
  }

  /** Recovery UI for rows whose parent was deleted. */
  function buildOrphanCard(orphans, usage) {
    return el('div', { class: 'card orphan-card' }, [
      el('div', { class: 'orphan-head' }, [
        el('span', { class: 'orphan-icon', text: '⚠' }),
        el('div', {}, [
          el('div', { class: 'orphan-title', text: `${orphans.length} categor${orphans.length === 1 ? 'y is' : 'ies are'} orphaned` }),
          el('div', {
            class: 'orphan-sub',
            text: 'Their parent was deleted, so they no longer appear in the tree. '
              + 'Pick where each one belongs — they are still attached to their transactions.',
          }),
        ]),
      ]),
      ...orphans.map((cat) => buildOrphanRow(cat, usage)),
    ]);
  }

  function buildOrphanRow(cat, usage) {
    const count = usage.get(cat.id) || 0;
    const select = el('select', { class: 'select', style: 'max-width:240px' });

    const rebuild = () => {
      clear(select);
      select.append(el('option', { value: '', text: '— make it a top-level category —' }));
      for (const { cat: candidate, depth } of buildFlat().flat) {
        if (candidate.id === cat.id) continue;
        if (depth >= MAX_DEPTH) continue; // nothing can nest below the last level
        select.append(el('option', {
          value: candidate.id,
          text: `${'　'.repeat(depth)}${depth ? '↳ ' : ''}${candidate.name || candidate.id}`,
        }));
      }
    };
    rebuild();

    return el('div', { class: 'orphan-row' }, [
      el('span', { class: 'cat-dot', style: `background:${normaliseHex(cat.color_hex) || 'var(--border)'}` }),
      el('span', { style: 'font-weight:550', text: cat.name || '(unnamed)' }),
      count ? el('span', { class: 'chip', text: `${count} txn${count === 1 ? '' : 's'}` }) : null,
      el('span', { class: 'chip chip-warn', text: `was under ${cat.parent_id}` }),
      el('span', { style: 'flex:1' }),
      select,
      el('button', {
        class: 'btn btn-sm',
        text: 'Move here',
        onclick: async (e) => {
          const btn = e.target;
          btn.disabled = true;
          btn.textContent = 'Moving…';
          try {
            const parentId = select.value;
            await repo.save('Categories', {
              ...cat,
              parent_id: parentId,
              sort_order: nextSortOrder(parentId, cat.type || activeType),
            });
            toast(`"${cat.name}" moved`);
            paint();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Move here';
            toast(err.message, { error: true });
          }
        },
      }),
    ]);
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
      class: `cat-row depth-${depth}`,
      'data-id': cat.id,
      'data-depth': String(depth),
      style: `--indent:${depth * INDENT_PX}px`,
    }, [
      draggable
        ? el('span', { class: 'drag-handle', text: '⠿', title: 'Drag to reorder' })
        : el('span', { style: 'width:10px' }),
      el('span', { class: 'cat-dot', style: `background:${colour || 'var(--border)'}` }),
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

    // The whole subtree travels with the row: every following row deeper than
    // this one belongs to it.
    let span = 1;
    while (index + span < rows.length && Number(rows[index + span].dataset.depth) > depth) span++;
    const group = rows.slice(index, index + span);
    const rest = rows.filter((r) => !group.includes(r));

    // How much room the subtree needs below whatever it lands on.
    const deepest = group.reduce((m, r) => Math.max(m, Number(r.dataset.depth)), depth);
    const subtreeHeight = deepest - depth;

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

    let insertAt = 0;
    let dropDepth = depth;

    const onMove = (e) => {
      const dy = e.clientY - startY;
      const dx = e.clientX - startX;
      const rect = list.getBoundingClientRect();
      const pointerY = e.clientY - rect.top;

      insertAt = 0;
      for (const m of metrics) {
        if (pointerY > m.top + m.height / 2) insertAt++;
        else break;
      }

      // Legal depth range for this drop position:
      //  - at most one level deeper than the row above
      //  - never so deep that the dragged subtree would exceed MAX_DEPTH
      //  - a row landing after a deeper row may sit at any level up to that
      const above = metrics[insertAt - 1];
      const aboveDepth = above ? Number(above.el.dataset.depth) : -1;
      const maxDepth = Math.min(aboveDepth + 1, MAX_DEPTH - subtreeHeight);
      const wanted = Math.round((baseIndent + dx) / INDENT_PX);
      dropDepth = Math.max(0, Math.min(wanted, Math.max(0, maxDepth)));

      // Dropping a shallower row into the middle of a deeper subtree would
      // re-parent everything after it. Snap past those rows to a boundary.
      let scan = insertAt;
      while (scan < metrics.length && Number(metrics[scan].el.dataset.depth) > dropDepth) scan++;
      insertAt = scan;

      group.forEach((r) => {
        const own = Number(r.dataset.depth) - depth;
        r.style.transform = `translate(${(dropDepth + own) * INDENT_PX - (depth + own) * INDENT_PX}px, ${dy}px)`;
      });
      metrics.forEach((m, i) => {
        m.el.style.transform = i >= insertAt ? `translateY(${groupHeight}px)` : '';
      });

      hint.textContent = dropDepth === 0
        ? '↤ top-level category'
        : `↳ ${DEPTH_NAMES[dropDepth]} of ${parentNameAt(metrics, insertAt, dropDepth)}`;
      hint.classList.toggle('is-child', dropDepth > 0);
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
      group.forEach((r) => {
        depths.set(r.dataset.id, dropDepth + (Number(r.dataset.depth) - depth));
      });

      await persist(order, depths);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /** Name of the row that would become the parent at a given drop position. */
  function parentNameAt(metrics, insertAt, dropDepth) {
    for (let i = insertAt - 1; i >= 0; i--) {
      if (Number(metrics[i].el.dataset.depth) === dropDepth - 1) {
        return repo.byId('Categories', metrics[i].el.dataset.id)?.name || '';
      }
    }
    return '';
  }

  /**
   * Walks the new flat order, derives each row's parent_id and sort_order from
   * its depth, and saves only the rows that actually changed.
   */
  async function persist(order, depths) {
    saving = true;
    try {
      const parentAtDepth = [];
      const counters = new Map();
      const updates = [];
      let previousDepth = -1;

      for (const id of order) {
        const cat = repo.byId('Categories', id);
        if (!cat) continue;

        // Can never jump more than one level deeper than the row above.
        const depth = Math.max(0, Math.min(depths.get(id) ?? 0, previousDepth + 1, MAX_DEPTH));
        const parentId = depth === 0 ? '' : (parentAtDepth[depth - 1] || '');

        const key = parentId || '__root__';
        const sortOrder = (counters.get(key) || 0) + 1;
        counters.set(key, sortOrder);

        parentAtDepth[depth] = id;
        parentAtDepth.length = depth + 1;
        previousDepth = depth;

        if ((cat.parent_id || '') !== parentId || parseNum(cat.sort_order) !== sortOrder) {
          updates.push({ ...cat, parent_id: parentId, sort_order: sortOrder });
        }
      }

      if (!updates.length) return;
      await repo.saveMany('Categories', updates);
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
  };
  const errorNode = el('div', { class: 'error hidden' });

  openModal({
    title: isEdit ? 'Edit category' : 'New category',
    render: (body) => {
      const hexInput = el('input', {
        class: 'input',
        type: 'text',
        value: values.color_hex,
        style: 'max-width:120px;font-variant-numeric:tabular-nums',
        oninput: (e) => { values.color_hex = e.target.value; },
      });
      const swatch = el('input', {
        type: 'color',
        class: 'colour-swatch',
        value: values.color_hex,
        oninput: (e) => { values.color_hex = e.target.value; hexInput.value = e.target.value; },
      });
      const parentSelect = el('select', {
        class: 'select',
        onchange: (e) => { values.parent_id = e.target.value; },
      });

      // Descendants can't become their own ancestor's parent.
      const descendants = new Set();
      const collect = (id) => {
        for (const c of repo.rows('Categories')) {
          if (c.parent_id === id && !descendants.has(c.id)) {
            descendants.add(c.id);
            collect(c.id);
          }
        }
      };
      if (isEdit) collect(cat.id);

      const rebuildParents = () => {
        clear(parentSelect);
        parentSelect.append(el('option', { value: '', text: '— top level —' }));
        const rowsOfType = repo.rows('Categories').filter((c) => (c.type || 'expense') === values.type);
        const live = new Map(rowsOfType.map((c) => [c.id, c]));
        // Orphans aren't in the tree, so offering them as parents would just
        // hide whatever gets moved under one.
        const inTree = rowsOfType.filter((c) => !c.parent_id || live.has(c.parent_id));
        const walk = (parentId, depth) => {
          inTree
            .filter((c) => (c.parent_id || '') === parentId)
            .sort(bySortOrder)
            .forEach((c) => {
              if (c.id !== cat.id && !descendants.has(c.id) && depth < MAX_DEPTH) {
                parentSelect.append(el('option', {
                  value: c.id,
                  text: `${'　'.repeat(depth)}${depth ? '↳ ' : ''}${c.name || c.id}`,
                  selected: values.parent_id === c.id,
                }));
              }
              if (depth < MAX_DEPTH) walk(c.id, depth + 1);
            });
        };
        walk('', 0);
      };
      rebuildParents();

      body.append(
        field('Name', el('input', {
          class: 'input',
          type: 'text',
          value: values.name,
          placeholder: 'e.g. Groceries',
          oninput: (e) => { values.name = e.target.value; },
        }), { required: true, error: errorNode }),

        el('div', { class: 'field-row' }, [
          field('Type', el('select', {
            class: 'select',
            onchange: (e) => { values.type = e.target.value; values.parent_id = ''; rebuildParents(); },
          }, TYPES.map((t) => el('option', {
            value: t.key, text: t.label, selected: values.type === t.key,
          })))),
          field('Colour', el('div', { class: 'colour-field' }, [swatch, hexInput])),
        ]),

        field('Parent', parentSelect, {
          hint: 'Leave as top level to make this a main category.',
        }),

        field('Icon key', el('input', {
          class: 'input',
          type: 'text',
          value: values.icon_key,
          placeholder: 'e.g. cart, fuel, home',
          oninput: (e) => { values.icon_key = e.target.value; },
        }), { hint: 'Optional — matches the icon name used by the phone app.' }),
      );
    },
    actions: (close) => {
      const btn = el('button', { class: 'btn', text: isEdit ? 'Save changes' : 'Create category' });
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
            sort_order: isEdit
              ? parseNum(cat.sort_order, 0)
              : nextSortOrder(values.parent_id, values.type),
          });

          // A category switching expense<->income takes its whole subtree with
          // it, or the descendants end up in a tab their parent isn't in.
          if (typeChanged) {
            const moved = [];
            const cascade = (id) => {
              for (const c of repo.rows('Categories')) {
                if (c.parent_id === id && (c.type || 'expense') !== values.type) {
                  moved.push({ ...c, type: values.type });
                  cascade(c.id);
                }
              }
            };
            cascade(cat.id);
            if (moved.length) {
              await repo.saveMany('Categories', moved);
              toast(`Moved ${moved.length} descendant${moved.length === 1 ? '' : 's'} too`);
            }
          }

          toast(isEdit ? 'Saved' : 'Created');
          close();
          onSaved?.();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = isEdit ? 'Save changes' : 'Create category';
          toast(err.message, { error: true });
        }
      });
      return [el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }), btn];
    },
  });
}

function field(label, control, { required = false, hint = '', error = null } = {}) {
  return el('div', { class: 'field' }, [
    el('label', {}, [label, required ? el('span', { class: 'req', text: '*' }) : null]),
    control,
    hint ? el('div', { class: 'hint', text: hint }) : null,
    error,
  ]);
}

// ---------- delete ----------

async function deleteCategory(cat, txnCount, refresh) {
  const descendants = [];
  const collect = (id) => {
    for (const c of repo.rows('Categories')) {
      if (c.parent_id === id) { descendants.push(c); collect(c.id); }
    }
  };
  collect(cat.id);

  const warnings = [];
  if (descendants.length) {
    warnings.push({
      icon: '🌳',
      text: `${descendants.length} subcategor${descendants.length === 1 ? 'y' : 'ies'} below it `
        + `(${descendants.slice(0, 3).map((c) => c.name).join(', ')}`
        + `${descendants.length > 3 ? '…' : ''}) will be left orphaned. `
        + 'They stay in the sheet and can be re-homed from the warning panel afterwards.',
    });
  }
  if (txnCount) {
    warnings.push({
      icon: '💸',
      text: `${txnCount} transaction${txnCount === 1 ? '' : 's'} still reference it. `
        + 'They keep their amounts but will show an unresolved category.',
    });
  }

  const ok = await confirmDialog({
    title: 'Delete category?',
    message: `"${cat.name}" will be marked deleted and disappear from your phone on the next sync.`,
    warnings,
    note: 'Nothing is erased — the row stays in the sheet and can be restored.',
    confirmLabel: 'Delete category',
  });
  if (!ok) return;

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
    (c) => (c.parent_id || '') === (parentId || '') && (c.type || 'expense') === type,
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
