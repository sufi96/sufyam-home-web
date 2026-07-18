// Note bodies are a list of blocks, so one note can mix prose, checklists and
// tables instead of being locked to a single kind.
//
// Stored in the `content` cell as:
//   { "v": 1, "blocks": [ { id, type, ... }, ... ] }
//
// Everything that reads content goes through parseBlocks(), which also
// upgrades the two older shapes in place — a bare JSON array (the old
// checklist format) and plain text — so nothing written before this needs
// migrating, and a note typed by hand into Google Sheets still opens.

import { htmlToText, isBlankHtml } from './richtext.js';

export const BLOCK_TYPES = [
  { type: 'text', label: 'Text', icon: 'notes' },
  { type: 'checklist', label: 'Checklist', icon: 'checklist' },
  { type: 'table', label: 'Table', icon: 'table_chart' },
];

const newId = () => `b${Math.random().toString(36).slice(2, 9)}`;

export function textBlock(html = '') {
  return { id: newId(), type: 'text', html };
}

export function checklistBlock(items = [{ text: '', done: false }]) {
  return { id: newId(), type: 'checklist', items };
}

export function tableBlock(columns = ['Column 1', 'Column 2'], rows = [['', '']]) {
  return { id: newId(), type: 'table', columns, rows };
}

export function blankBlock(type) {
  if (type === 'checklist') return checklistBlock();
  if (type === 'table') return tableBlock();
  return textBlock();
}

export function parseBlocks(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);

    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.blocks)) {
      return parsed.blocks.map(normaliseBlock).filter(Boolean);
    }

    // Legacy: a bare array was the old checklist-only format.
    if (Array.isArray(parsed)) {
      return [checklistBlock(parsed.map((i) => (typeof i === 'string'
        ? { text: i, done: false }
        : { text: String(i?.text ?? ''), done: Boolean(i?.done) })))];
    }
  } catch {
    // Not JSON at all — fall through to the plain-text reading below.
  }

  // Plain text, possibly written straight into the spreadsheet. Lines that
  // look like markdown checkboxes become a checklist; anything else is prose.
  const lines = text.split('\n');
  const allChecks = lines.length > 0 && lines.every((l) => /^\s*[-*]?\s*\[( |x|X)\]/.test(l));
  if (allChecks) {
    return [checklistBlock(lines.map((line) => {
      const m = line.match(/^\s*[-*]?\s*\[( |x|X)\]\s*(.*)$/);
      return { text: m ? m[2] : line, done: m ? m[1].toLowerCase() === 'x' : false };
    }))];
  }
  return [textBlock(escapeHtml(text).replace(/\n/g, '<br>'))];
}

function normaliseBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const id = String(block.id || newId());
  switch (block.type) {
    case 'checklist':
      return {
        id,
        type: 'checklist',
        items: (Array.isArray(block.items) ? block.items : []).map((i) => ({
          text: String(i?.text ?? ''),
          done: Boolean(i?.done),
        })),
      };
    case 'table': {
      const columns = (Array.isArray(block.columns) ? block.columns : []).map(String);
      const width = columns.length || 1;
      const rows = (Array.isArray(block.rows) ? block.rows : []).map((r) => {
        const cells = (Array.isArray(r) ? r : []).map(String);
        // Pad short rows so a hand-edited table can't render ragged.
        while (cells.length < width) cells.push('');
        return cells.slice(0, width);
      });
      return { id, type: 'table', columns: columns.length ? columns : ['Column 1'], rows };
    }
    case 'text':
    default:
      return { id, type: 'text', html: String(block.html ?? '') };
  }
}

export function serializeBlocks(blocks) {
  return JSON.stringify({ v: 1, blocks: blocks.map(stripBlock) });
}

function stripBlock(block) {
  if (block.type === 'checklist') {
    return { id: block.id, type: 'checklist', items: block.items };
  }
  if (block.type === 'table') {
    return { id: block.id, type: 'table', columns: block.columns, rows: block.rows };
  }
  return { id: block.id, type: 'text', html: block.html };
}

/** Everything searchable in a note body, flattened to one string. */
export function blocksToText(blocks) {
  return blocks.map((b) => {
    if (b.type === 'checklist') return b.items.map((i) => i.text).join(' ');
    if (b.type === 'table') return [...b.columns, ...b.rows.flat()].join(' ');
    return htmlToText(b.html);
  }).join(' ');
}

/** Checklist progress across every checklist block in a note. */
export function checklistProgress(blocks) {
  let done = 0;
  let total = 0;
  for (const b of blocks) {
    if (b.type !== 'checklist') continue;
    total += b.items.length;
    done += b.items.filter((i) => i.done).length;
  }
  return { done, total };
}

export function isBlockEmpty(block) {
  if (block.type === 'checklist') return block.items.every((i) => !i.text.trim());
  if (block.type === 'table') return block.rows.every((r) => r.every((c) => !String(c).trim()));
  return isBlankHtml(block.html);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
