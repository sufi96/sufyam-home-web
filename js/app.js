// App shell: routing, boot sequence, theme, and the shared chrome.

import { TABS } from './schema.js';
import { isConfigured } from './config.js';
import {
  trySilentSignIn, getAuthState, onAuthChange, signIn, startTokenRefresh,
} from './auth.js';
import * as repo from './repo.js';
import { renderEntity } from './views/entity.js';
import { renderCategories } from './views/categories.js';
import { renderNotes } from './views/notes.js';
import { renderInventory } from './views/inventory.js';
import { renderDashboard } from './views/dashboard.js';
import { renderSettings } from './views/settings.js';
import { el, clear, toast, spinner } from './ui.js';

// Material Symbols, matching the icon set used for categories. Emoji rendered
// at inconsistent sizes and weights across platforms and looked pasted on.
const ICONS = {
  dashboard: 'donut_small',
  Categories: 'account_tree',
  Notes: 'sticky_note_2',
  Transactions: 'receipt_long',
  Inventory: 'inventory_2',
  Stock_Movements: 'swap_horiz',
  Records_Reminders: 'event_repeat',
  Budgets: 'savings',
  Taxonomy: 'style',
};

const ROUTES = [
  { id: 'dashboard', label: 'Dashboard' },
  ...TABS.map((t) => ({ id: t.tab, label: t.label })),
];

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const pageTitle = document.getElementById('page-title');
const banner = document.getElementById('banner');
const syncStatus = document.getElementById('sync-status');

let current = 'dashboard';
let dataReady = false;

// ---------- theme ----------

function initTheme() {
  const saved = localStorage.getItem('sufyam.theme');
  if (saved) document.documentElement.dataset.theme = saved;
  document.getElementById('btn-theme').addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme
        && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('sufyam.theme', next);
    if (dataReady) render(); // redraw charts with the new text colours
  });
}

// ---------- nav ----------

function buildNav() {
  clear(nav);
  for (const route of ROUTES) {
    nav.append(el('button', {
      class: `nav-item${route.id === current ? ' active' : ''}`,
      onclick: () => go(route.id),
    }, [
      el('span', { class: 'micon nav-icon', text: ICONS[route.id] || 'circle' }),
      route.label,
    ]));
  }
}

function go(id) {
  current = id;
  location.hash = id;
  buildNav();
  render();
  document.querySelector('.sidebar').classList.remove('open');
}

// ---------- render ----------

function render() {
  clear(view);
  const route = ROUTES.find((r) => r.id === current);
  pageTitle.textContent = route?.label || 'Settings';

  if (current === 'settings') {
    renderSettings(view, { onConnected: boot });
    return;
  }

  if (!dataReady) return;

  if (current === 'dashboard') renderDashboard(view);
  else if (current === 'Categories') renderCategories(view);
  else if (current === 'Notes') renderNotes(view);
  else if (current === 'Inventory') renderInventory(view);
  else renderEntity(view, current);
}

function setBanner(message, isError = false) {
  if (!message) {
    banner.classList.add('hidden');
    return;
  }
  banner.textContent = message;
  banner.classList.toggle('error', isError);
  banner.classList.remove('hidden');
}

function updateAccount() {
  const { email, signedIn } = getAuthState();
  document.getElementById('account').textContent = signedIn
    ? (email || 'Signed in')
    : 'Not signed in';
}

function updateSyncStatus() {
  const at = repo.lastLoadedAt();
  syncStatus.textContent = at
    ? `Updated ${at.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}`
    : '';
}

// ---------- boot ----------

async function boot() {
  updateAccount();

  if (!isConfigured()) {
    current = 'settings';
    buildNav();
    render();
    return;
  }

  view.replaceChildren(spinner());

  // Already holding a live token (e.g. we just came back from an interactive
  // sign-in) — don't re-validate, or a blocked silent request undoes it.
  const ok = getAuthState().signedIn || await trySilentSignIn();
  updateAccount();

  if (!ok) {
    clear(view);
    view.append(el('div', { class: 'center-pane' }, [
      el('div', { class: 'card' }, [
        el('h2', { text: 'Sign in to continue' }),
        el('p', { text: 'Connect your Google account to read and edit your household data.' }),
        el('button', {
          class: 'btn',
          text: 'Sign in with Google',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await signIn();
              await boot();
            } catch (err) {
              e.target.disabled = false;
              toast(err.message, { error: true });
            }
          },
        }),
      ]),
    ]));
    return;
  }

  await loadData();
}

async function loadData() {
  try {
    view.replaceChildren(spinner());
    await repo.loadAll();

    // A sheet created before this build won't have the columns added since.
    // Naming them in the header row costs one write and has to happen before
    // anything saves, or the new values would sit under blank headings.
    const extended = await repo.extendHeaders();
    if (extended.length) toast(`Added new columns to ${extended.join(', ')}`);

    dataReady = true;
    setBanner('');

    const drift = repo.headerWarnings();
    if (drift.length) {
      setBanner(
        `Heads up: the header row in ${drift.join(', ')} does not match the column order the app expects. `
        + 'Edits may land in the wrong columns — check those tabs before writing.',
        true,
      );
    }

    updateSyncStatus();
    render();
  } catch (err) {
    dataReady = false;
    clear(view);
    setBanner(err.message, true);
    view.append(el('div', { class: 'center-pane' }, [
      el('div', { class: 'card' }, [
        el('h2', { text: 'Could not load your sheet' }),
        el('p', { text: err.message }),
        el('button', { class: 'btn btn-ghost', text: 'Open settings', onclick: () => go('settings') }),
      ]),
    ]));
  }
}

// ---------- wiring ----------

initTheme();
buildNav();

document.getElementById('btn-settings').addEventListener('click', () => go('settings'));
document.getElementById('btn-refresh').addEventListener('click', async () => {
  if (!isConfigured()) return go('settings');
  await loadData();
  toast('Reloaded');
});
document.getElementById('btn-menu').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('open');
});

onAuthChange(updateAccount);
startTokenRefresh();
repo.onDataChange(updateSyncStatus);

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== current && (ROUTES.some((r) => r.id === id) || id === 'settings')) {
    current = id;
    buildNav();
    render();
  }
});

const initial = location.hash.slice(1);
if (initial && (ROUTES.some((r) => r.id === initial) || initial === 'settings')) {
  current = initial;
}

boot();
