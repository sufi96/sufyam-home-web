// Google sign-in via Google Identity Services (GIS), browser-only.
//
// Two separate GIS pieces are used together:
//   1. an OAuth *token client* -> the access token used for Sheets API calls
//   2. a One Tap / ID token credential -> the signed-in user's email, which
//      the app stamps into created_by / updated_by
//
// Access tokens last ~1h. requestToken({ silent: true }) reuses the existing
// Google session without a popup, so an expired token refreshes invisibly;
// only the very first sign-in shows the consent screen.

import { getConfig } from './config.js';

// Sheets + the account's email address. The spreadsheet is addressed by id
// from a pasted share link, so no Drive scope is needed — a narrower grant
// than the mobile app's. `email` is what lets us stamp created_by/updated_by.
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets email';
const EMAIL_KEY = 'sufyam.web.email';
const TOKEN_KEY = 'sufyam.web.token';

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
let userEmail = localStorage.getItem(EMAIL_KEY) || '';

// Google's browser flow issues access tokens that last about an hour and no
// refresh token — those only exist in the server-side flow, which this app
// deliberately doesn't have. Caching the token means reloading the page, or
// coming back ten minutes later, doesn't re-prompt; only the hourly expiry
// does.
//
// The trade-off: a stored token is readable by any script that manages to run
// on this origin. It is scoped to one spreadsheet plus your email address, it
// expires within the hour, and this page renders all sheet content through
// textContent (never innerHTML), so there is no injection path from your data.
function loadStoredToken() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (raw && raw.token && Date.now() < raw.expiry) {
      accessToken = raw.token;
      tokenExpiry = raw.expiry;
    } else if (raw) {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    localStorage.removeItem(TOKEN_KEY);
  }
}

function storeToken() {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: accessToken, expiry: tokenExpiry }));
  } catch {
    // Storage full or blocked — the in-memory token still works this session.
  }
}

loadStoredToken();

const listeners = new Set();

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn(getAuthState()));
}

export function getAuthState() {
  return {
    signedIn: Boolean(accessToken) && Date.now() < tokenExpiry,
    email: userEmail,
  };
}

export function getUserEmail() {
  return userEmail || 'web';
}

function waitForGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    let waited = 0;
    const timer = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(timer);
        resolve();
      } else if ((waited += 100) > 10000) {
        clearInterval(timer);
        reject(new Error('Google sign-in library failed to load. Check your connection.'));
      }
    }, 100);
  });
}

async function ensureTokenClient() {
  const { clientId } = getConfig();
  if (!clientId) throw new Error('No OAuth Client ID set. Open Settings first.');
  await waitForGis();
  if (tokenClient && tokenClient.__clientId === clientId) return tokenClient;

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: () => {}, // replaced per-request below
  });
  tokenClient.__clientId = clientId;
  return tokenClient;
}

/**
 * Requests an access token. With { silent: true } no popup is shown; the
 * promise rejects if Google would have needed to prompt.
 */
export function requestToken({ silent = false } = {}) {
  return new Promise((resolve, reject) => {
    ensureTokenClient()
      .then((client) => {
        client.callback = (resp) => {
          if (resp.error) {
            reject(new Error(resp.error_description || resp.error));
            return;
          }
          accessToken = resp.access_token;
          // Refresh a minute early so a call can't die mid-flight.
          tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
          storeToken();
          emit();
          resolve(accessToken);
        };
        client.error_callback = (err) => reject(new Error(err?.message || 'Sign-in cancelled'));
        // '' (not 'consent') for the interactive path: Google then shows the
        // consent screen only when it actually needs to, instead of re-asking
        // on every single sign-in.
        client.requestAccessToken({ prompt: silent ? 'none' : '' });
      })
      .catch(reject);
  });
}

/**
 * Drops the cached token. Called when Google rejects it (401) so a stale
 * stored token can't wedge the app into a permanent error state.
 */
export function invalidateToken() {
  accessToken = null;
  tokenExpiry = 0;
  localStorage.removeItem(TOKEN_KEY);
  emit();
}

/** Returns a valid token, refreshing silently when the current one expired. */
export async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  return requestToken({ silent: true });
}

/**
 * True when the next API call would need Google's sign-in popup.
 *
 * Deliberately synchronous. Callers check this at the very top of a click
 * handler, *before* any await, so the popup can be opened while the browser
 * still counts the click as user activation. Opening it after an await — which
 * is what happens if you let a save discover the expiry mid-flight — gets it
 * blocked, and a blocked popup means the save fails.
 */
export function needsInteractiveAuth() {
  return !accessToken || Date.now() >= tokenExpiry;
}

/** Milliseconds until the current token expires (0 if there isn't one). */
export function tokenLifetimeLeft() {
  return accessToken ? Math.max(0, tokenExpiry - Date.now()) : 0;
}

/**
 * Keeps the token warm in the background so it rarely expires while the user
 * is mid-edit. Silent refresh is best-effort: if the browser blocks it (third
 * party cookies), the interactive path still covers it.
 */
export function startTokenRefresh() {
  const REFRESH_BEFORE = 5 * 60 * 1000;
  setInterval(async () => {
    if (!accessToken) return;
    if (tokenExpiry - Date.now() > REFRESH_BEFORE) return;
    try {
      await requestToken({ silent: true });
    } catch {
      // Left for the interactive path to handle on the next action.
    }
  }, 60 * 1000);
}

export async function signIn() {
  const token = await requestToken({ silent: false });
  await fetchUserEmail();
  return token;
}

/**
 * Restores a session on page load without showing any UI.
 *
 * The already-have-a-token check is load-bearing: browsers that block
 * third-party cookies reject `prompt: 'none'` requests outright, so without it
 * a just-completed interactive sign-in would be discarded and the user bounced
 * straight back to the sign-in screen — an endless loop.
 */
export async function trySilentSignIn() {
  if (getAuthState().signedIn) return true;
  try {
    await requestToken({ silent: true });
    if (!userEmail) await fetchUserEmail();
    return true;
  } catch {
    return false;
  }
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiry = 0;
  userEmail = '';
  localStorage.removeItem(EMAIL_KEY);
  localStorage.removeItem(TOKEN_KEY);
  emit();
}

/**
 * Reads the account email from the OAuth userinfo endpoint. Used only to
 * stamp created_by / updated_by, matching what the mobile app records.
 */
async function fetchUserEmail() {
  try {
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.email) {
      userEmail = data.email;
      localStorage.setItem(EMAIL_KEY, userEmail);
      emit();
    }
  } catch {
    // Non-fatal: writes still work, just stamped as 'web'.
  }
}
