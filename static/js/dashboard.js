/**
 * dashboard.js
 * ============
 * Dashboard page for PharmAssist V2.
 *
 * Renders eight sections in a single coordinated page:
 *   1. KPI grid         Eight pastel metric cards in one row
 *   2. Revenue chart    Line chart with period toggle (Week / Month / All Time)
 *   3. Stock chart      Horizontal bar chart of top drugs by stock level
 *   4. Active alerts    Inline action buttons per alert type
 *   5. Restock list     Velocity-based suggestions with Order Now shortcuts
 *   6. Needs attention  Table of drugs below threshold or near expiry
 *   7. Quick actions    Navigation shortcuts to common workflows
 *   8. Auto-refresh     Background KPI refresh every 60 seconds
 *
 * All three data sources (dashboard, drugs, analytics) are fetched in
 * parallel via Promise.all to minimise load time.
 *
 * Dependencies: app.js (apiFetch, loadingHTML, emptyHTML, fmtCurrency,
 *               fmtDate, daysUntil, stockBadge, expiryBadge, icon,
 *               renderIcons, navigateTo), Chart.js (global via CDN),
 *               inventory.js (openRestockModal, confirmWriteoff,
 *               openAddDrugModal — called after navigating to inventory).
 */

'use strict';


// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {Chart|null} Active Chart.js instance for the revenue line chart. */
let _revenueChart = null;

/** @type {Chart|null} Active Chart.js instance for the stock bar chart. */
let _stockChart = null;

/** @type {number|null} setInterval handle for the auto-refresh timer. */
let _refreshTimer = null;

/**
 * The currently selected revenue chart period.
 * @type {'week'|'month'|'all'}
 */
let _revPeriod = 'week';

/** @type {Date|null} Timestamp of the last successful data fetch. */
let _lastRefreshed = null;

/**
 * Analytics data stored between renders so the revenue chart can be
 * re-filtered when the period toggle changes without a new API call.
 * @type {object|null}
 */
let _analyticsData = null;

/**
 * Bar fill and border colors for the stock chart.
 * Each index corresponds to one drug. Up to 8 drugs are shown.
 */
const _STOCK_COLORS = {
  fill:   ['#DBEAFE', '#D1FAE5', '#FEF3C7', '#EDE9FE', '#FCE7F3', '#FFEDD5', '#CCFBF1', '#FEE2E2'],
  border: ['#1E40AF', '#065F46', '#92400E', '#5B21B6', '#9D174D', '#9A3412', '#134E4A', '#991B1B'],
};

/** Number of days per period label used in filterByPeriod(). */
const _PERIOD_DAYS = { week: 7, month: 30 };


// ---------------------------------------------------------------------------
// Page entry point
// ---------------------------------------------------------------------------

/**
 * Render the Dashboard page.
 *
 * Fetches all three data sources in parallel, builds the page HTML,
 * renders both charts, starts the auto-refresh timer, and initialises
 * Lucide icons. Called by the router in app.js when navigating to #dashboard.
 */
async function renderDashboard() {
  const container = document.getElementById('page-dashboard');
  container.innerHTML = loadingHTML('Loading dashboard…');

  try {
    const [dashboardData, drugs, analytics] = await Promise.all([
      apiFetch('/api/dashboard'),
      apiFetch('/api/drugs'),
      apiFetch('/api/analytics'),
    ]);

    App.cache.dashboard = dashboardData;
    App.cache.drugs     = drugs;
    _analyticsData      = analytics;
    _lastRefreshed      = new Date();

    updateAlertBadge(dashboardData.alerts);
    container.innerHTML = buildPageHTML(dashboardData, drugs);

    renderDashRevenueChart(analytics.by_date, _revPeriod);
    renderDashStockChart(drugs);
    startAutoRefresh();
    setTimeout(renderIcons, 100);

  } catch (err) {
    container.innerHTML = `
      <div class="alert alert-danger">
        Failed to load dashboard: ${err.message}
        <button class="btn btn-sm btn-ghost mt-8" onclick="renderDashboard()">
          Retry
        </button>
      </div>`;
  }
}


// ---------------------------------------------------------------------------
// Page HTML builder
// ---------------------------------------------------------------------------

/**
 * Build the full dashboard page HTML string.
 *
 * @param {object} data   Response from GET /api/dashboard.
 * @param {Array}  drugs  Response from GET /api/drugs.
 * @returns {string}
 */
function buildPageHTML(data, drugs) {
  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });

  return `
    <div class="page-header">
      <div>
        <div class="page-title">Dashboard</div>
        <div class="page-subtitle">Live inventory overview · ${todayLabel}</div>
      </div>
      <div class="flex-center gap-8">
        <span id="dash-last-refresh" style="font-size: 12px; color: var(--text-muted)">
          Refreshed ${_formatTime(_lastRefreshed)}
        </span>
        <button class="btn btn-secondary btn-sm" onclick="renderDashboard()">
          <i data-lucide="refresh-cw" style="width: 14px; height: 14px"></i>
          Refresh
        </button>
        <button class="btn btn-primary" onclick="navigateTo('prescriptions')">
          <i data-lucide="scan-line" style="width: 14px; height: 14px"></i>
          New Prescription
        </button>
      </div>
    </div>

    ${buildKPIGrid(data.kpis)}

    <div class="section-row cols-2" style="margin-bottom: 24px">
      <div class="card">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px">
          <div class="card-title" style="margin: 0; display: flex; align-items: center; gap: 8px">
            <i data-lucide="trending-up" style="width: 15px; height: 15px; color: var(--blue-mid)"></i>
            Revenue Over Time
          </div>
          <div class="flex-center gap-8">
            ${buildPeriodToggle()}
          </div>
        </div>
        <div class="chart-box"><canvas id="dash-revenue-chart"></canvas></div>
      </div>

      <div class="card">
        <div class="card-title" style="display: flex; align-items: center; gap: 8px">
          <i data-lucide="package" style="width: 15px; height: 15px; color: var(--blue-mid)"></i>
          Stock by Drug
        </div>
        <div class="chart-box"><canvas id="dash-stock-chart"></canvas></div>
      </div>
    </div>

    <div class="section-row cols-2">
      <div class="card">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px">
          <div class="card-title" style="margin: 0; display: flex; align-items: center; gap: 8px">
            <i data-lucide="shield-alert" style="width: 15px; height: 15px; color: var(--red)"></i>
            Needs Attention
          </div>
          <button class="btn btn-sm btn-ghost" onclick="navigateTo('inventory')">
            View all <i data-lucide="arrow-right" style="width: 13px; height: 13px"></i>
          </button>
        </div>
        ${buildNeedsAttention(drugs, data.alerts)}
      </div>

      <div style="display: flex; flex-direction: column; gap: 24px">
        <div class="card">
          <div class="card-title" style="display: flex; align-items: center; gap: 8px">
            <i data-lucide="refresh-cw" style="width: 15px; height: 15px; color: var(--blue-mid)"></i>
            Restock Suggestions
          </div>
          ${buildRestockSuggestions(data.restock)}
        </div>
        <div class="card">
          <div class="card-title" style="display: flex; align-items: center; gap: 8px">
            <i data-lucide="zap" style="width: 15px; height: 15px; color: var(--yellow)"></i>
            Quick Actions
          </div>
          ${buildQuickActions()}
        </div>
      </div>
    </div>`;
}

/**
 * Build the period toggle buttons for the revenue chart.
 * The active period button uses btn-primary; others use btn-ghost.
 *
 * @returns {string} HTML string.
 */
function buildPeriodToggle() {
  const periods = [
    { key: 'week',  label: 'Week'     },
    { key: 'month', label: 'Month'    },
    { key: 'all',   label: 'All Time' },
  ];
  return periods.map(({ key, label }) => `
    <button
      id="rev-btn-${key}"
      class="btn btn-sm ${_revPeriod === key ? 'btn-primary' : 'btn-ghost'}"
      style="padding: 4px 10px; font-size: 11.5px"
      onclick="switchRevPeriod('${key}')"
    >
      ${label}
    </button>`).join('');
}


// ---------------------------------------------------------------------------
// Alert badge
// ---------------------------------------------------------------------------

/**
 * Update the alert pill button in the navigation bar.
 *
 * Shows the most urgent alert type as the label text (expired takes
 * priority over out-of-stock, which takes priority over low-stock,
 * which takes priority over expiring). The full breakdown is set as
 * a tooltip via the title attribute.
 *
 * Hides the badge entirely when there are no alerts.
 *
 * @param {Array} alerts  Alert objects from GET /api/dashboard.
 */
function updateAlertBadge(alerts) {
  const badge      = document.getElementById('alert-badge');
  const countEl    = document.getElementById('alert-badge-count');
  const labelEl    = document.getElementById('alert-badge-label');
  if (!badge) return;

  if (!alerts || alerts.length === 0) {
    badge.style.display = 'none';
    return;
  }

  const counts = {
    expired:     alerts.filter(a => a.type === 'expired').length,
    out_of_stock: alerts.filter(a => a.type === 'out_of_stock').length,
    low_stock:   alerts.filter(a => a.type === 'low_stock').length,
    expiring:    alerts.filter(a => a.type === 'expiring').length,
  };

  // Build tooltip text from all non-zero categories
  const parts = [];
  if (counts.expired)     parts.push(`${counts.expired} expired`);
  if (counts.out_of_stock) parts.push(`${counts.out_of_stock} out of stock`);
  if (counts.low_stock)   parts.push(`${counts.low_stock} low stock`);
  if (counts.expiring)    parts.push(`${counts.expiring} expiring`);

  badge.style.display = 'inline-flex';
  badge.setAttribute('title', parts.join(' · '));
  if (countEl) countEl.textContent = alerts.length;

  // Set label to most urgent category
  if (labelEl) {
    if (counts.expired)      labelEl.textContent = `${counts.expired} expired`;
    else if (counts.out_of_stock) labelEl.textContent = `${counts.out_of_stock} out of stock`;
    else if (counts.low_stock)    labelEl.textContent = `${counts.low_stock} low stock`;
    else if (counts.expiring)     labelEl.textContent = `${counts.expiring} expiring`;
  }
}


// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Build the eight-card KPI grid.
 *
 * Colors are conditional for alert-sensitive metrics: low stock,
 * out-of-stock, and expiring use green when the count is zero and
 * amber/red/orange when non-zero.
 *
 * @param {object} kpis  KPI data from GET /api/dashboard.
 * @returns {string} HTML string.
 */
function buildKPIGrid(kpis) {
  const fillColor  = kpis.fill_rate >= 90 ? 'kpi-green' : kpis.fill_rate >= 70 ? 'kpi-amber' : 'kpi-red';
  const fillSub    = kpis.fill_rate >= 90 ? 'Above target (≥90%)' : kpis.fill_rate >= 70 ? 'Below target' : 'Critical — investigate';
  const pendColor  = kpis.pending_prescriptions > 0 ? 'kpi-amber' : 'kpi-green';
  const pendSub    = kpis.pending_prescriptions > 0 ? 'Incomplete — needs action' : 'All clear';

  const todayCards = [
    { label: "Today's Revenue",       value: fmtCurrency(kpis.today_revenue),   sub: `${fmtCurrency(kpis.total_revenue)} all-time`,  lucide: 'dollar-sign',    color: 'kpi-green'  },
    { label: "Today's Prescriptions", value: kpis.today_prescriptions,          sub: `${kpis.total_transactions} total transactions`, lucide: 'clipboard-list', color: 'kpi-blue'   },
    { label: 'Pending',               value: kpis.pending_prescriptions,        sub: pendSub,                                         lucide: 'clock',          color: pendColor    },
    { label: 'Fill Rate',             value: (kpis.fill_rate ?? 0) + '%',       sub: fillSub,                                         lucide: 'activity',       color: fillColor    },
  ];

  const invCards = [
    { label: 'Out of Stock',      value: kpis.out_of_stock_count,                      sub: kpis.out_of_stock_count > 0 ? 'Patients turned away'        : 'Fully stocked',     lucide: 'x-circle',       color: kpis.out_of_stock_count > 0 ? 'kpi-red'    : 'kpi-green'  },
    { label: 'Low Stock',         value: kpis.low_stock_count,                         sub: kpis.low_stock_count    > 0 ? 'Below alert threshold'       : 'All healthy',       lucide: 'alert-triangle', color: kpis.low_stock_count    > 0 ? 'kpi-amber' : 'kpi-green'  },
    { label: 'Expiring ≤30 Days', value: kpis.expiring_30d ?? kpis.expiring_soon,      sub: (kpis.expiring_30d ?? kpis.expiring_soon) > 0 ? 'Urgent — restock or discount' : 'No urgent expiry', lucide: 'calendar-clock', color: (kpis.expiring_30d ?? kpis.expiring_soon) > 0 ? 'kpi-orange' : 'kpi-green' },
    { label: 'Expired Stock',     value: kpis.expired_count,                           sub: kpis.expired_count      > 0 ? 'Write-off required'          : 'No expired stock',  lucide: 'trash-2',        color: kpis.expired_count      > 0 ? 'kpi-red'    : 'kpi-green'  },
  ];

  const card = c => `
    <div class="kpi-card ${c.color}">
      <div class="kpi-icon"><i data-lucide="${c.lucide}" style="width:20px;height:20px"></i></div>
      <div class="kpi-value" style="font-size:22px">${c.value}</div>
      <div class="kpi-label">${c.label}</div>
      <div style="font-size:10.5px;opacity:0.7;margin-top:3px;line-height:1.3">${c.sub}</div>
    </div>`;

  return `
    <div id="kpi-section">
    <div style="margin-bottom:10px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;
                  color:var(--text-muted);margin-bottom:8px;padding-left:2px">Today's Operations</div>
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
        ${todayCards.map(card).join('')}
      </div>
    </div>
    <div style="margin-bottom:24px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;
                  color:var(--text-muted);margin-bottom:8px;padding-left:2px">Inventory Health</div>
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">
        ${invCards.map(card).join('')}
      </div>
    </div>
    </div>`;
}


function buildRestockSuggestions(restock) {
  if (!restock || restock.length === 0) {
    return emptyHTML('', 'No restock needed', 'Stock levels are healthy based on recent sales.');
  }

  return restock.map(item => `
    <div class="restock-item">
      <div style="flex: 1">
        <div class="restock-name">${item.name}</div>
        <div class="restock-detail">
          ${item.brand} · ${item.quantity} units · ${item.daily_velocity}/day
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px">
          Suggested order: <strong>${item.suggested_reorder} units</strong>
        </div>
      </div>
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px">
        <div>
          <div class="restock-days">${item.days_remaining}</div>
          <div class="restock-days-label">days left</div>
        </div>
        <button
          class="btn btn-sm btn-secondary"
          style="font-size: 11px; padding: 3px 10px"
          onclick="navigateTo('inventory'); setTimeout(() => openRestockModal(${item.id}, '${item.name}', ${item.quantity}), 300)"
        >
          Order Now
        </button>
      </div>
    </div>`).join('');
}

/**
 * Merged Needs Attention — replaces old Active Alerts + Needs Attention.
 * Rows sorted by severity. Context-aware action buttons per row.
 */
function buildNeedsAttention(drugs, alerts) {
  const alertMap = {};
  (alerts || []).forEach(a => { alertMap[a.drug_id] = a; });

  const flagged = drugs.filter(drug => {
    const days = daysUntil(drug.expiry_date);
    return (
      drug.quantity === 0 ||
      drug.quantity <= drug.low_stock_threshold ||
      (days !== null && days < 0) ||
      (days !== null && days >= 0 && days <= 90)
    );
  });

  if (flagged.length === 0) {
    return emptyHTML('', 'All drugs healthy', 'No stock or expiry issues detected.');
  }

  const sev = drug => {
    const days = daysUntil(drug.expiry_date);
    if (days !== null && days < 0)                 return 0;
    if (drug.quantity === 0)                       return 1;
    if (drug.quantity <= drug.low_stock_threshold) return 2;
    if (days !== null && days <= 30)               return 3;
    return 4;
  };

  flagged.sort((a, b) => sev(a) - sev(b));

  const rows = flagged.map(drug => {
    const s     = sev(drug);
    const alert = alertMap[drug.id];
    const name  = drug.name.replace(/'/g, "\'");

    const rowClass = s <= 1 ? 'row-not-found' : s === 2 ? 'row-insufficient' : 'row-sufficient';

    const sevBadge =
      s === 0 ? '<span class="badge badge-danger">Expired</span>' :
      s === 1 ? '<span class="badge badge-danger">Out of Stock</span>' :
      s === 2 ? '<span class="badge badge-warning">Low Stock</span>' :
      s === 3 ? '<span class="badge badge-warning">Expiring Soon</span>' :
                '<span class="badge badge-neutral">Expiring</span>';

    const actionBtn =
      s === 0
        ? `<button class="btn btn-sm btn-danger" style="font-size:11px;padding:3px 8px;white-space:nowrap"
             onclick="navigateTo('inventory'); setTimeout(confirmWriteoff, 300)">
             <i data-lucide="trash-2" style="width:11px;height:11px"></i> Write Off
           </button>`
        : s >= 3
          ? `<button class="btn btn-sm btn-ghost" style="font-size:11px;padding:3px 8px;white-space:nowrap"
               onclick="navigateTo('inventory'); setTimeout(() => openRestockModal(${drug.id}, '${name}', ${drug.quantity}), 300)">
               <i data-lucide="plus" style="width:11px;height:11px"></i> New Batch
             </button>`
          : `<button class="btn btn-sm btn-secondary" style="font-size:11px;padding:3px 8px;white-space:nowrap"
               onclick="navigateTo('inventory'); setTimeout(() => openRestockModal(${drug.id}, '${name}', ${drug.quantity}), 300)">
               <i data-lucide="plus-circle" style="width:11px;height:11px"></i> Restock
             </button>`;

    const message = alert?.message
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${alert.message}</div>`
      : '';

    return `
      <tr class="${rowClass}">
        <td>
          <strong>${drug.name}</strong><br>
          <span class="text-muted text-sm">${drug.brand}</span>
          ${message}
        </td>
        <td>${sevBadge}</td>
        <td>${stockBadge(drug.quantity, drug.low_stock_threshold)}</td>
        <td>${expiryBadge(drug.expiry_date)}</td>
        <td style="text-align:right">${actionBtn}</td>
      </tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Drug</th><th>Issue</th><th>Stock</th><th>Expires</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}


/**
 * Build the Quick Actions button group.
 *
 * Provides one-click access to the four most common pharmacist workflows.
 *
 * @returns {string} HTML string.
 */
function buildQuickActions() {
  const actions = [
    { label: 'Scan Prescription',    lucide: 'scan-line',     cls: 'btn-primary',   onclick: "navigateTo('prescriptions')" },
    { label: 'Add New Drug',         lucide: 'plus-circle',   cls: 'btn-secondary', onclick: "navigateTo('inventory'); setTimeout(openAddDrugModal, 200)" },
    { label: 'View Analytics',       lucide: 'bar-chart-2',   cls: 'btn-ghost',     onclick: "navigateTo('analytics')" },
    { label: 'Prescription History', lucide: 'clipboard-list', cls: 'btn-ghost',    onclick: "navigateTo('history')" },
  ];

  return `
    <div style="display: flex; flex-direction: column; gap: 10px">
      ${actions.map(a => `
        <button class="btn ${a.cls} btn-full" onclick="${a.onclick}">
          <i data-lucide="${a.lucide}" style="width: 15px; height: 15px"></i>
          ${a.label}
        </button>`).join('')}
    </div>`;
}


// ---------------------------------------------------------------------------
// Revenue chart period toggle
// ---------------------------------------------------------------------------

/**
 * Switch the revenue chart to a different time period.
 *
 * Updates the active button style and re-renders the chart using the
 * already-fetched analytics data — no new API call is made.
 *
 * @param {'week'|'month'|'all'} period
 */
function switchRevPeriod(period) {
  _revPeriod = period;

  ['week', 'month', 'all'].forEach(key => {
    const button = document.getElementById(`rev-btn-${key}`);
    if (!button) return;
    button.className = `btn btn-sm ${key === period ? 'btn-primary' : 'btn-ghost'}`;
    button.style.cssText = 'padding: 4px 10px; font-size: 11.5px';
  });

  if (_analyticsData) {
    renderDashRevenueChart(_analyticsData.by_date, period);
  }
}

/**
 * Filter daily revenue data to the selected period.
 *
 * 'week' and 'month' return only records from the last 7 or 30 days
 * respectively. 'all' returns the full dataset unchanged.
 *
 * @param {Array}  byDate  Array of { date, revenue } ordered ascending.
 * @param {string} period  'week' | 'month' | 'all'
 * @returns {Array}
 */
function filterByPeriod(byDate, period) {
  if (!byDate || byDate.length === 0) return [];
  if (period === 'all') return byDate;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - _PERIOD_DAYS[period]);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return byDate.filter(d => d.date >= cutoffStr);
}


// ---------------------------------------------------------------------------
// Chart renderers
// ---------------------------------------------------------------------------

/**
 * Render the revenue-over-time line chart.
 *
 * Replaces the canvas's parent element with an empty state when there
 * is no data for the selected period. Destroys any existing Chart.js
 * instance before creating a new one.
 *
 * @param {Array}  byDate  Full daily revenue dataset.
 * @param {string} period  The period to filter to before charting.
 */
function renderDashRevenueChart(byDate, period) {
  const canvas = document.getElementById('dash-revenue-chart');
  if (!canvas) return;

  if (_revenueChart) {
    _revenueChart.destroy();
    _revenueChart = null;
  }

  const filtered = filterByPeriod(byDate, period);

  if (!filtered || filtered.length === 0) {
    canvas.parentElement.innerHTML = emptyHTML(
      '', 'No sales yet', 'Revenue will appear after the first sale.'
    );
    return;
  }

  _revenueChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels:   filtered.map(d => fmtDate(d.date)),
      datasets: [{
        label:               'Revenue',
        data:                filtered.map(d => d.revenue),
        borderColor:         '#1976D2',
        backgroundColor:     'rgba(25, 118, 210, 0.10)',
        borderWidth:         2.5,
        pointRadius:         5,
        pointBackgroundColor: '#1976D2',
        fill:                true,
        tension:             0.35,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#EEF2F7' }, ticks: { font: { size: 11 } } },
        y: {
          grid:  { color: '#EEF2F7' },
          ticks: { font: { size: 11 }, callback: value => '$' + value },
        },
      },
    },
  });
}

/**
 * Render the horizontal stock-by-drug bar chart.
 *
 * Shows the top 8 drugs by total stock, sorted descending. Uses a
 * horizontal bar (indexAxis: 'y') so drug names are readable without
 * rotation even when many drugs are shown.
 *
 * @param {Array} drugs  Full drug list from GET /api/drugs.
 */
function renderDashStockChart(drugs) {
  const canvas = document.getElementById('dash-stock-chart');
  if (!canvas) return;

  if (_stockChart) {
    _stockChart.destroy();
    _stockChart = null;
  }

  const top = [...drugs]
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 8);

  _stockChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels:   top.map(d => d.name),
      datasets: [{
        label:           'Stock Units',
        data:            top.map(d => d.quantity),
        backgroundColor: _STOCK_COLORS.fill,
        borderColor:     _STOCK_COLORS.border,
        borderWidth:     1.5,
        borderRadius:    4,
        borderSkipped:   false,
      }],
    },
    options: {
      indexAxis:           'y',
      responsive:          true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#EEF2F7' }, ticks: { font: { size: 11 } } },
        y: { grid: { display: false   }, ticks: { font: { size: 11 } } },
      },
    },
  });
}


// ---------------------------------------------------------------------------
// Auto-refresh
// ---------------------------------------------------------------------------

/**
 * Start a background timer that silently refreshes KPI data every 60 seconds.
 *
 * Only runs when the dashboard page is active — if the user has navigated
 * away the fetch still runs but the DOM updates are skipped (the element
 * IDs will not be present).
 *
 * Clears any existing timer before starting a new one so calling
 * renderDashboard() multiple times does not stack timers.
 */
function startAutoRefresh() {
  if (_refreshTimer) clearInterval(_refreshTimer);

  _refreshTimer = setInterval(async () => {
    if (App.currentPage !== 'dashboard') return;

    try {
      const [dashboardData, drugs, analytics] = await Promise.all([
        apiFetch('/api/dashboard'),
        apiFetch('/api/drugs'),
        apiFetch('/api/analytics'),
      ]);

      App.cache.dashboard = dashboardData;
      App.cache.drugs     = drugs;
      _analyticsData      = analytics;
      _lastRefreshed      = new Date();

      updateAlertBadge(dashboardData.alerts);

      const timestampEl = document.getElementById('dash-last-refresh');
      if (timestampEl) {
        timestampEl.textContent = `Refreshed ${_formatTime(_lastRefreshed)}`;
      }

      const kpiSection = document.getElementById('kpi-section');
      if (kpiSection) kpiSection.outerHTML = buildKPIGrid(dashboardData.kpis);

    } catch {
      // Silent failure — the user will see stale data until the next tick
    }
  }, 60_000);
}


// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date object as a localised time string (HH:MM:SS).
 *
 * @param {Date|null} date
 * @returns {string}  e.g. "07:23:14 PM" or empty string for null.
 */
function _formatTime(date) {
  if (!date) return '';
  return date.toLocaleTimeString('en-US', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Auto-exports — functions called from inline HTML handlers
window.switchRevPeriod = switchRevPeriod;