// Settings / first-run setup: OAuth client id + the spreadsheet share link.
// Both live in localStorage (see config.js) so nothing is baked into the files
// you deploy.

import { getConfig, setConfig, parseSpreadsheetId } from '../config.js';
import { getAuthState, signIn, signOut } from '../auth.js';
import * as repo from '../repo.js';
import * as sheets from '../sheets.js';
import { el, toast } from '../ui.js';

export function renderSettings(container, { onConnected } = {}) {
  const cfg = getConfig();
  const auth = getAuthState();
  const origin = window.location.origin;

  const clientInput = el('input', {
    class: 'input',
    type: 'text',
    value: cfg.clientId,
    placeholder: '1234567890-abcdef.apps.googleusercontent.com',
  });

  const sheetInput = el('input', {
    class: 'input',
    type: 'text',
    value: cfg.spreadsheetId
      ? `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/edit`
      : '',
    placeholder: 'Paste your Google Sheet link',
  });

  const status = el('div', { class: 'hint', style: 'margin-top:10px' });

  const pane = el('div', { class: 'center-pane' }, [
    el('div', { class: 'card' }, [
      el('h2', { text: 'Connect to your data' }),
      el('p', {
        text: 'The web console reads and writes the same Google Sheet your phone syncs to. '
          + 'Nothing is stored on a server — these settings stay in this browser.',
      }),

      el('div', { class: 'field' }, [
        el('label', { text: 'Google OAuth Client ID' }),
        clientInput,
        el('div', { class: 'hint' }, [
          'From Google Cloud Console → Credentials → OAuth client ID (Web application). ',
          el('strong', { text: 'Authorized JavaScript origins must include ' }),
          el('code', { text: origin }),
        ]),
      ]),

      el('div', { class: 'field' }, [
        el('label', { text: 'Google Sheet link' }),
        sheetInput,
        el('div', {
          class: 'hint',
          text: 'The spreadsheet the app created — "SufYam Home App Data". '
            + 'Open it in Drive and copy the URL from the address bar.',
        }),
      ]),

      el('div', { style: 'display:flex;gap:8px;margin-top:18px;flex-wrap:wrap' }, [
        el('button', { class: 'btn', text: auth.signedIn ? 'Save & reconnect' : 'Save & sign in', onclick: save }),
        auth.signedIn
          ? el('button', {
              class: 'btn btn-ghost',
              text: `Sign out (${auth.email || 'signed in'})`,
              onclick: () => { signOut(); toast('Signed out'); location.reload(); },
            })
          : null,
      ]),

      status,
    ]),

    el('div', { class: 'card', style: 'margin-top:16px' }, [
      el('h2', { class: 'card-title', text: 'First time? Do this once' }),
      el('ol', { class: 'steps' }, [
        el('li', {}, ['Open ', link('https://console.cloud.google.com/apis/credentials', 'Google Cloud Console → Credentials'), ' and pick the same project the phone app uses.']),
        el('li', { text: 'Create Credentials → OAuth client ID → Application type: Web application.' }),
        el('li', {}, ['Under "Authorized JavaScript origins" add ', el('code', { text: origin }), '.']),
        el('li', { text: 'Copy the Client ID it gives you into the box above.' }),
        el('li', { text: 'Make sure the Google account you sign in with can edit the spreadsheet.' }),
      ]),
    ]),

    el('div', { class: 'card', style: 'margin-top:16px' }, [
      el('h2', { class: 'card-title', text: 'Maintenance' }),
      el('p', {
        style: 'font-size:13px',
        text: 'If the spreadsheet is missing any tabs this app expects, this adds them with the correct headers. Safe to run anytime — existing tabs are left alone.',
      }),
      el('button', {
        class: 'btn btn-ghost',
        text: 'Verify / repair sheet tabs',
        onclick: async (e) => {
          const btn = e.target;
          btn.disabled = true;
          btn.textContent = 'Checking…';
          try {
            const added = await repo.ensureSchema();
            toast(added.length ? `Added tabs: ${added.join(', ')}` : 'All tabs present ✓');
          } catch (err) {
            toast(err.message, { error: true });
          } finally {
            btn.disabled = false;
            btn.textContent = 'Verify / repair sheet tabs';
          }
        },
      }),
    ]),
  ]);

  container.append(pane);

  async function save(e) {
    const btn = e.target;
    const clientId = clientInput.value.trim();
    const spreadsheetId = parseSpreadsheetId(sheetInput.value);

    if (!clientId) return fail('Enter your OAuth Client ID.');
    if (!spreadsheetId) return fail('That does not look like a Google Sheets link.');

    setConfig({ clientId, spreadsheetId });
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    status.textContent = '';

    try {
      await signIn();
      const info = await sheets.listTabs();
      toast(`Connected to "${info.title}"`);
      onConnected?.();
    } catch (err) {
      fail(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save & sign in';
    }
  }

  function fail(message) {
    status.textContent = message;
    status.style.color = 'var(--danger)';
  }
}

function link(href, text) {
  return el('a', { href, target: '_blank', rel: 'noopener', text, style: 'color:var(--accent)' });
}
