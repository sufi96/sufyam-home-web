// The bits that make a category tree feel the way it does: the colour-coded
// rows, and the drag where horizontal position picks the nesting depth.
//
// Extracted from views/categories.js so inventory categories can be the same
// screen rather than a lookalike. Two implementations of this drag would drift
// apart within a week, and the expense tree is the one the household already
// has muscle memory for.
//
// Nothing here touches the sheet. Dragging rearranges a caller-owned buffer;
// writing it is the caller's job, which is what lets both screens buffer edits
// behind a Save button.

import { iconEl } from '../icons.js';
import { el } from '../ui.js';

export const INDENT_PX = 26;

export function normaliseHex(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const hex = s.startsWith('#') ? s.slice(1) : s;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : '';
}

/**
 * Black or white, whichever is readable on `hex`. Uses WCAG relative
 * luminance, so a pale yellow gets dark text and a deep navy gets white,
 * rather than both being guessed from the hue.
 */
export function contrastOn(hex) {
  const h = normaliseHex(hex) || '#7a8794';
  const channel = (pair) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(h.slice(1, 3))
    + 0.7152 * channel(h.slice(3, 5))
    + 0.0722 * channel(h.slice(5, 7));
  return luminance > 0.45 ? '#10171e' : '#ffffff';
}

/** The round icon chip. `onColour` when it sits on a filled top-level row. */
export function categoryBadge(row, size = 26, { onColour = false } = {}) {
  const colour = normaliseHex(row.color_hex) || '#7a8794';
  // On a filled row the badge sits on the category colour, so it borrows the
  // row's contrast colour rather than the hue it would vanish into.
  const bg = onColour
    ? 'color-mix(in srgb, var(--row-fg) 20%, transparent)'
    : `color-mix(in srgb, ${colour} 18%, transparent)`;
  return el('span', {
    class: 'cat-badge',
    style: `width:${size}px;height:${size}px;background:${bg};`
      + `color:${onColour ? 'var(--row-fg)' : colour}`,
  }, [iconEl(row.icon_key, { size: Math.round(size * 0.62) })]);
}

/**
 * The inline style that colours one row by depth.
 *
 * Top-level rows are filled with their own colour, text and icon flipped to
 * whichever of black/white actually reads on it. Indentation and weight alone
 * weren't enough to separate levels at a glance.
 */
export function rowTint(colourHex, depth) {
  const colour = normaliseHex(colourHex) || '#7a8794';
  const fg = contrastOn(colour);
  if (depth === 0) {
    return `--row-bg:${colour};--row-fg:${fg};--row-accent:${colour};`
      // Hover mixes toward the text colour: a dark row lightens, a pale row
      // darkens. Brightening both ways left pale rows looking unhovered.
      + `--row-hover:color-mix(in srgb, ${colour} 88%, ${fg});`;
  }
  return `--row-bg:color-mix(in srgb, ${colour} ${depth === 1 ? 15 : 7}%, var(--surface));`
    + '--row-fg:var(--text);'
    + `--row-accent:${colour};`;
}

/**
 * Makes `.cat-row` children of `list` draggable, reordering and re-nesting a
 * caller-owned array of { id, depth }.
 *
 * Options:
 *   maxDepth    deepest allowed level (0-based)
 *   depthNames  ['category', 'subcategory', …] for the drag hint
 *   isBusy()    true to refuse new drags (mid-save)
 *   getWorking()/setWorking(next)  the buffer being rearranged
 *   nameOf(id)  display name, for the "↳ subcategory of X" hint
 *   onDrop()    called once the buffer has been updated
 *
 * Rows must carry data-id and data-depth, and be styled with --indent.
 */
export function attachTreeDrag(list, opts) {
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || opts.isBusy?.() || e.button !== 0) return;
    e.preventDefault();
    startDrag(list, handle.closest('.cat-row'), e, opts);
  });
}

function startDrag(list, row, downEvent, opts) {
  const {
    maxDepth, depthNames, getWorking, setWorking, nameOf, onDrop,
  } = opts;

  const rows = [...list.querySelectorAll('.cat-row')];
  const index = rows.indexOf(row);
  const depth = Number(row.dataset.depth);

  // A row drags its whole subtree: everything below it that's deeper.
  let span = 1;
  while (index + span < rows.length && Number(rows[index + span].dataset.depth) > depth) span++;
  const group = rows.slice(index, index + span);
  const rest = rows.filter((r) => !group.includes(r));
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

    const above = metrics[insertAt - 1];
    const aboveDepth = above ? Number(above.el.dataset.depth) : -1;
    const allowed = Math.min(aboveDepth + 1, maxDepth - subtreeHeight);
    const wanted = Math.round((baseIndent + dx) / INDENT_PX);
    dropDepth = Math.max(0, Math.min(wanted, Math.max(0, allowed)));

    // Dropping a shallower row inside a deeper subtree would re-parent the
    // rest of it; snap past those rows to a boundary instead.
    let scan = insertAt;
    while (scan < metrics.length && Number(metrics[scan].el.dataset.depth) > dropDepth) scan++;
    insertAt = scan;

    group.forEach((r) => {
      r.style.transform = `translate(${(dropDepth - depth) * INDENT_PX}px, ${dy}px)`;
    });
    metrics.forEach((m, i) => {
      m.el.style.transform = i >= insertAt ? `translateY(${groupHeight}px)` : '';
    });

    hint.textContent = dropDepth === 0
      ? `↤ top-level ${depthNames[0]}`
      : `↳ ${depthNames[dropDepth]} of ${parentNameAt(metrics, insertAt, dropDepth, nameOf)}`;
    hint.classList.toggle('is-child', dropDepth > 0);
    hint.style.left = `${e.clientX + 16}px`;
    hint.style.top = `${e.clientY + 18}px`;
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    hint.remove();
    document.body.style.userSelect = '';
    list.classList.remove('is-dragging-active');
    group.forEach((r) => { r.classList.remove('is-dragging'); r.style.transform = ''; });
    metrics.forEach((m) => { m.el.classList.remove('is-shifting'); m.el.style.transform = ''; });

    // Buffer only — nothing is written here.
    const working = getWorking();
    const ids = new Set(group.map((r) => r.dataset.id));
    const moved = working.filter((w) => ids.has(w.id));
    const remaining = working.filter((w) => !ids.has(w.id));
    const restIds = rest.map((r) => r.dataset.id);
    const anchor = restIds[insertAt - 1];
    const at = anchor ? remaining.findIndex((w) => w.id === anchor) + 1 : 0;

    // The dragged row lands at dropDepth; its descendants keep their offset
    // from it, so the shape of the subtree survives the move.
    moved.forEach((w, i) => { w.depth = dropDepth + (i === 0 ? 0 : w.depth - depth); });
    setWorking([...remaining.slice(0, at), ...moved, ...remaining.slice(at)]);

    onDrop();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function parentNameAt(metrics, insertAt, dropDepth, nameOf) {
  for (let i = insertAt - 1; i >= 0; i--) {
    if (Number(metrics[i].el.dataset.depth) === dropDepth - 1) {
      return nameOf(metrics[i].el.dataset.id) || '';
    }
  }
  return '';
}

/**
 * parent_id + sort_order implied by a flat [{ id, depth }] arrangement.
 *
 * Depth is clamped to one deeper than the row above, so a buffer can't
 * describe a row nested under nothing.
 */
export function deriveTree(working, maxDepth) {
  const out = new Map();
  const parentAt = [];
  const counters = new Map();
  let prevDepth = -1;

  for (const { id, depth: raw } of working) {
    const depth = Math.max(0, Math.min(raw, prevDepth + 1, maxDepth));
    const parentId = depth === 0 ? '' : (parentAt[depth - 1] || '');
    const key = parentId || '__root__';
    const sortOrder = (counters.get(key) || 0) + 1;
    counters.set(key, sortOrder);
    parentAt[depth] = id;
    parentAt.length = depth + 1;
    prevDepth = depth;
    out.set(id, { parent_id: parentId, sort_order: sortOrder, depth });
  }
  return out;
}
