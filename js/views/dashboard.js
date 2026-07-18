// Overview: this month's spend, budget health, low stock and what's due soon.
// Read-only — every figure is derived from what repo.js already has cached.

import * as repo from '../repo.js';
import { parseNum } from '../schema.js';
import { el, fmtMoney, fmtDate, daysUntil, emptyState } from '../ui.js';

export function renderDashboard(container) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const txns = repo.rows('Transactions');
  const categories = repo.rows('Categories');
  const inventory = repo.rows('Inventory');
  const records = repo.rows('Records_Reminders');
  const budgets = repo.rows('Budgets');

  const catById = new Map(categories.map((c) => [c.id, c]));
  const isIncome = (t) => catById.get(t.category_id)?.type === 'income';

  const thisMonth = txns.filter((t) => {
    const d = new Date(t.transaction_date);
    return !Number.isNaN(d.getTime()) && d >= monthStart;
  });

  const spent = thisMonth.filter((t) => !isIncome(t)).reduce((s, t) => s + parseNum(t.amount), 0);
  const earned = thisMonth.filter(isIncome).reduce((s, t) => s + parseNum(t.amount), 0);
  const budgetTotal = budgets.reduce((s, b) => s + parseNum(b.monthly_limit), 0);
  const lowStock = inventory.filter(
    (i) => parseNum(i.min_threshold) > 0 && parseNum(i.current_stock) <= parseNum(i.min_threshold),
  );
  const dueSoon = records
    .map((r) => ({ ...r, days: daysUntil(r.due_date) }))
    .filter((r) => r.days !== null && r.days <= 30)
    .sort((a, b) => a.days - b.days);

  // ---------- stat tiles ----------
  container.append(
    el('div', { class: 'grid grid-stats', style: 'margin-bottom:16px' }, [
      statCard('Spent this month', fmtMoney(spent), `${thisMonth.length} transactions`),
      statCard('Income this month', fmtMoney(earned)),
      statCard(
        'Budget',
        budgetTotal ? fmtMoney(budgetTotal) : '—',
        budgetTotal
          ? `${Math.round((spent / budgetTotal) * 100)}% used · ${fmtMoney(Math.max(0, budgetTotal - spent))} left`
          : 'No budgets set',
        budgetTotal && spent > budgetTotal ? 'var(--danger)' : null,
      ),
      statCard(
        'Needs attention',
        String(lowStock.length + dueSoon.filter((r) => r.days <= 7).length),
        `${lowStock.length} low stock · ${dueSoon.filter((r) => r.days <= 7).length} due this week`,
      ),
    ]),
  );

  // ---------- charts ----------
  const byCategory = new Map();
  for (const t of thisMonth) {
    if (isIncome(t)) continue;
    const name = catById.get(t.category_id)?.name || 'Uncategorised';
    byCategory.set(name, (byCategory.get(name) || 0) + parseNum(t.amount));
  }
  const topCats = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const pieCanvas = el('canvas');
  const barCanvas = el('canvas');

  container.append(
    el('div', { class: 'grid grid-2', style: 'margin-bottom:16px' }, [
      el('div', { class: 'card' }, [
        el('h2', { class: 'card-title', text: 'Spend by category — this month' }),
        topCats.length
          ? el('div', { class: 'chart-wrap' }, [pieCanvas])
          : emptyState('📊', 'No spending recorded this month.'),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { class: 'card-title', text: 'Last 6 months' }),
        el('div', { class: 'chart-wrap' }, [barCanvas]),
      ]),
    ]),
  );

  // ---------- lists ----------
  container.append(
    el('div', { class: 'grid grid-2' }, [
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
    ]),
  );

  // Charts are drawn after the nodes are in the document so Chart.js can
  // measure their container.
  requestAnimationFrame(() => {
    if (!window.Chart) return;
    if (topCats.length) drawPie(pieCanvas, topCats);
    drawBars(barCanvas, txns, isIncome);
  });
}

function statCard(label, value, sub, colour) {
  return el('div', { class: 'card' }, [
    el('div', { class: 'stat-value', style: colour ? `color:${colour}` : '' , text: value }),
    el('div', { class: 'stat-label', text: label }),
    sub ? el('div', { class: 'stat-sub', text: sub }) : null,
  ]);
}

function dueRow(r) {
  const overdue = r.days < 0;
  const soon = r.days <= 7;
  return el('div', {
    style: 'display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)',
  }, [
    el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { style: 'font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: r.title || '(untitled)' }),
      el('div', { style: 'font-size:12px;color:var(--text-dim)', text: `${r.type || 'Record'} · ${fmtDate(r.due_date)}` }),
    ]),
    parseNum(r.cost) ? el('span', { style: 'font-size:13px;color:var(--text-dim)', text: fmtMoney(r.cost) }) : null,
    el('span', {
      class: `chip ${overdue ? 'chip-danger' : soon ? 'chip-warn' : ''}`,
      text: overdue ? `${Math.abs(r.days)}d overdue` : r.days === 0 ? 'today' : `${r.days}d`,
    }),
  ]);
}

function stockRow(i) {
  return el('div', {
    style: 'display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)',
  }, [
    el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { style: 'font-weight:550', text: i.item_name || '(unnamed)' }),
      el('div', { style: 'font-size:12px;color:var(--text-dim)', text: i.variant_size || i.category || '' }),
    ]),
    el('span', {
      class: 'chip chip-danger',
      text: `${parseNum(i.current_stock)} / ${parseNum(i.min_threshold)} ${i.unit || ''}`.trim(),
    }),
  ]);
}

// ---------- Chart.js ----------

const PALETTE = [
  '#2e7d5b', '#3f8ecc', '#c9803d', '#8a5fbf', '#c9556f',
  '#4aa89a', '#b5893b', '#6b7f9e',
];

function chartTextColour() {
  return getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';
}

function drawPie(canvas, entries) {
  new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: entries.map(([name]) => name),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: PALETTE,
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '58%',
      plugins: {
        legend: { position: 'right', labels: { color: chartTextColour(), boxWidth: 12, padding: 12 } },
        tooltip: {
          callbacks: { label: (c) => `${c.label}: ${fmtMoney(c.parsed)}` },
        },
      },
    },
  });
}

function drawBars(canvas, txns, isIncome) {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-MY', { month: 'short' }),
      total: 0,
    });
  }
  const index = new Map(months.map((m) => [m.key, m]));

  for (const t of txns) {
    if (isIncome(t)) continue;
    const d = new Date(t.transaction_date);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const bucket = index.get(key);
    if (bucket) bucket.total += parseNum(t.amount);
  }

  const colour = chartTextColour();
  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: months.map((m) => m.label),
      datasets: [{
        data: months.map((m) => m.total),
        backgroundColor: '#2e7d5b',
        borderRadius: 5,
        maxBarThickness: 46,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => fmtMoney(c.parsed.y) } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: colour } },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(128,128,128,.15)' },
          ticks: { color: colour, callback: (v) => fmtMoney(v).replace(/\.00$/, '') },
        },
      },
    },
  });
}
