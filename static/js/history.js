/**
 * history.js
 * ==========
 * History page for PharmAssist V2.
 *
 * Two sub-tabs share a single page container:
 *
 *   Prescriptions  Uploaded prescription images with extraction outcomes.
 *                  Shows a summary badge row and a sortable record table.
 *                  Each row links to a modal image viewer.
 *
 *   Orders         Sales transaction log grouped by date, newest first.
 *                  Includes three KPI cards, a search/date-range filter,
 *                  date-grouped transaction cards, and a CSV export.
 *
 * Sub-tab state persists across re-renders so returning to the History
 * page opens whichever tab was last active.
 *
 * The sub-tab button styles are injected into <head> once on first render
 * to avoid duplicating the rules on every renderHistory() call.
 *
 * Dependencies: app.js (apiFetch, loadingHTML, emptyHTML, fmtCurrency,
 *               fmtDate, expiryBadge, openModal, showToast, renderIcons).
 */

'use strict';


// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * The sub-tab currently displayed.
 * Persists across renderHistory() calls so the user's last-used tab
 * is restored when they navigate back to this page.
 * @type {'prescriptions'|'orders'}
 */
let _activeTab = 'prescriptions';

/**
 * The full sales dataset for the Orders tab, stored here so the
 * client-side filter can operate without a new API call.
 * @type {Array|null}
 */
let _allSales = null;


// ---------------------------------------------------------------------------
// Sub-tab styles
// ---------------------------------------------------------------------------

/**
 * Inject sub-tab button styles into <head> once.
 *
 * Using a <style> tag avoids adding .subtab-btn rules to app.css (they
 * are only relevant to this page) while still keeping the styles global
 * enough to survive innerHTML replacements of the page container.
 */
function _injectSubtabStyles() {
  if (document.getElementById('subtab-style')) return;

  const style = document.createElement('style');
  style.id    = 'subtab-style';
  style.textContent = `
    .subtab-btn {
      display:       inline-flex;
      align-items:   center;
      gap:           6px;
      padding:       7px 18px;
      border-radius: 6px;
      border:        none;
      font-size:     13.5px;
      font-weight:   600;
      cursor:        pointer;
      background:    transparent;
      color:         var(--text-secondary);
      transition:    background 0.15s, color 0.15s;
    }
    .subtab-btn:hover  { background: var(--bg); color: var(--text-primary); }
    .subtab-active     { background: var(--blue-mid) !important; color: #fff !important; }
  `;
  document.head.appendChild(style);
}


// ---------------------------------------------------------------------------
// Page entry point
// ---------------------------------------------------------------------------

/**
 * Render the History page shell and activate the current sub-tab.
 *
 * The shell contains the page header, the sub-tab switcher, and an
 * empty content container. The active tab's loader then populates
 * that container asynchronously.
 *
 * Called by the router in app.js when navigating to #history.
 */
function renderHistory() {
  _injectSubtabStyles();

  const container = document.getElementById('page-history');
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">History</div>
        <div class="page-subtitle">Prescription records and sales transactions</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="renderHistory()">
        <i data-lucide="refresh-cw" style="width: 14px; height: 14px"></i>
        Refresh
      </button>
    </div>

    <div style="
      display: flex;
      gap: 4px;
      margin-bottom: 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 4px;
      width: fit-content
    ">
      <button id="subtab-prescriptions" class="subtab-btn" onclick="switchHistoryTab('prescriptions')">
        <i data-lucide="clipboard-list" style="width: 14px; height: 14px"></i>
        Prescriptions
      </button>
      <button id="subtab-orders" class="subtab-btn" onclick="switchHistoryTab('orders')">
        <i data-lucide="receipt" style="width: 14px; height: 14px"></i>
        Orders
      </button>
    </div>

    <div id="history-content">
      ${loadingHTML('Loading…')}
    </div>
  `;

  setTimeout(renderIcons, 50);
  switchHistoryTab(_activeTab);
}


// ---------------------------------------------------------------------------
// Sub-tab switcher
// ---------------------------------------------------------------------------

/**
 * Switch to a sub-tab by name.
 *
 * Updates the active button style, clears the content container, and
 * delegates to the appropriate async loader. Preserves the tab choice
 * in _activeTab so renderHistory() can restore it on re-render.
 *
 * @param {'prescriptions'|'orders'} tab
 */
function switchHistoryTab(tab) {
  _activeTab = tab;

  // Update button active state
  document.querySelectorAll('.subtab-btn').forEach(btn => btn.classList.remove('subtab-active'));
  const activeButton = document.getElementById(`subtab-${tab}`);
  if (activeButton) activeButton.classList.add('subtab-active');

  const content = document.getElementById('history-content');
  if (!content) return;

  content.innerHTML = loadingHTML('Loading…');

  if (tab === 'prescriptions') {
    loadPrescriptionsTab(content);
  } else {
    loadOrdersTab(content);
  }
}


// ---------------------------------------------------------------------------
// Prescriptions sub-tab
// ---------------------------------------------------------------------------

/**
 * Fetch prescription history and render the records table.
 *
 * Shows outcome summary badges above the table and a View button on
 * each row that opens the prescription image in a modal.
 *
 * @param {HTMLElement} container  The #history-content element to populate.
 */
async function loadPrescriptionsTab(container) {
  try {
    const records = await apiFetch('/api/history?limit=50');
    App.cache.history = records;

    if (records.length === 0) {
      container.innerHTML = `
        <div class="card">
          ${emptyHTML('', 'No prescriptions yet', 'Upload a prescription to see it here.')}
        </div>`;
      return;
    }

    const counts = _countOutcomes(records);

    container.innerHTML = `
      ${buildOutcomeSummary(counts)}
      <div class="card" style="padding: 0">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Date</th>
                <th>Drugs Extracted</th>
                <th>Drug Names</th>
                <th>Outcome</th>
                <th>Image</th>
              </tr>
            </thead>
            <tbody>
              ${records.map(buildPrescriptionRow).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    setTimeout(renderIcons, 50);

  } catch (err) {
    container.innerHTML = `
      <div class="alert alert-danger">
        Failed to load prescriptions: ${err.message}
      </div>`;
  }
}

/**
 * Count prescription records by outcome.
 *
 * @param {Array} records
 * @returns {{ sold: number, pending: number, partial: number, cancelled: number }}
 */
function _countOutcomes(records) {
  return {
    sold:      records.filter(r => r.outcome === 'sold').length,
    pending:   records.filter(r => r.outcome === 'pending').length,
    partial:   records.filter(r => r.outcome === 'partial').length,
    cancelled: records.filter(r => r.outcome === 'cancelled').length,
    abandoned: records.filter(r => r.outcome === 'abandoned').length,
  };
}

/**
 * Build the outcome summary badge row shown above the prescriptions table.
 *
 * @param {{ sold, pending, partial, cancelled }} counts
 * @returns {string} HTML string.
 */
function buildOutcomeSummary(counts) {
  return `
    <div style="display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap">
      <span class="badge badge-success">
        <i data-lucide="check-circle" style="width: 11px; height: 11px"></i>
        ${counts.sold} sold
      </span>
      <span class="badge badge-warning">
        <i data-lucide="clock" style="width: 11px; height: 11px"></i>
        ${counts.pending} pending
      </span>
      <span class="badge badge-purple">
        <i data-lucide="git-branch" style="width: 11px; height: 11px"></i>
        ${counts.partial} partial
      </span>
      <span class="badge badge-neutral">
        <i data-lucide="x" style="width: 11px; height: 11px"></i>
        ${counts.cancelled} cancelled
      </span>
      ${counts.abandoned > 0 ? `
      <span class="badge badge-danger">
        <i data-lucide="clock-x" style="width: 11px; height: 11px"></i>
        ${counts.abandoned} abandoned
      </span>` : ''}
    </div>`;
}

/**
 * Build a single prescription table row.
 *
 * Drug names are truncated with ellipsis when they exceed 300px, with
 * the full list available via the title tooltip.
 *
 * @param {object} record  Prescription history record from the API.
 * @returns {string} HTML string for a <tr> element.
 */
function buildPrescriptionRow(record) {
  return `
    <tr>
      <td class="text-muted">#${record.id}</td>
      <td>${fmtDate(record.upload_date)}</td>
      <td class="text-center">
        <span class="badge badge-info">${record.drug_count}</span>
      </td>
      <td>
        <div style="
          max-width: 300px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap
        " title="${record.drugs}">
          ${record.drugs || '<span class="text-muted">—</span>'}
        </div>
      </td>
      <td>${_outcomeBadge(record.outcome)}</td>
      <td>
        <div class="flex-center gap-8">
          ${(record.outcome === 'pending' || record.outcome === 'abandoned') ? `
            <button class="btn btn-sm btn-secondary"
              onclick="resumePrescription(${record.id}, '${record.outcome}')">
              <i data-lucide="rotate-ccw" style="width: 12px; height: 12px"></i>
              Resume
            </button>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="viewPrescriptionImage(${record.id})">
            <i data-lucide="image" style="width: 13px; height: 13px"></i>
            View
          </button>
        </div>
      </td>
    </tr>`;
}

/**
 * Return an HTML badge for a prescription outcome value.
 *
 * @param {string} outcome  'sold' | 'pending' | 'partial' | 'cancelled'
 * @returns {string} HTML badge string.
 */
function _outcomeBadge(outcome) {
  const badges = {
    sold:      '<span class="badge badge-success"><i data-lucide="check"       style="width:10px;height:10px"></i> Sold</span>',
    pending:   '<span class="badge badge-warning"><i data-lucide="clock"       style="width:10px;height:10px"></i> Pending</span>',
    partial:   '<span class="badge badge-purple"> <i data-lucide="git-branch"  style="width:10px;height:10px"></i> Partial</span>',
    cancelled: '<span class="badge badge-neutral"><i data-lucide="x"           style="width:10px;height:10px"></i> Cancelled</span>',
    abandoned: '<span class="badge badge-danger"> <i data-lucide="clock-x"     style="width:10px;height:10px"></i> Abandoned</span>',
  };
  return badges[outcome] ?? `<span class="badge badge-neutral">${outcome}</span>`;
}

/**
 * Open a modal and load the prescription image for the given record.
 *
 * The modal is shown immediately with a spinner; the image is fetched
 * asynchronously and replaces the spinner when ready.
 *
 * @param {number} recordId  Prescription history record ID.
 */
async function viewPrescriptionImage(recordId) {
  openModal(`
    <div class="modal-header">
      <div class="modal-title" style="display: flex; align-items: center; gap: 8px">
        <i data-lucide="clipboard-list" style="width: 15px; height: 15px"></i>
        Prescription #${recordId}
      </div>
      <button class="modal-close">&#x2715;</button>
    </div>
    <div id="rx-img-container">
      ${loadingHTML('Loading image…')}
    </div>
  `);

  setTimeout(renderIcons, 50);

  const imageContainer = document.getElementById('rx-img-container');

  try {
    const data = await apiFetch(`/api/history/${recordId}/image`);
    if (imageContainer) {
      imageContainer.innerHTML = `
        <img
          src="data:image/jpeg;base64,${data.image_b64}"
          alt="Prescription #${recordId}"
          style="width: 100%; border-radius: var(--radius-sm); display: block"
        />`;
    }
  } catch (err) {
    if (imageContainer) {
      imageContainer.innerHTML = `
        <div class="alert alert-danger">
          Could not load image: ${err.message}
        </div>`;
    }
  }
}


// ---------------------------------------------------------------------------
// Orders sub-tab
// ---------------------------------------------------------------------------

/**
 * Fetch sales data and analytics, then render the Orders sub-tab.
 *
 * Both endpoints are fetched in parallel. The full sales dataset is
 * stored in _allSales so the client-side filter can operate without
 * additional API calls.
 *
 * @param {HTMLElement} container  The #history-content element to populate.
 */
async function loadOrdersTab(container) {
  try {
    const [sales, analytics] = await Promise.all([
      apiFetch('/api/sales?limit=500'),
      apiFetch('/api/analytics'),
    ]);
    _allSales = sales;
    container.innerHTML = buildOrdersContent(sales, analytics.summary);
    setTimeout(renderIcons, 50);

  } catch (err) {
    container.innerHTML = `
      <div class="alert alert-danger">
        Failed to load orders: ${err.message}
      </div>`;
  }
}

/**
 * Build the full Orders tab content: KPI cards, filter bar, and grouped transactions.
 *
 * @param {Array}  sales    Full sales transaction list from the API.
 * @param {object} summary  Sales aggregate totals { total_revenue, total_transactions, total_units_sold }.
 * @returns {string} HTML string.
 */
function buildOrdersContent(sales, summary) {
  if (!sales.length) {
    return `
      <div class="card">
        ${emptyHTML('', 'No orders yet', 'Sales will appear here after the first prescription is dispensed.')}
      </div>`;
  }

  const byDate = _groupByDate(sales);
  const dates  = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  return `
    <div class="kpi-grid" style="grid-template-columns: repeat(3, 1fr); margin-bottom: 20px">
      <div class="kpi-card kpi-green">
        <div class="kpi-icon">
          <i data-lucide="dollar-sign" style="width: 20px; height: 20px"></i>
        </div>
        <div class="kpi-value">${fmtCurrency(summary.total_revenue)}</div>
        <div class="kpi-label">Total Revenue</div>
      </div>
      <div class="kpi-card kpi-blue">
        <div class="kpi-icon">
          <i data-lucide="receipt" style="width: 20px; height: 20px"></i>
        </div>
        <div class="kpi-value">${summary.total_transactions}</div>
        <div class="kpi-label">Transactions</div>
      </div>
      <div class="kpi-card kpi-purple">
        <div class="kpi-icon">
          <i data-lucide="trending-up" style="width: 20px; height: 20px"></i>
        </div>
        <div class="kpi-value">${summary.total_units_sold}</div>
        <div class="kpi-label">Units Sold</div>
      </div>
    </div>

    <div class="card mb-16" style="padding: 12px 20px">
      <div class="flex-center gap-8" style="flex-wrap: wrap">
        <input
          class="form-input"
          id="orders-search"
          style="max-width: 220px"
          placeholder="Search drug name…"
          oninput="filterOrders()"
        />
        <input
          class="form-input"
          id="orders-date-from"
          type="date"
          style="max-width: 155px"
          onchange="filterOrders()"
        />
        <span style="color: var(--text-muted); font-size: 13px">to</span>
        <input
          class="form-input"
          id="orders-date-to"
          type="date"
          style="max-width: 155px"
          onchange="filterOrders()"
        />
        <button class="btn btn-ghost btn-sm" onclick="clearOrdersFilter()">
          <i data-lucide="x" style="width: 13px; height: 13px"></i>
          Clear
        </button>
        <button class="btn btn-ghost btn-sm" onclick="exportOrdersCSV()">
          <i data-lucide="download" style="width: 13px; height: 13px"></i>
          Export CSV
        </button>
      </div>
    </div>

    <div id="orders-groups">
      ${buildOrderGroups(byDate, dates)}
    </div>`;
}

/**
 * Group a flat sales array into an object keyed by sale_date.
 *
 * @param {Array} sales
 * @returns {Record<string, Array>}
 */
function _groupByDate(sales) {
  return sales.reduce((acc, sale) => {
    if (!acc[sale.sale_date]) acc[sale.sale_date] = [];
    acc[sale.sale_date].push(sale);
    return acc;
  }, {});
}

/**
 * Build the date-grouped transaction cards.
 *
 * Each card has a coloured header with the date, item count, total units,
 * and day revenue. The body is a table of individual transactions.
 * A day total footer row closes each table.
 *
 * @param {Record<string, Array>} byDate  Sales grouped by date.
 * @param {string[]}              dates   Sorted date keys (newest first).
 * @returns {string} HTML string.
 */
function buildOrderGroups(byDate, dates) {
  if (!dates.length) {
    return `
      <div class="card">
        ${emptyHTML('', 'No orders match', 'Try adjusting your search or date filter.')}
      </div>`;
  }

  return dates.map(date => {
    const transactions = byDate[date];
    const dayTotal     = transactions.reduce((sum, t) => sum + (t.total_price || 0), 0);
    const dayUnits     = transactions.reduce((sum, t) => sum + t.quantity_sold, 0);

    const rows = transactions.map(t => `
      <tr style="border-top: 1px solid var(--border-light)">
        <td style="padding: 10px 20px"><strong>${t.name}</strong></td>
        <td style="padding: 10px 16px; color: var(--text-secondary)">${t.brand || '—'}</td>
        <td style="padding: 10px 16px">
          <span class="badge badge-info">${t.quantity_sold} units</span>
        </td>
        <td style="padding: 10px 16px">
          ${t.batch_expiry ? expiryBadge(t.batch_expiry) : '<span class="text-muted">—</span>'}
        </td>
        <td style="padding: 10px 16px; text-align: right; font-weight: 700; color: var(--green)">
          ${fmtCurrency(t.total_price || 0)}
        </td>
      </tr>`).join('');

    const headers = ['Drug', 'Brand', 'Qty Sold', 'Batch Expiry', 'Total'];
    const headerRow = headers.map((h, i) => `
      <th style="
        padding: 8px ${i === 0 ? '20px' : '16px'};
        text-align: ${i === headers.length - 1 ? 'right' : 'left'};
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        color: var(--text-secondary)
      ">${h}</th>`).join('');

    return `
      <div class="card mb-16" style="padding: 0">
        <div style="
          padding: 12px 20px;
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: var(--blue-pale);
          border-radius: var(--radius) var(--radius) 0 0
        ">
          <div style="font-weight: 700; font-size: 14px; color: var(--blue-deep); display: flex; align-items: center; gap: 7px">
            <i data-lucide="calendar" style="width: 13px; height: 13px"></i>
            ${fmtDate(date)}
          </div>
          <div class="flex-center gap-8">
            <span class="badge badge-info">
              ${transactions.length} item${transactions.length !== 1 ? 's' : ''}
            </span>
            <span class="badge badge-neutral">${dayUnits} units</span>
            <span class="badge badge-success">${fmtCurrency(dayTotal)}</span>
          </div>
        </div>

        <table style="width: 100%; border-collapse: collapse; font-size: 13.5px">
          <thead>
            <tr style="background: var(--bg)">${headerRow}</tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr style="border-top: 2px solid var(--border); background: var(--bg)">
              <td colspan="4" style="
                padding: 10px 20px;
                font-weight: 700;
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 0.4px;
                color: var(--text-secondary)
              ">Day Total</td>
              <td style="
                padding: 10px 16px;
                text-align: right;
                font-weight: 800;
                font-size: 15px;
                color: var(--green)
              ">${fmtCurrency(dayTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  }).join('');
}


// ---------------------------------------------------------------------------
// Orders filter
// ---------------------------------------------------------------------------

/**
 * Filter the displayed orders by drug name and/or date range.
 *
 * Reads the current filter input values, applies them to the cached
 * _allSales dataset, groups the result by date, and re-renders the
 * orders group container without a new API call.
 */
function filterOrders() {
  const search   = (document.getElementById('orders-search')?.value   || '').toLowerCase();
  const dateFrom =  document.getElementById('orders-date-from')?.value || '';
  const dateTo   =  document.getElementById('orders-date-to')?.value   || '';
  const sales    = _allSales || [];

  const filtered = sales.filter(sale => {
    const matchesName = !search ||
      sale.name.toLowerCase().includes(search) ||
      (sale.brand || '').toLowerCase().includes(search);
    const afterFrom   = !dateFrom || sale.sale_date >= dateFrom;
    const beforeTo    = !dateTo   || sale.sale_date <= dateTo;
    return matchesName && afterFrom && beforeTo;
  });

  const byDate = _groupByDate(filtered);
  const dates  = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  const groupsContainer = document.getElementById('orders-groups');
  if (groupsContainer) {
    groupsContainer.innerHTML = buildOrderGroups(byDate, dates);
    setTimeout(renderIcons, 50);
  }
}

/**
 * Clear all filter inputs and re-render the full orders list.
 */
function clearOrdersFilter() {
  ['orders-search', 'orders-date-from', 'orders-date-to'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  filterOrders();
}


// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/**
 * Export the current Orders dataset as a CSV file download.
 *
 * Uses the cached _allSales data — exports all transactions regardless
 * of the current filter state. The filename includes today's date for
 * easy identification.
 *
 * Each field that may contain commas (drug name, brand) is double-quoted.
 */
function exportOrdersCSV() {
  const sales = _allSales || [];

  if (!sales.length) {
    showToast('No orders to export.', 'warning');
    return;
  }

  const headers = ['Date', 'Drug', 'Brand', 'Qty Sold', 'Batch Expiry', 'Total ($)'];
  const rows    = sales.map(sale => [
    sale.sale_date,
    `"${sale.name}"`,
    `"${sale.brand || ''}"`,
    sale.quantity_sold,
    sale.batch_expiry || '',
    (sale.total_price || 0).toFixed(2),
  ]);

  const csv      = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob     = new Blob([csv], { type: 'text/csv' });
  const url      = URL.createObjectURL(blob);
  const anchor   = document.createElement('a');
  const filename = `pharmassist_orders_${new Date().toISOString().slice(0, 10)}.csv`;

  anchor.href     = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);

  showToast(`Exported ${sales.length} transactions.`, 'success');
}

// ---------------------------------------------------------------------------
// Resume prescription from history
// ---------------------------------------------------------------------------

/**
 * Resume a pending or abandoned prescription from the History tab.
 *
 * Fetches the stored medicines and image from the server, populates
 * _rxState in prescriptions.js, then navigates to the Prescriptions
 * page which picks up the loaded state and jumps straight to the
 * availability check.
 *
 * @param {number} recordId  Prescription history record ID.
 * @param {string} outcome   Current outcome ('pending' or 'abandoned').
 */
async function resumePrescription(recordId, outcome) {
  showToast('Loading prescription…', 'info', 2000);

  try {
    const data = await apiFetch(`/api/prescriptions/${recordId}/resume`);

    if (!data.medicines || data.medicines.length === 0) {
      showToast('No medicines found in this prescription. It may have been entered manually without data.', 'warning', 4000);
      return;
    }

    // Populate the shared prescription state so prescriptions.js resumes correctly
    _rxState.prescriptionId = data.prescription_id;
    _rxState.medicines      = data.medicines;
    _rxState.imageB64       = data.image_b64 || null;
    _rxState.checkResults   = [];
    _rxState.saleResults    = [];
    _rxState.step           = 'results';
    _rxState.fileHash       = null;
    _pendingReturn          = false;

    showToast(
      `Resuming prescription #${recordId} — ${data.count} drug${data.count !== 1 ? 's' : ''} loaded.`,
      'success',
      3000,
    );

    // Navigate to prescriptions — renderPrescriptions will detect step='results'
    // and render the extraction results table ready for stock check
    navigateTo('prescriptions');

  } catch (err) {
    showToast(`Could not resume prescription: ${err.message}`, 'error');
  }
}


// Auto-exports — functions called from inline HTML handlers
window.clearOrdersFilter = clearOrdersFilter;
window.exportOrdersCSV = exportOrdersCSV;
window.filterOrders = filterOrders;
window.resumePrescription = resumePrescription;
window.switchHistoryTab = switchHistoryTab;
window.viewPrescriptionImage = viewPrescriptionImage;
