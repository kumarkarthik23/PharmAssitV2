/**
 * analytics.js
 * ============
 * Analytics page for PharmAssist V2.
 *
 * Two tabs:
 *   Overview     Standard sales KPIs — revenue, transactions, units sold,
 *                revenue-over-time chart, top drugs bar chart, and the
 *                sales breakdown table.
 *
 *   Pharmacy     Real pharmacy KPIs — prescription fill rate, stock turnover,
 *                expiry loss tracking, and average prescription value trend.
 *
 * Both tabs fetch their own endpoints in parallel on first load and cache
 * the results so tab switching does not trigger additional API calls.
 *
 * Dependencies: app.js, Chart.js (CDN).
 */

'use strict';


// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {Chart|null} */
let _analyticsRevenueChart   = null;
/** @type {Chart|null} */
let _analyticsTopDrugsChart  = null;
/** @type {Chart|null} */
let _analyticsTurnoverChart  = null;
/** @type {Chart|null} */
let _analyticsExpiryChart    = null;
/** @type {Chart|null} */
let _analyticsRxValueChart   = null;

/** @type {'overview'|'pharmacy'} */
let _analyticsTab = 'overview';

const _BAR_COLORS = [
  'rgba(25,  118, 210, 0.75)',
  'rgba(22,  163, 74,  0.75)',
  'rgba(217, 119, 6,   0.75)',
  'rgba(124, 58,  237, 0.75)',
  'rgba(220, 38,  38,  0.75)',
  'rgba(20,  184, 166, 0.75)',
  'rgba(245, 158, 11,  0.75)',
  'rgba(236, 72,  153, 0.75)',
  'rgba(99,  102, 241, 0.75)',
  'rgba(16,  185, 129, 0.75)',
];

const _SCALE_DEFAULTS = {
  x: { grid: { color: '#EEF2F7' }, ticks: { font: { size: 11 } } },
  y: { grid: { color: '#EEF2F7' }, ticks: { font: { size: 11 } } },
};


// ---------------------------------------------------------------------------
// Page entry point
// ---------------------------------------------------------------------------

async function renderAnalytics() {
  const container = document.getElementById('page-analytics');
  container.innerHTML = loadingHTML('Loading analytics…');

  try {
    const [salesData, pharmacyData] = await Promise.all([
      apiFetch('/api/analytics'),
      apiFetch('/api/analytics/pharmacy'),
    ]);

    App.cache.analytics         = salesData;
    App.cache.pharmacyAnalytics = pharmacyData;

    container.innerHTML = _buildPageShell();
    _switchAnalyticsTab(_analyticsTab, salesData, pharmacyData);
    setTimeout(renderIcons, 100);

  } catch (err) {
    container.innerHTML = `
      <div class="alert alert-danger">Failed to load analytics: ${err.message}</div>`;
  }
}


// ---------------------------------------------------------------------------
// Page shell + tab switcher
// ---------------------------------------------------------------------------

function _buildPageShell() {
  return `
    <div class="page-header">
      <div>
        <div class="page-title">Analytics</div>
        <div class="page-subtitle">Sales performance and pharmacy insights</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="renderAnalytics()">
        <i data-lucide="refresh-cw" style="width: 14px; height: 14px"></i>
        Refresh
      </button>
    </div>

    <div style="
      display: flex; gap: 4px; margin-bottom: 24px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 4px; width: fit-content
    ">
      <button id="atab-overview" class="subtab-btn" onclick="switchAnalyticsTab('overview')">
        <i data-lucide="bar-chart-2" style="width: 14px; height: 14px"></i>
        Sales Overview
      </button>
      <button id="atab-pharmacy" class="subtab-btn" onclick="switchAnalyticsTab('pharmacy')">
        <i data-lucide="activity" style="width: 14px; height: 14px"></i>
        Pharmacy Insights
      </button>
    </div>

    <div id="analytics-content"></div>`;
}

/**
 * Switch analytics tab. Uses cached data — no new API call.
 * @param {'overview'|'pharmacy'} tab
 */
function switchAnalyticsTab(tab) {
  _analyticsTab = tab;

  document.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('subtab-active'));
  const btn = document.getElementById(`atab-${tab}`);
  if (btn) btn.classList.add('subtab-active');

  const content = document.getElementById('analytics-content');
  if (!content) return;

  const salesData    = App.cache.analytics;
  const pharmacyData = App.cache.pharmacyAnalytics;
  if (!salesData || !pharmacyData) return;

  _switchAnalyticsTab(tab, salesData, pharmacyData);
}

function _switchAnalyticsTab(tab, salesData, pharmacyData) {
  const content = document.getElementById('analytics-content');
  if (!content) return;

  // Destroy all chart instances before re-rendering
  [_analyticsRevenueChart, _analyticsTopDrugsChart,
   _analyticsTurnoverChart, _analyticsExpiryChart, _analyticsRxValueChart]
    .forEach(c => { if (c) { c.destroy(); } });
  _analyticsRevenueChart  = null;
  _analyticsTopDrugsChart = null;
  _analyticsTurnoverChart = null;
  _analyticsExpiryChart   = null;
  _analyticsRxValueChart  = null;

  // Sync button active state
  document.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('subtab-active'));
  const btn = document.getElementById(`atab-${tab}`);
  if (btn) btn.classList.add('subtab-active');

  if (tab === 'overview') {
    content.innerHTML = _buildOverviewTab(salesData);
    const hasData = salesData.summary.total_transactions > 0;
    if (hasData) {
      _renderRevenueChart(salesData.by_date);
      _renderTopDrugsChart(salesData.top_drugs);
    }
  } else {
    content.innerHTML = _buildPharmacyTab(pharmacyData);
    _renderTurnoverChart(pharmacyData.turnover);
    _renderExpiryLossChart(pharmacyData.expiry_loss);
    _renderRxValueChart(pharmacyData.avg_rx_value);
  }

  setTimeout(renderIcons, 100);
}


// ---------------------------------------------------------------------------
// Tab 1 — Sales Overview
// ---------------------------------------------------------------------------

function _buildOverviewTab(data) {
  const { summary, by_drug, by_date } = data;
  const hasData = summary.total_transactions > 0;

  return `
    <div class="kpi-grid" style="grid-template-columns: repeat(3, 1fr); margin-bottom: 24px">
      <div class="kpi-card kpi-green">
        <div class="kpi-icon"><i data-lucide="dollar-sign" style="width:20px;height:20px"></i></div>
        <div class="kpi-value">${fmtCurrency(summary.total_revenue)}</div>
        <div class="kpi-label">Total Revenue</div>
      </div>
      <div class="kpi-card kpi-blue">
        <div class="kpi-icon"><i data-lucide="receipt" style="width:20px;height:20px"></i></div>
        <div class="kpi-value">${summary.total_transactions}</div>
        <div class="kpi-label">Transactions</div>
      </div>
      <div class="kpi-card kpi-purple">
        <div class="kpi-icon"><i data-lucide="trending-up" style="width:20px;height:20px"></i></div>
        <div class="kpi-value">${summary.total_units_sold}</div>
        <div class="kpi-label">Units Sold</div>
      </div>
    </div>

    ${hasData ? `
      <div class="section-row cols-2" style="margin-bottom: 24px">
        <div class="card">
          <div class="card-title" style="display:flex;align-items:center;gap:8px">
            <i data-lucide="trending-up" style="width:16px;height:16px;color:var(--blue-mid)"></i>
            Revenue Over Time
          </div>
          <div class="chart-box"><canvas id="revenue-chart"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title" style="display:flex;align-items:center;gap:8px">
            <i data-lucide="award" style="width:16px;height:16px;color:var(--yellow)"></i>
            Top Selling Drugs
          </div>
          <div class="chart-box"><canvas id="top-drugs-chart"></canvas></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;gap:8px">
          <i data-lucide="bar-chart-2" style="width:16px;height:16px;color:var(--blue-mid)"></i>
          Sales by Drug
        </div>
        ${_buildDrugBreakdownTable(by_drug)}
      </div>
    ` : `
      <div class="card">
        ${emptyHTML('📊', 'No sales data yet', 'Process a prescription to start tracking analytics.')}
      </div>`}`;
}

function _buildDrugBreakdownTable(byDrug) {
  if (!byDrug || byDrug.length === 0) {
    return emptyHTML('📊', 'No data', 'No sales recorded yet.');
  }
  const totalRevenue = byDrug.reduce((sum, d) => sum + d.revenue, 0);
  const rows = byDrug.map(drug => {
    const share = totalRevenue > 0 ? (drug.revenue / totalRevenue * 100).toFixed(1) : '0.0';
    return `
      <tr>
        <td><strong>${drug.name}</strong></td>
        <td>${drug.brand || '—'}</td>
        <td>${drug.units_sold}</td>
        <td>${drug.transactions}</td>
        <td>${fmtCurrency(drug.revenue)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;background:var(--border);border-radius:4px;height:6px;overflow:hidden">
              <div style="width:${share}%;background:var(--blue-mid);height:100%;border-radius:4px"></div>
            </div>
            <span class="text-sm text-muted">${share}%</span>
          </div>
        </td>
      </tr>`;
  }).join('');
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Drug</th><th>Brand</th><th>Units Sold</th>
          <th>Transactions</th><th>Revenue</th><th>Revenue Share</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function _renderRevenueChart(byDate) {
  const canvas = document.getElementById('revenue-chart');
  if (!canvas) return;
  if (_analyticsRevenueChart) { _analyticsRevenueChart.destroy(); _analyticsRevenueChart = null; }
  _analyticsRevenueChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels:   byDate.map(d => fmtDate(d.date)),
      datasets: [{ label: 'Revenue ($)', data: byDate.map(d => d.revenue),
        borderColor: '#1976D2', backgroundColor: 'rgba(25,118,210,0.08)',
        borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#1976D2',
        fill: true, tension: 0.35 }],
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: _SCALE_DEFAULTS.x, y: { ..._SCALE_DEFAULTS.y,
        ticks: { font: { size: 11 }, callback: v => '$' + v.toFixed(0) } } } },
  });
}

function _renderTopDrugsChart(topDrugs) {
  const canvas = document.getElementById('top-drugs-chart');
  if (!canvas) return;
  if (_analyticsTopDrugsChart) { _analyticsTopDrugsChart.destroy(); _analyticsTopDrugsChart = null; }
  _analyticsTopDrugsChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels:   topDrugs.map(d => d.name),
      datasets: [{ label: 'Units Sold', data: topDrugs.map(d => d.units_sold),
        backgroundColor: _BAR_COLORS, borderRadius: 6, borderSkipped: false }],
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false }, ticks: { font: { size: 11 } } },
                y: _SCALE_DEFAULTS.y } },
  });
}


// ---------------------------------------------------------------------------
// Tab 2 — Pharmacy Insights
// ---------------------------------------------------------------------------

function _buildPharmacyTab(data) {
  const { fill_rate, turnover, expiry_loss, avg_rx_value } = data;

  return `
    <!-- Row 1: Fill rate KPIs + avg rx value -->
    <div class="section-row cols-2" style="margin-bottom: 24px">
      ${_buildFillRateCard(fill_rate)}
      ${_buildAvgRxValueCard(avg_rx_value)}
    </div>

    <!-- Row 2: Stock turnover table -->
    <div class="card" style="margin-bottom: 24px">
      <div class="card-title" style="display:flex;align-items:center;gap:8px">
        <i data-lucide="refresh-cw" style="width:16px;height:16px;color:var(--blue-mid)"></i>
        Stock Turnover Rate
        <span style="font-size:11px;color:var(--text-muted);font-weight:400;margin-left:4px">
          — 30-day window
        </span>
      </div>
      ${_buildTurnoverTable(turnover)}
    </div>

    <!-- Row 3: Expiry loss chart + top loss drugs -->
    <div class="section-row cols-2">
      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;gap:8px">
          <i data-lucide="trash-2" style="width:16px;height:16px;color:var(--red)"></i>
          Expiry Loss by Month
        </div>
        ${expiry_loss.monthly.length > 0
          ? '<div class="chart-box"><canvas id="expiry-chart"></canvas></div>'
          : emptyHTML('', 'No write-offs recorded', 'All stock is within expiry dates.')}
      </div>
      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;gap:8px">
          <i data-lucide="alert-triangle" style="width:16px;height:16px;color:var(--red)"></i>
          Expiry Loss Summary
        </div>
        ${_buildExpiryLossSummary(expiry_loss)}
      </div>
    </div>`;
}

function _buildFillRateCard(fr) {
  const fillColor  = fr.fill_rate >= 90 ? 'var(--green)' : fr.fill_rate >= 70 ? 'var(--yellow)' : 'var(--red)';
  const fillBg     = fr.fill_rate >= 90 ? 'var(--green-bg)' : fr.fill_rate >= 70 ? 'var(--yellow-bg)' : 'var(--red-bg)';

  return `
    <div class="card">
      <div class="card-title" style="display:flex;align-items:center;gap:8px">
        <i data-lucide="clipboard-check" style="width:16px;height:16px;color:var(--blue-mid)"></i>
        Prescription Fill Rate
      </div>

      <div style="display:flex;align-items:center;gap:24px;margin-bottom:20px">
        <div style="
          width:100px;height:100px;border-radius:50%;
          background:conic-gradient(${fillColor} ${fr.fill_rate * 3.6}deg, var(--border) 0deg);
          display:flex;align-items:center;justify-content:center;flex-shrink:0;position:relative
        ">
          <div style="
            width:72px;height:72px;border-radius:50%;background:var(--surface);
            display:flex;align-items:center;justify-content:center;flex-direction:column
          ">
            <div style="font-size:20px;font-weight:800;color:${fillColor}">${fr.fill_rate}%</div>
          </div>
        </div>
        <div style="flex:1">
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px">
            Fill rate target: <strong>&ge; 90%</strong>
          </div>
          <div style="
            padding:8px 12px;background:${fillBg};border-radius:6px;
            font-size:12.5px;font-weight:600;color:${fillColor}
          ">
            ${fr.fill_rate >= 90 ? 'Excellent — above target' : fr.fill_rate >= 70 ? 'Below target — review cancelled prescriptions' : 'Critical — investigate stock gaps'}
          </div>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead><tr><th>Outcome</th><th>Count</th><th>Share</th></tr></thead>
          <tbody>
            ${[
              { label: 'Fully Sold',  count: fr.sold,      badge: 'badge-success', icon: 'check-circle' },
              { label: 'Partial',     count: fr.partial,   badge: 'badge-warning', icon: 'git-branch'   },
              { label: 'Cancelled',   count: fr.cancelled, badge: 'badge-danger',  icon: 'x-circle'     },
            ].map(row => {
              const pct = fr.total > 0 ? (row.count / fr.total * 100).toFixed(1) : '0.0';
              return `
                <tr>
                  <td><span class="badge ${row.badge}">
                    <i data-lucide="${row.icon}" style="width:10px;height:10px"></i>
                    ${row.label}
                  </span></td>
                  <td><strong>${row.count}</strong></td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px">
                      <div style="flex:1;background:var(--border);border-radius:4px;height:5px;overflow:hidden">
                        <div style="width:${pct}%;height:100%;border-radius:4px;background:var(--blue-mid)"></div>
                      </div>
                      <span class="text-sm text-muted">${pct}%</span>
                    </div>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function _buildAvgRxValueCard(rx) {
  return `
    <div class="card">
      <div class="card-title" style="display:flex;align-items:center;gap:8px">
        <i data-lucide="trending-up" style="width:16px;height:16px;color:var(--green)"></i>
        Average Prescription Value
      </div>

      <div style="display:flex;gap:16px;margin-bottom:20px">
        <div style="
          flex:1;background:var(--green-bg);border-radius:8px;
          padding:16px 20px;text-align:center
        ">
          <div style="font-size:28px;font-weight:800;color:var(--green)">${fmtCurrency(rx.avg_value)}</div>
          <div style="font-size:12px;color:var(--green);opacity:0.8;margin-top:4px">Avg per prescription</div>
        </div>
        <div style="
          flex:1;background:var(--blue-light);border-radius:8px;
          padding:16px 20px;text-align:center
        ">
          <div style="font-size:28px;font-weight:800;color:var(--blue-mid)">${rx.rx_count}</div>
          <div style="font-size:12px;color:var(--blue-mid);opacity:0.8;margin-top:4px">Prescriptions filled</div>
        </div>
      </div>

      ${rx.trend.length > 0
        ? '<div class="chart-box chart-box-sm"><canvas id="rx-value-chart"></canvas></div>'
        : `<div style="text-align:center;padding:32px;color:var(--text-muted);font-size:13px">
             Process more prescriptions to see the value trend.
           </div>`}
    </div>`;
}

function _buildTurnoverTable(turnover) {
  if (!turnover || turnover.length === 0) {
    return emptyHTML('', 'No sales data', 'Record sales to calculate turnover rates.');
  }

  const rows = turnover.map(drug => {
    const rateColor =
      drug.turnover_rate >= 2   ? 'var(--green)'  :
      drug.turnover_rate >= 0.5 ? 'var(--yellow)' : 'var(--red)';
    const rateLabel =
      drug.turnover_rate >= 2   ? 'Fast mover'   :
      drug.turnover_rate >= 0.5 ? 'Normal'        :
      drug.units_sold_30d === 0 ? 'No sales'      : 'Slow mover';
    const daysLeftLabel = drug.days_left === null ? '—'
      : drug.days_left > 90 ? `${drug.days_left}d`
      : `<span style="color:${drug.days_left <= 14 ? 'var(--red)' : 'var(--yellow)'}; font-weight:700">${drug.days_left}d</span>`;

    return `
      <tr>
        <td><strong>${drug.name}</strong><br>
          <span class="text-muted text-sm">${drug.brand}</span>
        </td>
        <td>${drug.current_stock}</td>
        <td>${drug.units_sold_30d}</td>
        <td>${drug.daily_usage}/day</td>
        <td>${daysLeftLabel}</td>
        <td>
          <span style="
            font-size:13px;font-weight:700;color:${rateColor};
            background:${rateColor}22;padding:3px 10px;border-radius:20px
          ">${drug.turnover_rate}x — ${rateLabel}</span>
        </td>
      </tr>`;
  }).join('');

  return `
    <div style="margin-bottom:10px;font-size:12px;color:var(--text-muted);display:flex;gap:20px">
      <span style="color:var(--green)">&#9632; Fast mover (&ge;2x)</span>
      <span style="color:var(--yellow)">&#9632; Normal (0.5–2x)</span>
      <span style="color:var(--red)">&#9632; Slow mover / No sales (&lt;0.5x)</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Drug</th><th>Stock</th><th>Sold (30d)</th>
          <th>Daily Usage</th><th>Days Left</th><th>Turnover</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function _buildExpiryLossSummary(loss) {
  if (loss.total_units === 0) {
    return emptyHTML('', 'No expiry losses', 'No stock has been written off yet.');
  }

  return `
    <div style="display:flex;gap:12px;margin-bottom:20px">
      <div style="flex:1;background:var(--red-bg);border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:24px;font-weight:800;color:var(--red)">${loss.total_units}</div>
        <div style="font-size:11px;color:var(--red);opacity:0.8">Units Written Off</div>
      </div>
      <div style="flex:1;background:var(--yellow-bg);border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:24px;font-weight:800;color:var(--yellow)">${fmtCurrency(loss.total_value)}</div>
        <div style="font-size:11px;color:var(--yellow);opacity:0.8">Value Lost</div>
      </div>
    </div>

    ${loss.top_losses.length > 0 ? `
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;
                  color:var(--text-secondary);margin-bottom:8px">Most Written-Off Drugs</div>
      ${loss.top_losses.map((d, i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;
                    padding:8px 0;border-bottom:1px solid var(--border-light)">
          <span style="font-size:13px">${i + 1}. ${d.name}</span>
          <span class="badge badge-danger">${d.units_lost} units</span>
        </div>`).join('')}
    ` : ''}`;
}

function _buildTurnoverChart(turnover) {
  // Not rendered as a chart — table format is more readable for turnover
}

function _renderTurnoverChart(turnover) {
  // Intentionally unused — turnover is displayed as a table
}

function _renderExpiryLossChart(loss) {
  const canvas = document.getElementById('expiry-chart');
  if (!canvas || !loss.monthly.length) return;
  if (_analyticsExpiryChart) { _analyticsExpiryChart.destroy(); _analyticsExpiryChart = null; }

  _analyticsExpiryChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels:   loss.monthly.map(m => m.month),
      datasets: [
        { label: 'Units Lost',  data: loss.monthly.map(m => m.units_lost),
          backgroundColor: 'rgba(220,38,38,0.7)', borderRadius: 4,
          yAxisID: 'y', order: 2 },
        { label: 'Value Lost ($)', data: loss.monthly.map(m => m.value_lost),
          type: 'line', borderColor: '#D97706', backgroundColor: 'rgba(217,119,6,0.1)',
          borderWidth: 2.5, pointRadius: 4, fill: true, tension: 0.35,
          yAxisID: 'y1', order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'top',
        labels: { font: { size: 11 }, boxWidth: 12 } } },
      scales: {
        x:  _SCALE_DEFAULTS.x,
        y:  { ..._SCALE_DEFAULTS.y, position: 'left',
              title: { display: true, text: 'Units', font: { size: 10 } } },
        y1: { ..._SCALE_DEFAULTS.y, position: 'right', grid: { drawOnChartArea: false },
              title: { display: true, text: 'Value ($)', font: { size: 10 } },
              ticks: { font: { size: 11 }, callback: v => '$' + v } },
      },
    },
  });
}

function _renderRxValueChart(rx) {
  const canvas = document.getElementById('rx-value-chart');
  if (!canvas || !rx.trend.length) return;
  if (_analyticsRxValueChart) { _analyticsRxValueChart.destroy(); _analyticsRxValueChart = null; }

  _analyticsRxValueChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels:   rx.trend.map(d => fmtDate(d.date)),
      datasets: [{
        label: 'Avg Rx Value ($)',
        data:  rx.trend.map(d => d.avg_value),
        borderColor: '#16A34A', backgroundColor: 'rgba(22,163,74,0.08)',
        borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#16A34A',
        fill: true, tension: 0.35,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: _SCALE_DEFAULTS.x,
        y: { ..._SCALE_DEFAULTS.y,
          ticks: { font: { size: 11 }, callback: v => '$' + v.toFixed(2) } },
      },
    },
  });
}


// Auto-exports — functions called from inline HTML handlers
window.switchAnalyticsTab = switchAnalyticsTab;