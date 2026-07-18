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

/**
 * append() that skips nullish children.
 *
 * The native Element.append stringifies null into the literal text "null",
 * so a conditional child like `isEdit ? auditBlock() : null` renders the word
 * "null" on the page. el() already filters these out; this is for the cases
 * that append directly to an existing node.
 */
export function append(parent, ...children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
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
export function openModal({
  title, render, actions, icon = '', danger = false, wide = false, size = '',
}) {
  const root = document.getElementById('modal-root');
  const body = el('div', { class: 'modal-body' });
  const foot = el('div', { class: 'modal-foot' });

  const head = el('div', { class: 'modal-head' }, [
    icon ? el('span', { class: `modal-icon${danger ? ' is-danger' : ''}`, text: icon }) : null,
    el('span', { class: 'modal-title', text: title }),
  ]);

  const close = () => {
    backdrop.classList.add('is-closing');
    setTimeout(() => backdrop.remove(), 120);
    document.removeEventListener('keydown', onKey);
  };

  // size wins when given; `wide` stays for callers that predate it.
  const sizeClass = size ? ` is-${size}` : (wide ? ' is-wide' : '');
  const modal = el('div', { class: `modal${sizeClass}` }, [
    head,
    body,
    foot,
  ]);
  modal.append(el('button', {
    class: 'modal-close',
    text: '✕',
    title: 'Close',
    onclick: () => close(),
  }));
  const backdrop = el('div', { class: 'modal-backdrop' }, [modal]);

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

/**
 * Confirmation dialog.
 *
 * `warnings` is a list of { icon, text } consequences, shown as distinct
 * callouts rather than crammed into one paragraph — the point of the dialog is
 * that each consequence gets read, and a wall of text doesn't get read.
 */
export function confirmDialog({
  title,
  message,
  warnings = [],
  note = '',
  confirmLabel = 'Delete',
  danger = true,
}) {
  return new Promise((resolve) => {
    let decided = false;

    openModal({
      title,
      danger,
      icon: danger ? '🗑' : 'ℹ',
      render: (body) => {
        body.append(el('p', { class: 'confirm-message', text: message }));
        if (warnings.length) {
          body.append(el('div', { class: 'confirm-warnings' }, warnings.map((w) => el('div', {
            class: 'confirm-warning',
          }, [
            el('span', { class: 'confirm-warning-icon', text: w.icon || '⚠' }),
            el('span', { text: w.text }),
          ]))));
        }
        if (note) body.append(el('p', { class: 'confirm-note', text: note }));
      },
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
