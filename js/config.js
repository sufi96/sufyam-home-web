// Local settings: OAuth client id + which spreadsheet to use. Both are stored
// in localStorage so nothing is hard-coded into the deployed files.
//
// The client id is NOT a secret — browser OAuth clients are public by design;
// what actually protects the data is the "Authorized JavaScript origins" list
// on the credential plus the user's own Google sign-in.

const KEY = 'sufyam.web.config';

// Intentionally empty — both values are entered once per browser in Settings
// and kept in localStorage.
//
// The spreadsheet id is deliberately NOT hard-coded here. This folder is meant
// to be pushed to a public GitHub repo for Pages hosting, and if the sheet is
// shared as "anyone with the link can edit", the id in a public file is
// effectively the password to your household data.
const DEFAULTS = {
  clientId: '',
  spreadsheetId: '',
};

let cache = null;

export function getConfig() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setConfig(patch) {
  cache = { ...getConfig(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(cache));
  return cache;
}

export function isConfigured() {
  const c = getConfig();
  return Boolean(c.clientId && c.spreadsheetId);
}

/**
 * Accepts a full Google Sheets share URL or a bare id and returns the id.
 * Share links look like:
 *   https://docs.google.com/spreadsheets/d/<ID>/edit?usp=sharing
 */
export function parseSpreadsheetId(input) {
  const raw = (input || '').trim();
  if (!raw) return '';
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  // Already a bare id (Google ids are long and have no slashes).
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) return raw;
  return '';
}
