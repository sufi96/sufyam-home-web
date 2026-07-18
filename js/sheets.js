// Thin fetch wrapper over the Google Sheets v4 REST API — the JS counterpart
// of lib/features/sync/sheets_client.dart. Deliberately dumb: it knows about
// ranges and values, nothing about entities, audit fields or the changelog.
// All of that lives in repo.js.

import { getAccessToken, invalidateToken } from './auth.js';
import { getConfig } from './config.js';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

function sid() {
  const { spreadsheetId } = getConfig();
  if (!spreadsheetId) throw new Error('No spreadsheet selected. Open Settings first.');
  return spreadsheetId;
}

async function api(path, { method = 'GET', body, params, retried = false } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${BASE}/${sid()}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v !== undefined) url.searchParams.set(k, v);
  });

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.json())?.error?.message || '';
    } catch {
      /* body wasn't JSON */
    }
    // A rejected token is worth retrying once: it's usually just expiry, and
    // silently re-acquiring beats making the user click through an error.
    if (resp.status === 401 && !retried) {
      invalidateToken();
      return api(path, { method, body, params, retried: true });
    }
    if (resp.status === 429) {
      throw new RateLimitError(friendlyError(resp.status, detail));
    }
    throw new Error(friendlyError(resp.status, detail));
  }
  return resp.json();
}

export class RateLimitError extends Error {}

function friendlyError(status, detail) {
  if (status === 401) return 'Session expired — please sign in again.';
  if (status === 403) {
    return `No permission for this spreadsheet. Make sure the signed-in Google account can edit it. ${detail}`;
  }
  if (status === 404) return 'Spreadsheet not found. Check the link in Settings.';
  if (status === 429) {
    return 'Google is rate-limiting this app (too many reads/writes in a minute). '
      + 'Waiting a few seconds and retrying usually clears it.';
  }
  return detail || `Sheets API error ${status}`;
}

/** Tab titles that currently exist in the spreadsheet. */
export async function listTabs() {
  const data = await api('', { params: { fields: 'sheets.properties.title,properties.title' } });
  return {
    title: data.properties?.title || '',
    tabs: (data.sheets || []).map((s) => s.properties?.title).filter(Boolean),
  };
}

/** Reads a whole tab, returning the raw 2D array of strings (header included). */
export async function readTab(tab) {
  const data = await api(`/values/${encodeURIComponent(`${tab}!A1:ZZ`)}`, {
    params: { valueRenderOption: 'UNFORMATTED_VALUE' },
  });
  return (data.values || []).map((row) => row.map((c) => (c === null || c === undefined ? '' : String(c))));
}

/** Reads several tabs in one round-trip. Returns { tabTitle: rows[][] }. */
export async function readTabs(tabs) {
  if (!tabs.length) return {};
  const data = await api('/values:batchGet', {
    params: {
      ranges: tabs.map((t) => `${t}!A1:ZZ`),
      valueRenderOption: 'UNFORMATTED_VALUE',
    },
  });
  const out = {};
  (data.valueRanges || []).forEach((vr, i) => {
    out[tabs[i]] = (vr.values || []).map((row) =>
      row.map((c) => (c === null || c === undefined ? '' : String(c))),
    );
  });
  return out;
}

// Matches SheetsClient.parseRowNumber in the Dart app: "Sheet1!A6:E6" -> 6.
const ROW_PATTERN = /![A-Za-z]+(\d+)/;

export function parseRowNumber(range) {
  const m = ROW_PATTERN.exec(range || '');
  return m ? parseInt(m[1], 10) : null;
}

/** Appends one row and returns the 1-indexed sheet row it landed on. */
export async function appendRow(tab, cells) {
  const data = await api(`/values/${encodeURIComponent(`${tab}!A1`)}:append`, {
    method: 'POST',
    params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
    body: { values: [cells] },
  });
  const row = parseRowNumber(data.updates?.updatedRange);
  if (row === null) throw new Error(`Sheets append did not return a row range for ${tab}`);
  return row;
}

/**
 * Appends several rows to one tab in a single request and returns the
 * 1-indexed sheet row the first one landed on (the rest follow in order).
 */
export async function appendRows(tab, rowsOfCells) {
  if (!rowsOfCells.length) return null;
  const data = await api(`/values/${encodeURIComponent(`${tab}!A1`)}:append`, {
    method: 'POST',
    params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
    body: { values: rowsOfCells },
  });
  const row = parseRowNumber(data.updates?.updatedRange);
  if (row === null) throw new Error(`Sheets append did not return a row range for ${tab}`);
  return row;
}

/**
 * Overwrites many known rows across any tabs in ONE request.
 *
 * This is what keeps bulk edits under Google's per-minute write quota: a
 * category reorder touching six rows costs one call here instead of six.
 */
export async function batchUpdateValues(entries) {
  if (!entries.length) return;
  await api('/values:batchUpdate', {
    method: 'POST',
    body: {
      valueInputOption: 'RAW',
      data: entries.map((e) => ({
        range: `${e.tab}!A${e.row}`,
        values: [e.cells],
      })),
    },
  });
}

/** Overwrites one specific, already-known row. */
export async function updateRow(tab, row, cells) {
  await api(`/values/${encodeURIComponent(`${tab}!A${row}`)}`, {
    method: 'PUT',
    params: { valueInputOption: 'RAW' },
    body: { values: [cells] },
  });
}

/** Creates any missing tabs and writes their header rows. */
export async function ensureTabs(required) {
  const { tabs } = await listTabs();
  const existing = new Set(tabs);
  const missing = required.filter((t) => !existing.has(t.title));
  if (!missing.length) return [];

  await api(':batchUpdate', {
    method: 'POST',
    body: {
      requests: missing.map((t) => ({ addSheet: { properties: { title: t.title } } })),
    },
  });
  for (const t of missing) {
    await updateRow(t.title, 1, t.columns);
  }
  return missing.map((t) => t.title);
}
