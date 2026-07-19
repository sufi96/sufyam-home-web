// Port of lib/features/sync/sheets_schema.dart from the Flutter app.
//
// !! Column order must stay identical to the Dart file. Existing sheets align
// by position, so reordering here silently corrupts data. Append only.
//
// Cell encoding also mirrors the Dart side (SheetSchema._cell):
//   null -> ''   bool -> 'true'/'false'   everything else -> as-is.

const AUDIT = [
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
  'is_deleted',
];

// Field types drive the generic table/form renderer in views/entity.js:
//   text | textarea | number | money | date | datetime | select | labels | ref
export const TABS = [
  {
    box: 'categories',
    tab: 'Categories',
    label: 'Categories',
    columns: ['id', 'name', 'parent_id', 'type', 'icon_key', 'color_hex', 'sort_order', ...AUDIT],
    title: (r) => r.name,
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'parent_id', label: 'Parent', type: 'ref', ref: 'Categories', allowEmpty: true },
      { key: 'type', label: 'Type', type: 'select', options: ['expense', 'income'], default: 'expense' },
      { key: 'icon_key', label: 'Icon key', type: 'text' },
      { key: 'color_hex', label: 'Colour hex', type: 'text', placeholder: '#4CAF50' },
      { key: 'sort_order', label: 'Sort order', type: 'number', default: 0 },
    ],
    listColumns: ['name', 'type', 'parent_id', 'sort_order'],
  },
  {
    box: 'transactions',
    tab: 'Transactions',
    label: 'Expenses',
    columns: ['id', 'amount', 'category_id', 'transaction_date', 'notes', 'labels', 'linked_inventory_id', ...AUDIT],
    title: (r) => r.notes || 'Transaction',
    fields: [
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'category_id', label: 'Category', type: 'ref', ref: 'Categories', required: true },
      { key: 'transaction_date', label: 'Date & time', type: 'datetime', required: true, default: () => new Date().toISOString() },
      { key: 'notes', label: 'Notes', type: 'textarea' },
      { key: 'labels', label: 'Labels', type: 'labels', hint: 'Separate with |' },
      { key: 'linked_inventory_id', label: 'Linked stock item', type: 'ref', ref: 'Inventory', allowEmpty: true },
    ],
    listColumns: ['transaction_date', 'amount', 'category_id', 'notes', 'labels'],
    sort: (a, b) => (b.transaction_date || '').localeCompare(a.transaction_date || ''),
  },
  {
    box: 'inventory',
    tab: 'Inventory',
    label: 'Inventory',
    columns: [
      'id', 'item_name', 'variant_size', 'category', 'current_stock', 'unit',
      'min_threshold', 'expiration_date', ...AUDIT,
      // Appended after the audit block, which is unusual but required: the
      // columns above already exist in the live sheet in this order, and rows
      // are written positionally. Anything new can only go on the end.
      //
      // stock_group is retired. Pooling now hangs off the category tree — a
      // subcategory *is* the group — so nothing reads or writes it. The column
      // stays because removing it would shift is_refill and no_restock one
      // place left of where they sit in the live sheet, silently re-mapping
      // both. Reuse it only for something the same shape.
      'brand', 'stock_group', 'is_refill', 'no_restock',
    ],
    title: (r) => r.item_name,
    fields: [
      { key: 'item_name', label: 'Item name', type: 'text', required: true },
      { key: 'brand', label: 'Brand', type: 'suggest', suggest: 'brand', placeholder: 'Colgate, Gillette…' },
      { key: 'variant_size', label: 'Variant / size', type: 'text', placeholder: '250ml, 4-pack…' },
      { key: 'category', label: 'Category', type: 'taxonomy', kind: 'inventoryCategory' },
      { key: 'current_stock', label: 'Current stock', type: 'number', default: 0 },
      { key: 'unit', label: 'Unit', type: 'select', options: ['pcs', 'kg', 'g', 'l', 'ml', 'pack', 'can'], default: 'pcs' },
      {
        key: 'min_threshold',
        label: 'Keep at least',
        type: 'number',
        default: 0,
        hint: 'For this item on its own. If its category sets a number instead, '
          + 'the whole category is counted together and this is ignored.',
      },
      { key: 'is_refill', label: 'Refill / refillable', type: 'bool' },
      {
        key: 'no_restock',
        label: 'Use up, do not restock',
        type: 'bool',
        hint: 'Stays in the list, but never counted as running low.',
      },
      { key: 'expiration_date', label: 'Expires', type: 'date' },
    ],
    listColumns: ['item_name', 'brand', 'variant_size', 'category', 'current_stock', 'unit', 'min_threshold', 'expiration_date'],
    sort: (a, b) => (a.item_name || '').localeCompare(b.item_name || ''),
  },
  {
    box: 'stockMovements',
    tab: 'Stock_Movements',
    label: 'Stock moves',
    columns: ['id', 'inventory_id', 'quantity', 'movement_type', 'movement_date', 'transaction_id', ...AUDIT],
    title: (r) => r.movement_type,
    fields: [
      { key: 'inventory_id', label: 'Item', type: 'ref', ref: 'Inventory', required: true },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true },
      { key: 'movement_type', label: 'Type', type: 'select', options: ['purchase', 'used', 'adjusted', 'expired'], default: 'used' },
      { key: 'movement_date', label: 'Date & time', type: 'datetime', default: () => new Date().toISOString() },
      { key: 'transaction_id', label: 'Linked expense', type: 'ref', ref: 'Transactions', allowEmpty: true },
    ],
    listColumns: ['movement_date', 'inventory_id', 'movement_type', 'quantity'],
    sort: (a, b) => (b.movement_date || '').localeCompare(a.movement_date || ''),
  },
  {
    box: 'records',
    tab: 'Records_Reminders',
    label: 'Records',
    columns: ['id', 'title', 'type', 'provider', 'reference_no', 'due_date', 'cost', 'recurrence', ...AUDIT],
    title: (r) => r.title,
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'type', label: 'Type', type: 'text', placeholder: 'Insurance / Road Tax / Subscription' },
      { key: 'provider', label: 'Provider', type: 'text' },
      { key: 'reference_no', label: 'Reference no.', type: 'text' },
      { key: 'due_date', label: 'Due date', type: 'date', required: true },
      { key: 'cost', label: 'Cost', type: 'money', default: 0 },
      { key: 'recurrence', label: 'Recurrence', type: 'select', options: ['none', 'monthly', 'quarterly', 'yearly'], default: 'none' },
    ],
    listColumns: ['due_date', 'title', 'type', 'provider', 'cost', 'recurrence'],
    sort: (a, b) => (a.due_date || '').localeCompare(b.due_date || ''),
  },
  {
    box: 'budgets',
    tab: 'Budgets',
    label: 'Budgets',
    columns: ['id', 'category_id', 'monthly_limit', ...AUDIT],
    title: (r) => r.category_id,
    fields: [
      { key: 'category_id', label: 'Category', type: 'ref', ref: 'Categories', required: true },
      { key: 'monthly_limit', label: 'Monthly limit', type: 'money', required: true },
    ],
    listColumns: ['category_id', 'monthly_limit'],
  },
  {
    // Notes are web-first: the Dart SheetSchema doesn't know this tab yet, and
    // that's safe — the phone's pull skips changelog entries for tabs it can't
    // resolve (sync_engine.dart:212) and its push only walks its own schema
    // list, so it neither breaks nor touches these rows.
    //
    // `content` holds the body: plain text for a note, a JSON array of
    // { text, done } for a checklist. Keeping it in one cell means the row
    // shape never has to change as new note types are added.
    box: 'notes',
    tab: 'Notes',
    label: 'Notes',
    columns: [
      'id', 'title', 'type', 'category', 'content', 'labels',
      'is_encrypted', 'pinned', 'sort_order', 'color_hex', ...AUDIT,
    ],
    title: (r) => r.title,
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'type', label: 'Type', type: 'select', options: ['note', 'checklist'], default: 'note' },
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'content', label: 'Content', type: 'textarea' },
      { key: 'labels', label: 'Labels', type: 'labels' },
      { key: 'pinned', label: 'Pinned', type: 'text' },
      { key: 'sort_order', label: 'Sort order', type: 'number', default: 0 },
      { key: 'color_hex', label: 'Colour', type: 'text' },
    ],
    listColumns: ['title', 'type', 'category', 'labels'],
    sort: (a, b) => {
      const pin = (parseBool(b.pinned) ? 1 : 0) - (parseBool(a.pinned) ? 1 : 0);
      if (pin !== 0) return pin;
      const order = parseNum(a.sort_order) - parseNum(b.sort_order);
      if (order !== 0) return order;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    },
  },
  {
    box: 'taxonomy',
    tab: 'Taxonomy',
    label: 'Taxonomy',
    columns: [
      'id', 'kind', 'name', 'icon_key', 'color_hex', 'sort_order', ...AUDIT,
      // Appended on the end for the same positional reason as Inventory's.
      // parent_id turns inventory categories into a two-level tree
      // ("Cleaning" > "Sponge"); min_threshold lets a category carry the
      // stock rule for everything under it, so "keep at least 2 toothbrushes"
      // is answered by the category rather than by any one brand's row.
      'parent_id', 'min_threshold',
    ],
    title: (r) => r.name,
    fields: [
      { key: 'kind', label: 'Kind', type: 'select', options: ['inventoryCategory', 'recordType', 'label', 'noteCategory'], default: 'label' },
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'parent_id', label: 'Parent', type: 'ref', ref: 'Taxonomy', allowEmpty: true },
      { key: 'icon_key', label: 'Icon key', type: 'text' },
      { key: 'color_hex', label: 'Colour hex', type: 'text' },
      { key: 'min_threshold', label: 'Keep at least', type: 'number', default: 0 },
      { key: 'sort_order', label: 'Sort order', type: 'number', default: 0 },
    ],
    listColumns: ['kind', 'name', 'parent_id', 'min_threshold', 'sort_order'],
  },
];

export const CHANGELOG = {
  tab: '_Changelog',
  columns: ['tab', 'id', 'row', 'updated_at', 'data'],
};

export const ALL_TAB_TITLES = [...TABS.map((t) => t.tab), CHANGELOG.tab];

export function schemaFor(tabTitle) {
  const s = TABS.find((t) => t.tab === tabTitle);
  if (!s) throw new Error(`Unknown tab: ${tabTitle}`);
  return s;
}

/** Mirrors SheetSchema._cell in the Dart app. */
export function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}

/** Serializes an entity object into a row of cells in canonical column order. */
export function toRow(schema, obj) {
  return schema.columns.map((c) => cell(obj[c]));
}

/** Parses a sheet row back into an object, keyed by the sheet's own header. */
export function toObject(header, row) {
  const out = {};
  header.forEach((key, i) => {
    out[key] = i < row.length ? row[i] : '';
  });
  return out;
}

/** Dart's `_parseBool`: 'true' | '1' | 'yes' (case-insensitive) are true. */
export function parseBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

export function parseNum(v, fallback = 0) {
  const n = parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

/** Full ISO-8601 UTC, matching Dart's `DateTime.toUtc().toIso8601String()`. */
export function isoNow() {
  return new Date().toISOString();
}

/** 'YYYY-MM-DD' — the format the app uses for due_date / expiration_date. */
export function dateOnly(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
