// Dedicated Categories view.
//
// Categories are a two-level tree ordered by `sort_order`, which the generic
// table view renders as a flat list with the hierarchy invisible and ordering
// only editable by typing numbers into a modal. This view shows the tree, and
// makes reordering a drag instead of arithmetic.
//
// Every write still goes through repo.save(), so audit stamps, soft deletes
// and _Changelog rows are handled exactly as everywhere else.

import * as repo from '../repo.js';
import { parseNum, parseBool } from '../schema.js';
import { el, clear, toast, openModal, confirmDialog, emptyState } from '../ui.js';

const TYPES = [
  { key: 'expense', label: 'Expense' },
  { key: 'income', label: 'Income' },
];

export function renderCategories(container) {
  let activeType = localStorage.getItem('sufyam.cat.type') || 'expense';
  let query = '';
  let busy = false;

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

  function paintList() {
    clear(listWrap);

    const all = repo.rows('Categories');
    const ofType = all.filter((c) => (c.type || 'expense') === activeType);
    const parents = ofType
      .filter((c) => !c.parent_id)
      .sort(bySortOrder);

    const childrenOf = (id) => ofType.filter((c) => c.parent_id === id).sort(bySortOrder);

    // Orphans: a parent_id pointing at something deleted or of another type.
    const parentIds = new Set(all.map((c) => c.id));
    const orphans = ofType.filter(
      (c) => c.parent_id && (!parentIds.has(c.parent_id) || !ofType.some((p) => p.id === c.parent_id)),
    );

    const usage = usageCounts();

    const visible = (c) => !query
      || (c.name || '').toLowerCase().includes(query)
      || childrenOf(c.id).some((k) => (k.name || '').toLowerCase().includes(query));

    const shown = parents.filter(visible);

    if (!shown.length && !orphans.length) {
      listWrap.append(emptyState(
        '🏷',
        all.length ? 'No categories match.' : `No ${activeType} categories yet.`,
        el('button', {
          class: 'btn',
          text: '+ New category',
          onclick: () => openCategoryForm({ type: activeType }, paint),
        }),
      ));
      return;
    }

    listWrap.append(el('div', {
      class: 'hint',
      style: 'margin-bottom:10px;color:var(--text-dim);font-size:12px',
      text: '⠿ Drag a row to reorder. Click a name to rename it.',
    }));

    const tree = el('div', { class: 'cat-tree' });
    for (const parent of shown) {
      tree.append(buildGroup(parent, childrenOf(parent.id), usage));
    }
    if (orphans.length) {
      tree.append(el('div', {
        class: 'card',
        style: 'margin-top:16px;border-color:var(--warn)',
      }, [
        el('h2', { class: 'card-title', style: 'color:var(--warn)', text: 'Orphaned — parent is missing' }),
        ...orphans.map((c) => buildRow(c, usage, { depth: 0, draggable: false })),
      ]));
    }
    listWrap.append(tree);
  }

  function buildGroup(parent, children, usage) {
    const group = el('div', {
      class: 'card',
      style: 'margin-bottom:12px;padding:6px 10px',
    });

    group.append(buildRow(parent, usage, { depth: 0, draggable: true, group: 'root' }));

    const childList = el('div', { class: 'cat-children', 'data-parent': parent.id });
    for (const child of children) {
      childList.append(buildRow(child, usage, { depth: 1, draggable: true, group: parent.id }));
    }
    childList.append(el('button', {
      class: 'btn btn-ghost btn-sm',
      style: 'margin:4px 0 6px 42px;border:0;color:var(--text-dim)',
      text: '+ Add subcategory',
      onclick: () => openCategoryForm({ type: activeType, parent_id: parent.id }, paint),
    }));

    group.append(childList);
    enableDragReorder(childList, parent.id);
    return group;
  }

  function buildRow(cat, usage, { depth, draggable, group }) {
    const count = usage.get(cat.id) || 0;
    const colour = normaliseHex(cat.color_hex);

    const nameNode = el('span', {
      style: 'font-weight:550;cursor:text;padding:2px 4px;border-radius:4px',
      text: cat.name || '(unnamed)',
      title: 'Click to rename',
    });
    nameNode.addEventListener('click', () => startInlineRename(nameNode, cat, paintList));

    const row = el('div', {
      class: 'cat-row',
      'data-id': cat.id,
      draggable: draggable ? 'true' : null,
      style: `display:flex;align-items:center;gap:10px;padding:8px 6px;border-radius:8px;`
        + `margin-left:${depth * 28}px;${depth ? '' : 'font-size:15px;'}`,
    }, [
      draggable
        ? el('span', {
            class: 'drag-handle',
            style: 'cursor:grab;color:var(--text-dim);user-select:none',
            text: '⠿',
          })
        : el('span', { style: 'width:9px' }),
      el('span', {
        style: `width:12px;height:12px;border-radius:50%;flex:0 0 auto;`
          + `background:${colour || 'var(--border)'};border:1px solid var(--border)`,
      }),
      nameNode,
      count
        ? el('span', { class: 'chip', text: `${count} txn${count === 1 ? '' : 's'}` })
        : null,
      el('div', { class: 'spacer', style: 'flex:1' }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: 'Edit',
        onclick: () => openCategoryForm(cat, paint),
      }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: '🗑',
        title: 'Delete',
        onclick: () => deleteCategory(cat, count, paint),
      }),
    ]);

    return row;
  }

  /**
   * HTML5 drag reorder within one sibling list. On drop, sort_order is
   * rewritten to 1..n and only the rows whose number actually changed are
   * saved — a reorder of two adjacent items costs two writes, not n.
   */
  function enableDragReorder(listNode, parentId) {
    let dragged = null;

    listNode.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.cat-row');
      if (!row) return;
      dragged = row;
      row.style.opacity = '.4';
      e.dataTransfer.effectAllowed = 'move';
    });

    listNode.addEventListener('dragend', () => {
      if (dragged) dragged.style.opacity = '';
      dragged = null;
      listNode.querySelectorAll('.cat-row').forEach((r) => { r.style.borderTop = ''; });
    });

    listNode.addEventListener('dragover', (e) => {
      e.preventDefault();
      const over = e.target.closest('.cat-row');
      if (!over || over === dragged || !dragged) return;
      const rect = over.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      listNode.insertBefore(dragged, after ? over.nextSibling : over);
    });

    listNode.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (busy) return;
      const ids = [...listNode.querySelectorAll('.cat-row')].map((r) => r.dataset.id);
      await persistOrder(ids, parentId);
    });
  }

  async function persistOrder(ids, parentId) {
    busy = true;
    try {
      const changed = [];
      ids.forEach((id, i) => {
        const cat = repo.byId('Categories', id);
        if (!cat) return;
        const next = i + 1;
        if (parseNum(cat.sort_order) !== next || cat.parent_id !== (parentId === 'root' ? '' : cat.parent_id)) {
          changed.push({ cat, next });
        }
      });
      if (!changed.length) return;

      for (const { cat, next } of changed) {
        await repo.save('Categories', { ...cat, sort_order: next });
      }
      toast(`Reordered (${changed.length} updated)`);
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      busy = false;
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
    if (!commit || !value || value === original) {
      refresh();
      return;
    }
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

      const nameInput = el('input', {
        class: 'input',
        type: 'text',
        value: values.name,
        oninput: (e) => { values.name = e.target.value; },
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
            value: c.id,
            text: c.name || c.id,
            selected: values.parent_id === c.id,
          })));
      };
      rebuildParents();

      body.append(
        el('div', { class: 'field' }, [el('label', { text: 'Name *' }), nameInput, errorNode]),
        el('div', { class: 'field' }, [
          el('label', { text: 'Type' }),
          el('select', {
            class: 'select',
            onchange: (e) => {
              values.type = e.target.value;
              values.parent_id = '';
              rebuildParents();
            },
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
              style: 'width:52px;height:38px;padding:2px;border:1px solid var(--border);border-radius:8px;background:var(--surface)',
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
            if (children.length) toast(`Moved ${children.length} subcategor${children.length === 1 ? 'y' : 'ies'} too`);
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

  const ok = await confirmDialog({ title: 'Delete category?', message });
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
    (c) => (c.parent_id || '') === parentId && (c.type || 'expense') === type,
  );
  return siblings.reduce((max, c) => Math.max(max, parseNum(c.sort_order)), 0) + 1;
}

/** Accepts '#4CAF50', '4CAF50' or ''; returns '#4caf50' or ''. */
function normaliseHex(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const hex = s.startsWith('#') ? s.slice(1) : s;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '';
  return `#${hex.toLowerCase()}`;
}

export { parseBool };
