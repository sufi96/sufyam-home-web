// The ONLY module in this app that writes to the spreadsheet.
//
// Views never call sheets.js directly. Everything funnels through save() /
// remove() so the three rules the Flutter app depends on can be enforced in
// exactly one place:
//
//   1. audit stamps — created_by/at set once, updated_by/at on every write,
//      updated_at in full ISO-8601 UTC because it is the Last-Write-Wins key
//      (lib/features/sync/sync_merge.dart)
//   2. soft delete — is_deleted = 'true', never an actual row removal, since
//      deleting a row would shift every row below it and invalidate the row
//      numbers the app has cached in its sync state
//   3. changelog — every data write appends a matching _Changelog line
//
// (3) is the one that bites: the phone's incremental pull reads *only*
// changelog rows past a saved cursor (sync_engine.dart:203-241) and never
// rescans data tabs. A data write without a changelog entry is invisible to
// the phone forever, and will be silently overwritten by the next edit there.

import * as sheets from './sheets.js';
import { getUserEmail } from './auth.js';
import {
  TABS,
  CHANGELOG,
  schemaFor,
  toRow,
  toObject,
  parseBool,
  isoNow,
} from './schema.js';

// { [tabTitle]: { header: string[], byId: Map<id, obj>, headerMismatch: bool } }
const cache = new Map();
let loadedAt = null;

const listeners = new Set();

export function onDataChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(tab) {
  listeners.forEach((fn) => fn(tab));
}

export function lastLoadedAt() {
  return loadedAt;
}

// Tabs the spreadsheet is missing. A sheet created by an older version of the
// app won't have every tab this build knows about.
let absentTabs = new Set();

export function missingTabs() {
  return [...absentTabs];
}

/**
 * Loads every entity tab.
 *
 * The tab list is fetched first because Sheets rejects a batchGet outright if
 * *any* range names a tab that doesn't exist — so one missing tab would fail
 * the whole load and leave the app with no data at all, rather than merely
 * lacking that one entity.
 */
export async function loadAll() {
  const { tabs } = await sheets.listTabs();
  const present = new Set(tabs);
  absentTabs = new Set(TABS.map((t) => t.tab).filter((t) => !present.has(t)));

  const titles = TABS.map((t) => t.tab).filter((t) => present.has(t));
  const raw = titles.length ? await sheets.readTabs(titles) : {};

  cache.clear();
  for (const schema of TABS) {
    const values = raw[schema.tab] || [];
    const header = values.length ? values[0] : [...schema.columns];
    const byId = new Map();

    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (row.every((c) => c === '')) continue; // blank spacer row
      const obj = toObject(header, row);
      const id = String(obj.id ?? '');
      if (!id) continue;
      obj.__row = i + 1; // +1 header, +1 for 1-indexed sheet rows
      byId.set(id, obj);
    }

    // Two very different situations look alike from here, and conflating them
    // would be bad either way:
    //
    //  - the header is a prefix of the canonical list, i.e. this build added
    //    columns on the end. Harmless and fixable — the existing cells still
    //    line up, the header row just needs the new names. extendHeaders()
    //    does that.
    //  - the header genuinely disagrees within the columns both know about.
    //    Rows are written positionally, so every field would land in the wrong
    //    column. Nothing automatic should touch that; it gets a warning.
    const canonical = schema.columns;
    const hasHeader = values.length > 0;
    const isPrefix = hasHeader
      && header.length < canonical.length
      && header.every((c, i) => c === canonical[i]);

    cache.set(schema.tab, {
      header,
      byId,
      headerShort: isPrefix,
      headerMismatch:
        hasHeader && !isPrefix && header.join(' ') !== canonical.join(' '),
    });
  }
  loadedAt = new Date();
  emit(null);
}

/** Tabs whose header row is missing columns this build appended. */
export function shortHeaders() {
  return [...cache].filter(([, e]) => e.headerShort).map(([tab]) => tab);
}

/**
 * Writes the full canonical header for any tab that's missing trailing
 * columns.
 *
 * Safe precisely because it only runs on a prefix match: every existing name
 * is rewritten to the identical value, and the new names land in cells that
 * were empty. No data row is touched.
 */
export async function extendHeaders() {
  const short = shortHeaders();
  if (!short.length) return [];

  for (const tab of short) {
    const schema = schemaFor(tab);
    await sheets.updateRow(tab, 1, schema.columns);
    const entry = cache.get(tab);
    entry.header = [...schema.columns];
    entry.headerShort = false;
  }
  return short;
}

export function headerWarnings() {
  const out = [];
  for (const [tab, entry] of cache) {
    if (entry.headerMismatch) out.push(tab);
  }
  return out;
}

/** All live (non-deleted) rows for a tab, sorted by the schema's rule. */
export function rows(tabTitle, { includeDeleted = false } = {}) {
  const entry = cache.get(tabTitle);
  if (!entry) return [];
  const schema = schemaFor(tabTitle);
  const list = [...entry.byId.values()].filter(
    (r) => includeDeleted || !parseBool(r.is_deleted),
  );
  if (schema.sort) list.sort(schema.sort);
  return list;
}

export function byId(tabTitle, id) {
  return cache.get(tabTitle)?.byId.get(String(id)) || null;
}

/** Human label for a referenced row — used to render foreign keys. */
export function labelFor(tabTitle, id) {
  if (!id) return '';
  const row = byId(tabTitle, id);
  if (!row) return String(id); // dangling reference: show the raw id
  const schema = schemaFor(tabTitle);
  return schema.title(row) || String(id);
}

/**
 * Creates or updates one entity row, then records it in the changelog.
 *
 * @param tabTitle canonical tab, e.g. 'Transactions'
 * @param patch    field values; include `id` to update, omit it to create
 */
export async function save(tabTitle, patch) {
  const schema = schemaFor(tabTitle);
  const entry = cache.get(tabTitle);
  if (!entry) throw new Error(`Tab ${tabTitle} not loaded`);

  const actor = getUserEmail();
  const now = isoNow();
  const id = String(patch.id || crypto.randomUUID());
  const existing = entry.byId.get(id);

  // Start from the existing row so untouched columns (and the original
  // created_by/created_at) survive an edit untouched.
  const obj = { ...(existing || {}), ...patch, id };
  delete obj.__row;

  if (existing) {
    obj.created_by = existing.created_by || actor;
    obj.created_at = existing.created_at || now;
  } else {
    obj.created_by = actor;
    obj.created_at = now;
  }
  obj.updated_by = actor;
  obj.updated_at = now; // LWW key — always bumped, never copied
  obj.is_deleted = parseBool(obj.is_deleted);

  const cells = toRow(schema, obj);

  // Data row first, changelog second — same order as the Dart engine. If the
  // changelog append fails the data row is already correct, and re-saving is
  // an idempotent overwrite of the same row, so a retry can't duplicate.
  let row;
  if (existing?.__row) {
    row = existing.__row;
    await sheets.updateRow(tabTitle, row, cells);
  } else {
    row = await sheets.appendRow(tabTitle, cells);
  }

  await sheets.appendRow(CHANGELOG.tab, [
    tabTitle,
    id,
    row,
    obj.updated_at,
    JSON.stringify(cells),
  ]);

  obj.__row = row;
  entry.byId.set(id, obj);
  emit(tabTitle);
  return obj;
}

/**
 * Saves many rows of one entity type in a handful of requests instead of a
 * handful per row.
 *
 * Same contract as save(): audit stamps, canonical column order, and one
 * _Changelog line per row. A reorder touching six categories costs 2 API
 * calls here versus 12 through save(), which is the difference between
 * comfortably under Google's per-minute write quota and tripping it.
 */
export async function saveMany(tabTitle, patches) {
  if (!patches.length) return [];
  const schema = schemaFor(tabTitle);
  const entry = cache.get(tabTitle);
  if (!entry) throw new Error(`Tab ${tabTitle} not loaded`);

  const actor = getUserEmail();
  const now = isoNow();

  const prepared = patches.map((patch) => {
    const id = String(patch.id || crypto.randomUUID());
    const existing = entry.byId.get(id);
    const obj = { ...(existing || {}), ...patch, id };
    delete obj.__row;

    obj.created_by = existing?.created_by || actor;
    obj.created_at = existing?.created_at || now;
    obj.updated_by = actor;
    obj.updated_at = now;
    obj.is_deleted = parseBool(obj.is_deleted);

    return { id, obj, existing, cells: toRow(schema, obj) };
  });

  const updates = prepared.filter((p) => p.existing?.__row);
  const creates = prepared.filter((p) => !p.existing?.__row);

  await sheets.batchUpdateValues(
    updates.map((p) => ({ tab: tabTitle, row: p.existing.__row, cells: p.cells })),
  );
  updates.forEach((p) => { p.row = p.existing.__row; });

  if (creates.length) {
    const firstRow = await sheets.appendRows(tabTitle, creates.map((p) => p.cells));
    creates.forEach((p, i) => { p.row = firstRow + i; });
  }

  // One changelog append for the whole batch — the phone reads these in order,
  // so a single multi-row append is equivalent to N single appends.
  await sheets.appendRows(
    CHANGELOG.tab,
    prepared.map((p) => [tabTitle, p.id, p.row, p.obj.updated_at, JSON.stringify(p.cells)]),
  );

  for (const p of prepared) {
    p.obj.__row = p.row;
    entry.byId.set(p.id, p.obj);
  }
  emit(tabTitle);
  return prepared.map((p) => p.obj);
}

/** Soft-deletes a row (is_deleted = true). Never removes it from the sheet. */
export async function remove(tabTitle, id) {
  const existing = byId(tabTitle, id);
  if (!existing) throw new Error('Row not found');
  return save(tabTitle, { ...existing, id, is_deleted: true });
}

/** Restores a soft-deleted row. */
export async function restore(tabTitle, id) {
  const existing = byId(tabTitle, id);
  if (!existing) throw new Error('Row not found');
  return save(tabTitle, { ...existing, id, is_deleted: false });
}

/** Creates any tabs the spreadsheet is missing, with their header rows. */
export async function ensureSchema() {
  return sheets.ensureTabs([
    ...TABS.map((t) => ({ title: t.tab, columns: t.columns })),
    { title: CHANGELOG.tab, columns: CHANGELOG.columns },
  ]);
}
