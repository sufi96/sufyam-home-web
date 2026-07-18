// Rich text for note blocks: a contenteditable surface, a formatting toolbar,
// and — the important part — a sanitizer.
//
// Note bodies are stored as HTML in a spreadsheet that may be shared with
// other people and can be edited by hand in Google Sheets. Anything read back
// is therefore untrusted input being inserted into the DOM, so it goes through
// a strict allowlist first. Without that, a single hand-typed <img onerror>
// in a cell would run script on every device that opens the note.

const ALLOWED = {
  p: [], br: [], div: [], span: [],
  b: [], strong: [], i: [], em: [], u: [], s: [], strike: [],
  h1: [], h2: [], h3: [],
  ul: [], ol: [], li: [],
  blockquote: [], code: [], pre: [],
  a: ['href'],
};

const SAFE_PROTOCOL = /^(https?:|mailto:|tel:)/i;

/**
 * Returns HTML containing only allowlisted tags, with every attribute dropped
 * except a safe href. Anything unrecognised is unwrapped rather than deleted,
 * so text is never silently lost — only the markup around it.
 */
export function sanitizeHtml(dirty) {
  const doc = new DOMParser().parseFromString(`<body>${dirty || ''}</body>`, 'text/html');
  const out = document.createDocumentFragment();
  for (const node of [...doc.body.childNodes]) {
    const clean = cleanNode(node);
    if (clean) out.append(clean);
  }
  const host = document.createElement('div');
  host.append(out);
  return host.innerHTML;
}

function cleanNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.nodeValue);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const tag = node.tagName.toLowerCase();
  const children = [...node.childNodes].map(cleanNode).filter(Boolean);

  if (!Object.hasOwn(ALLOWED, tag)) {
    // Unknown element: keep its text, discard the element itself. script and
    // style are dropped whole, since their "text" is code, not content.
    if (tag === 'script' || tag === 'style' || tag === 'iframe') return null;
    const frag = document.createDocumentFragment();
    children.forEach((c) => frag.append(c));
    return frag;
  }

  const clean = document.createElement(tag);
  for (const attr of ALLOWED[tag]) {
    const value = node.getAttribute(attr);
    if (attr === 'href') {
      if (value && SAFE_PROTOCOL.test(value.trim())) {
        clean.setAttribute('href', value.trim());
        clean.setAttribute('target', '_blank');
        clean.setAttribute('rel', 'noopener noreferrer');
      }
    } else if (value !== null) {
      clean.setAttribute(attr, value);
    }
  }
  children.forEach((c) => clean.append(c));
  return clean;
}

// Elements that imply a line break when flattening markup to text.
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'pre']);

/**
 * Plain text of some stored HTML, for card previews and search.
 *
 * textContent alone runs every paragraph together into a single line, which is
 * what made a multi-paragraph note preview as a wall of text. This walks the
 * tree and emits a newline wherever the markup implies one.
 */
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  let out = '';

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.nodeValue;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName.toLowerCase();
      if (tag === 'br') { out += '\n'; continue; }

      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock && out && !out.endsWith('\n')) out += '\n';
      if (tag === 'li') out += '• ';
      walk(child);
      if (isBlock && !out.endsWith('\n')) out += '\n';
    }
  };
  walk(doc.body);

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isBlankHtml(html) {
  return htmlToText(html).length === 0;
}

const TOOLS = [
  { cmd: 'bold', icon: 'format_bold', title: 'Bold (Ctrl+B)' },
  { cmd: 'italic', icon: 'format_italic', title: 'Italic (Ctrl+I)' },
  { cmd: 'underline', icon: 'format_underlined', title: 'Underline (Ctrl+U)' },
  { cmd: 'strikeThrough', icon: 'format_strikethrough', title: 'Strikethrough' },
  { sep: true },
  { block: 'h1', icon: 'format_h1', title: 'Large heading' },
  { block: 'h2', icon: 'format_h2', title: 'Heading' },
  { block: 'h3', icon: 'format_h3', title: 'Small heading' },
  { block: 'p', icon: 'format_paragraph', title: 'Normal text' },
  { sep: true },
  { cmd: 'insertUnorderedList', icon: 'format_list_bulleted', title: 'Bullet list' },
  { cmd: 'insertOrderedList', icon: 'format_list_numbered', title: 'Numbered list' },
  { block: 'blockquote', icon: 'format_quote', title: 'Quote' },
  { block: 'pre', icon: 'code', title: 'Code block' },
  { sep: true },
  { link: true, icon: 'link', title: 'Add link' },
  { cmd: 'removeFormat', icon: 'format_clear', title: 'Clear formatting' },
];

/**
 * Builds an editable rich-text surface. `onChange(html)` fires with sanitized
 * HTML whenever the content settles.
 *
 * Uses document.execCommand: it is formally deprecated, but it is also the
 * only way to get selection-aware formatting without pulling in an editor
 * library, and this project has no build step. Every browser still implements
 * it, and the output is sanitized on the way out regardless.
 */
export function richTextEditor(initialHtml, onChange) {
  const surface = document.createElement('div');
  surface.className = 'rt-surface';
  surface.contentEditable = 'true';
  surface.spellcheck = true;
  surface.innerHTML = sanitizeHtml(initialHtml) || '';
  surface.dataset.placeholder = 'Write something…';

  const emit = () => onChange(sanitizeHtml(surface.innerHTML));

  const toolbar = document.createElement('div');
  toolbar.className = 'rt-toolbar';

  for (const tool of TOOLS) {
    if (tool.sep) {
      const sep = document.createElement('span');
      sep.className = 'rt-sep';
      toolbar.append(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rt-btn';
    btn.title = tool.title;
    btn.innerHTML = '';
    const glyph = document.createElement('span');
    glyph.className = 'micon';
    glyph.textContent = tool.icon;
    btn.append(glyph);

    // mousedown, not click: the surface must not lose its selection before
    // the command runs, and clicking a button blurs it.
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      surface.focus();
      if (tool.link) {
        const url = window.prompt('Link URL');
        if (url && SAFE_PROTOCOL.test(url.trim())) {
          document.execCommand('createLink', false, url.trim());
        }
      } else if (tool.block) {
        document.execCommand('formatBlock', false, tool.block);
      } else {
        document.execCommand(tool.cmd, false, null);
      }
      emit();
      refreshState();
    });
    btn.dataset.cmd = tool.cmd || '';
    btn.dataset.block = tool.block || '';
    toolbar.append(btn);
  }

  function refreshState() {
    for (const btn of toolbar.querySelectorAll('.rt-btn')) {
      const { cmd } = btn.dataset;
      if (!cmd) continue;
      let active = false;
      try {
        active = document.queryCommandState(cmd);
      } catch {
        active = false;
      }
      btn.classList.toggle('is-active', active);
    }
  }

  surface.addEventListener('input', emit);
  surface.addEventListener('keyup', refreshState);
  surface.addEventListener('mouseup', refreshState);
  surface.addEventListener('blur', emit);

  // Pasting from a web page or Word carries a payload of markup; take the
  // plain text and let the user re-apply formatting deliberately.
  surface.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  const wrap = document.createElement('div');
  wrap.className = 'rt-editor';
  wrap.append(toolbar, surface);
  return wrap;
}

/** Read-only rendering of stored HTML, safe to insert into the page. */
export function renderRichText(html, className = 'rt-render') {
  const node = document.createElement('div');
  node.className = className;
  node.innerHTML = sanitizeHtml(html);
  return node;
}
