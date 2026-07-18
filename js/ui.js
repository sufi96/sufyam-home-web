// Small DOM + formatting helpers. No framework: everything builds real nodes,
// and text always goes in via textContent so sheet data can never inject HTML.

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---------- formatting ----------

const money = new Intl.NumberFormat('en-MY', {
  style: 'currency',
  currency: 'MYR',
  minimumFractionDigits: 2,
});

export function fmtMoney(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? money.format(n) : '—';
}

export function fmtNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? String(n) : '—';
}

export function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-MY', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Days from today until `v`. Negative when overdue. */
export function daysUntil(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

/** 'YYYY-MM-DD' for <input type=date>. */
export function toDateInput(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DDTHH:MM' in local time, for <input type=datetime-local>. */
export function toDateTimeInput(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- toast ----------

export function toast(message, { error = false, ms = 3400 } = {}) {
  const root = document.getElementById('toast-root');
  const node = el('div', { class: `toast${error ? ' error' : ''}`, text: message });
  root.append(node);
  setTimeout(() => node.remove(), ms);
}

// ---------- modal ----------

/**
 * Opens a modal. `render(body, close)` fills the body; `actions` builds the
 * footer buttons. Returns a close function.
 */
export function openModal({ title, render, actions }) {
  const root = document.getElementById('modal-root');
  const body = el('div', { class: 'modal-body' });
  const foot = el('div', { class: 'modal-foot' });
  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head', text: title }),
    body,
    foot,
  ]);
  const backdrop = el('div', { class: 'modal-backdrop' }, [modal]);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);

  render(body, close);
  foot.append(...actions(close));
  root.append(backdrop);

  const firstInput = body.querySelector('input, select, textarea');
  if (firstInput) firstInput.focus();
  return close;
}

export function confirmDialog({ title, message, confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    let decided = false;
    const close = openModal({
      title,
      render: (body) => body.append(el('p', { text: message, style: 'margin:0;color:var(--text-dim)' })),
      actions: (dismiss) => [
        el('button', {
          class: 'btn btn-ghost',
          text: 'Cancel',
          onclick: () => { decided = true; dismiss(); resolve(false); },
        }),
        el('button', {
          class: `btn${danger ? ' btn-danger' : ''}`,
          text: confirmLabel,
          onclick: () => { decided = true; dismiss(); resolve(true); },
        }),
      ],
    });
    // Backdrop / Escape dismissal counts as "no".
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.modal-backdrop') && !decided) {
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(document.getElementById('modal-root'), { childList: true });
    void close;
  });
}

export function spinner() {
  return el('div', { class: 'spinner' });
}

export function emptyState(icon, message, action) {
  return el('div', { class: 'empty' }, [
    el('span', { class: 'empty-icon', text: icon }),
    el('div', { text: message }),
    action ? el('div', { style: 'margin-top:16px' }, [action]) : null,
  ]);
}
