// Dashboard, mirroring the Flutter expense report
// (lib/features/reports/expense_report_screen.dart): a period bar, headline
// stat tiles, a trend chart, a breakdown, ranked bars for categories and
// labels, and the largest expenses — plus the renewals and low-stock panels
// that only exist here.
//
// The trend is a multi-line chart rather than the phone's single series: a
// wide screen has room to compare categories against each other over time,
// which is the one thing the phone's narrow layout can't show. Each line is
// drawn in that category's own colour so it matches the tree.

import * as repo from '../repo.js';
import { parseNum } from '../schema.js';
import { shortages } from '../stock.js';
import * as taxonomy from '../taxonomy.js';
import { iconEl } from '../icons.js';
import { el, clear, fmtMoney, fmtDate, daysUntil, emptyState } from '../ui.js';

const TREND_SERIES = 5; // top categories drawn as their own lines

export function renderDashboard(container) {
  // Anchor month for every figure on the page; the trend shows the window
  // ending here so the tiles and the chart always agree.
  let anchor = startOfMonth(new Date());
  let windowMonths = Number(localStorage.getItem('sufyam.dash.window') || 6);

  function paint() {
    clear(container);

    const txns = repo.rows('Transactions');
    const categories = repo.rows('Categories');
    const catById = new Map(categories.map((c) => [c.id, c]));
    const isIncome = (t) => catById.get(t.category_id)?.type === 'income';

    const periodEnd = endOfMonth(anchor);
    const inPeriod = txns.filter((t) => within(t.transaction_date, anchor, periodEnd));
    const prevStart = addMonths(anchor, -1);
    const inPrev = txns.filter((t) => within(t.transaction_date, prevStart, endOfMonth(prevStart)));

    const spent = sum(inPeriod.filter((t) => !isIncome(t)));
    const prevSpent = sum(inPrev.filter((t) => !isIncome(t)));
    const earned = sum(inPeriod.filter(isIncome));
    const delta = prevSpent ? ((spent - prevSpent) / prevSpent) * 100 : null;

    // One entry per thing to buy, not per row: a category that pools its stock
    // collapses to a single line, and items marked "use up" are left out.
    // See stock.js.
    const lowStock = shortages(
      repo.rows('Inventory'),
      taxonomy.list(taxonomy.KIND_INVENTORY_CATEGORY),
    );
    const dueSoon = repo.rows('Records_Reminders')
      .map((r) => ({ ...r, days: daysUntil(r.due_date) }))
      .filter((r) => r.days !== null && r.days <= 30)
      .sort((a, b) => a.days - b.days);

    container.append(periodBar());

    // ---------- hero tiles ----------
    container.append(el('div', { class: 'grid grid-stats', style: 'margin-bottom:16px' }, [
      statCard('Spent', fmtMoney(spent), `${inPeriod.filter((t) => !isIncome(t)).length} transactions`),
      // Replaces the old budget tile: a like-for-like comparison with the
      // month before says more than a budget this household doesn't set.
      statCard(
        'vs previous month',
        delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(0)}%`,
        `${fmtMoney(prevSpent)} last month`,
        delta === null ? null : (delta > 0 ? 'var(--danger)' : 'var(--accent)'),
      ),
      statCard(
        'Daily average',
        fmtMoney(spent / daysElapsed(anchor)),
        `over ${daysElapsed(anchor)} days`,
      ),
      statCard(
        'Needs attention',
        String(lowStock.length + dueSoon.filter((r) => r.days <= 7).length),
        `${lowStock.length} low stock · ${dueSoon.filter((r) => r.days <= 7).length} due this week`,
      ),
    ]));

    // ---------- full-width trend ----------
    const trendCanvas = el('canvas');
    const trend = buildTrend(txns, catById, isIncome);

    container.append(el('div', { class: 'card', style: 'margin-bottom:16px' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', style: 'margin:0', text: `Spending trend — last ${windowMonths} months` }),
        el('div', { class: 'segmented' }, [6, 12].map((n) => el('button', {
          class: `segmented-btn${n === windowMonths ? ' is-active' : ''}`,
          text: `${n}M`,
          onclick: () => {
            windowMonths = n;
            localStorage.setItem('sufyam.dash.window', String(n));
            paint();
          },
        }))),
      ]),
      trend.series.length
        ? el('div', { class: 'chart-wrap chart-wide' }, [trendCanvas])
        : emptyState('📈', 'No spending recorded in this window.'),
    ]));

    // ---------- breakdown + top categories ----------
    const pieCanvas = el('canvas');
    const topCats = rankRootCategories(inPeriod, catById, isIncome);

    container.append(el('div', { class: 'grid grid-2', style: 'margin-bottom:16px' }, [
      el('div', { class: 'card' }, [
        el('h2', { class: 'card-title', text: 'Breakdown' }),
        topCats.length
          ? el('div', { class: 'chart-wrap' }, [pieCanvas])
          : emptyState('🍩', 'Nothing spent this month.'),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { class: 'card-title', text: 'Top categories' }),
        rankedBars(topCats),
      ]),
    ]));

    // ---------- labels + largest ----------
    container.append(el('div', { class: 'grid grid-2', style: 'margin-bottom:16px' }, [
      el('div', { class: 'card' }, [
        el('h2', { class: 'card-title', text: 'By label' }),
        rankedBars(rankLabels(inPeriod, isIncome)),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { class: 'card-title', text: 'Largest expenses' }),
        largestList(inPeriod.filter((t) => !isIncome(t)), catById),
      ]),
    ]));

    // ---------- renewals + stock (web-only panels, kept) ----------
    container.append(el('div', { class: 'grid grid-2' }, [
      el('div', { class: 'card' }, [
        el('h2', { class: 'card-title', text: 'Due in the next 30 days' }),
        dueSoon.length
          ? el('div', {}, dueSoon.slice(0, 8).map(dueRow))
          : emptyState('✅', 'Nothing due soon.'),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { class: 'card-title', text: 'Low stock' }),
        lowStock.length
          ? el('div', {}, lowStock.slice(0, 8).map(stockRow))
          : emptyState('📦', 'Everything is above its threshold.'),
      ]),
    ]));

    requestAnimationFrame(() => {
      if (!window.Chart) return;
      if (trend.series.length) drawTrend(trendCanvas, trend);
      if (topCats.length) drawBreakdown(pieCanvas, topCats);
    });
  }

  function periodBar() {
    const isCurrent = sameMonth(anchor, new Date());
    return el('div', { class: 'period-bar' }, [
      el('button', {
        class: 'btn btn-ghost btn-icon',
        title: 'Previous month',
        onclick: () => { anchor = addMonths(anchor, -1); paint(); },
      }, [el('span', { class: 'micon', text: 'chevron_left' })]),
      el('div', { class: 'period-label' }, [
        el('div', { class: 'period-month', text: monthLabel(anchor) }),
        el('div', { class: 'period-sub', text: isCurrent ? 'This month' : '' }),
      ]),
      el('button', {
        class: 'btn btn-ghost btn-icon',
        title: 'Next month',
        disabled: isCurrent || null,
        onclick: () => { anchor = addMonths(anchor, 1); paint(); },
      }, [el('span', { class: 'micon', text: 'chevron_right' })]),
      el('div', { style: 'flex:1' }),
      isCurrent ? null : el('button', {
        class: 'btn btn-ghost btn-sm',
        text: 'Back to this month',
        onclick: () => { anchor = startOfMonth(new Date()); paint(); },
      }),
    ]);
  }

  /** Monthly totals per top category, plus an overall line. */
  function buildTrend(txns, catById, isIncome) {
    const months = [];
    for (let i = windowMonths - 1; i >= 0; i--) months.push(addMonths(anchor, -i));

    const rootOf = (t) => {
      let cat = catById.get(t.category_id);
      let guard = 0;
      while (cat?.parent_id && catById.has(cat.parent_id) && guard++ < 5) {
        cat = catById.get(cat.parent_id);
      }
      return cat;
    };

    const windowStart = months[0];
    const windowEnd = endOfMonth(months[months.length - 1]);
    const scoped = txns.filter((t) => !isIncome(t) && within(t.transaction_date, windowStart, windowEnd));

    const byRoot = new Map();
    for (const t of scoped) {
      const root = rootOf(t);
      const key = root?.id || '__none__';
      if (!byRoot.has(key)) {
        byRoot.set(key, { name: root?.name || 'Uncategorised', colour: root?.color_hex, total: 0, months: new Map() });
      }
      const entry = byRoot.get(key);
      const amount = parseNum(t.amount);
      entry.total += amount;
      const mk = monthKey(new Date(t.transaction_date));
      entry.months.set(mk, (entry.months.get(mk) || 0) + amount);
    }

    const series = [...byRoot.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, TREND_SERIES)
      .map((entry) => ({
        name: entry.name,
        colour: normaliseHex(entry.colour) || '#7a8794',
        values: months.map((m) => entry.months.get(monthKey(m)) || 0),
      }));

    const totals = months.map((m) => scoped
      .filter((t) => monthKey(new Date(t.transaction_date)) === monthKey(m))
      .reduce((s, t) => s + parseNum(t.amount), 0));

    return { labels: months.map(shortMonth), series, totals };
  }

  paint();
}

// ---------- pieces ----------

function statCard(label, value, sub, colour) {
  return el('div', { class: 'card' }, [
    el('div', { class: 'stat-value', style: colour ? `color:${colour}` : '', text: value }),
    el('div', { class: 'stat-label', text: label }),
    sub ? el('div', { class: 'stat-sub', text: sub }) : null,
  ]);
}

/** Flutter's RankedBars: name, amount, and a proportional bar. */
function rankedBars(items) {
  if (!items.length) return emptyState('—', 'No data for this period.');
  const peak = items[0].total || 1;
  return el('div', { class: 'ranked' }, items.slice(0, 6).map((it) => el('div', {
    class: 'ranked-row',
  }, [
    el('div', { class: 'ranked-head' }, [
      el('span', { class: 'ranked-name', text: it.name }),
      el('span', { class: 'ranked-value', text: fmtMoney(it.total) }),
    ]),
    el('div', { class: 'ranked-track' }, [
      el('div', {
        class: 'ranked-fill',
        style: `width:${Math.max(2, (it.total / peak) * 100)}%;background:${it.colour || 'var(--accent)'}`,
      }),
    ]),
  ])));
}

function largestList(txns, catById) {
  const top = [...txns].sort((a, b) => parseNum(b.amount) - parseNum(a.amount)).slice(0, 6);
  if (!top.length) return emptyState('—', 'No transactions in this period.');
  return el('div', {}, top.map((t) => {
    const cat = catById.get(t.category_id);
    return el('div', { class: 'mini-row' }, [
      cat ? el('span', {
        class: 'cat-badge',
        style: `width:26px;height:26px;`
          + `background:color-mix(in srgb, ${normaliseHex(cat.color_hex) || '#7a8794'} 18%, transparent);`
          + `color:${normaliseHex(cat.color_hex) || '#7a8794'}`,
      }, [iconEl(cat.icon_key, { size: 15 })]) : null,
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { class: 'mini-title', text: t.notes || cat?.name || 'Transaction' }),
        el('div', { class: 'mini-sub', text: `${cat?.name || '—'} · ${fmtDate(t.transaction_date)}` }),
      ]),
      el('span', { class: 'mini-amount', text: fmtMoney(t.amount) }),
    ]);
  }));
}

function dueRow(r) {
  const overdue = r.days < 0;
  return el('div', { class: 'mini-row' }, [
    el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { class: 'mini-title', text: r.title || '(untitled)' }),
      el('div', { class: 'mini-sub', text: `${r.type || 'Record'} · ${fmtDate(r.due_date)}` }),
    ]),
    parseNum(r.cost) ? el('span', { class: 'mini-sub', text: fmtMoney(r.cost) }) : null,
    el('span', {
      class: `chip ${overdue ? 'chip-danger' : r.days <= 7 ? 'chip-warn' : ''}`,
      text: overdue ? `${Math.abs(r.days)}d overdue` : r.days === 0 ? 'today' : `${r.days}d`,
    }),
  ]);
}

/** One shortage from stock.js — an item, or a whole stock group. */
function stockRow(s) {
  return el('div', { class: 'mini-row' }, [
    el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { class: 'mini-title', text: s.name }),
      el('div', { class: 'mini-sub', text: s.detail || '' }),
    ]),
    el('span', {
      class: 'chip chip-danger',
      text: `${s.stock} / ${s.threshold}`,
    }),
  ]);
}

// ---------- aggregation ----------

function rankRootCategories(txns, catById, isIncome) {
  const totals = new Map();
  for (const t of txns) {
    if (isIncome(t)) continue;
    let cat = catById.get(t.category_id);
    let guard = 0;
    while (cat?.parent_id && catById.has(cat.parent_id) && guard++ < 5) {
      cat = catById.get(cat.parent_id);
    }
    const key = cat?.id || '__none__';
    if (!totals.has(key)) {
      totals.set(key, { name: cat?.name || 'Uncategorised', colour: normaliseHex(cat?.color_hex), total: 0 });
    }
    totals.get(key).total += parseNum(t.amount);
  }
  return [...totals.values()].sort((a, b) => b.total - a.total);
}

function rankLabels(txns, isIncome) {
  const totals = new Map();
  for (const t of txns) {
    if (isIncome(t)) continue;
    const labels = String(t.labels || '').split('|').map((s) => s.trim()).filter(Boolean);
    for (const name of labels) {
      totals.set(name, (totals.get(name) || 0) + parseNum(t.amount));
    }
  }
  return [...totals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
}

// ---------- charts ----------

function chartColours() {
  const cs = getComputedStyle(document.body);
  return {
    text: cs.getPropertyValue('--text-dim').trim() || '#888',
    grid: 'rgba(128,128,128,.15)',
  };
}

function drawTrend(canvas, { labels, series, totals }) {
  const { text, grid } = chartColours();
  new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        // The overall line sits behind as a dashed reference so individual
        // categories can be read against the month's total.
        {
          label: 'Total',
          data: totals,
          borderColor: text,
          borderDash: [5, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
        ...series.map((s) => ({
          label: s.name,
          data: s.values,
          borderColor: s.colour,
          backgroundColor: s.colour,
          borderWidth: 2.5,
          pointRadius: 3,
          pointHoverRadius: 5,
          tension: 0.3,
          fill: false,
        })),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: text, boxWidth: 12, usePointStyle: true, padding: 16 },
        },
        tooltip: {
          callbacks: { label: (c) => `${c.dataset.label}: ${fmtMoney(c.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: text } },
        y: {
          beginAtZero: true,
          grid: { color: grid },
          ticks: { color: text, callback: (v) => fmtMoney(v).replace(/\.00$/, '') },
        },
      },
    },
  });
}

function drawBreakdown(canvas, items) {
  const { text } = chartColours();
  const top = items.slice(0, 8);
  new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: top.map((i) => i.name),
      datasets: [{
        data: top.map((i) => i.total),
        backgroundColor: top.map((i) => i.colour || '#7a8794'),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '58%',
      plugins: {
        legend: { position: 'right', labels: { color: text, boxWidth: 12, padding: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtMoney(c.parsed)}` } },
      },
    },
  });
}

// ---------- dates ----------

const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const sameMonth = (a, b) => monthKey(a) === monthKey(b);
const monthLabel = (d) => d.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
const shortMonth = (d) => d.toLocaleDateString('en-MY', { month: 'short' });

function within(value, start, end) {
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d >= start && d <= end;
}

function sum(txns) {
  return txns.reduce((s, t) => s + parseNum(t.amount), 0);
}

/** Days of the anchor month that have actually happened, for a fair average. */
function daysElapsed(anchor) {
  const now = new Date();
  if (sameMonth(anchor, now)) return Math.max(1, now.getDate());
  return new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
}

function normaliseHex(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const hex = s.startsWith('#') ? s.slice(1) : s;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : '';
}
