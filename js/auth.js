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

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
let userEmail = localStorage.getItem(EMAIL_KEY) || '';

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
          emit();
          resolve(accessToken);
        };
        client.error_callback = (err) => reject(new Error(err?.message || 'Sign-in cancelled'));
        client.requestAccessToken({ prompt: silent ? 'none' : 'consent' });
      })
      .catch(reject);
  });
}

/** Returns a valid token, refreshing silently when the current one expired. */
export async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  return requestToken({ silent: true });
}

export async function signIn() {
  const token = await requestToken({ silent: false });
  await fetchUserEmail();
  return token;
}

/** Restores a session on page load without showing any UI. */
export async function trySilentSignIn() {
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
