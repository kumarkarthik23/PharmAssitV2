/**
 * inventory.js
 * ============
 * Inventory page for PharmAssist V2.
 *
 * Features
 * --------
 * 1. Drug table          Searchable, filterable table with expandable batch rows
 * 2. Expiry timeline     Four-bucket card showing batches by expiry urgency
 * 3. Batch tracking      FIFO sub-rows per drug; depleted batches auto-archived
 * 4. Add drug            Modal for creating a new drug with an initial batch
 * 5. Edit drug           Modal for updating name, brand, price, and alert threshold
 * 6. Restock             Modal for adding a new batch with supplier and lot details
 * 7. Delete drug         Blocked when the drug has sales history
 * 8. Write-off           Zeros all expired batches and logs losses
 * 9. Bulk restock        CSV upload with match preview and sequential import
 * 10. CSV export         Downloads the current inventory as a dated CSV file
 * 11. Export CSV         Downloadable inventory CSV (moved to nav Settings panel)
 *
 * Dependencies: app.js (apiFetch, loadingHTML, emptyHTML, fmtCurrency,
 *               fmtDate, daysUntil, stockBadge, expiryBadge, openModal,
 *               closeModal, showToast, renderIcons).
 */

'use strict';


// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Parsed rows from the bulk restock CSV, populated by parseBulkCSV()
 * and consumed by submitBulkRestock(). Stored at module level so both
 * functions share the same dataset without passing it through the DOM.
 * @type {Array<object>}
 */
let _bulkRestockData = [];


// ---------------------------------------------------------------------------
// Page entry point
// ---------------------------------------------------------------------------

/**
 * Render the Inventory page.
 *
 * Fetches drugs and the expiry timeline in parallel, stores results in
 * the App cache, and delegates rendering to renderInventoryPage().
 * Called by the router in app.js when navigating to #inventory.
 */
async function renderInventory() {
  const container = document.getElementById('page-inventory');
  container.innerHTML = loadingHTML('Loading inventory…');

  try {
    const [drugs, timeline] = await Promise.all([
      apiFetch('/api/drugs'),
      apiFetch('/api/drugs/expiry-timeline'),
    ]);

    App.cache.drugs    = drugs;
    App.cache.timeline = timeline;
    renderInventoryPage(drugs, timeline);

  } catch (err) {
    container.innerHTML = `
      <div class="alert alert-danger">
        Failed to load inventory: ${err.message}
      </div>`;
  }
}

/**
 * Build and insert the full inventory page HTML.
 *
 * @param {Array}  drugs     Drug list with aggregated batch data.
 * @param {object} timeline  Expiry timeline buckets from the API.
 */
function renderInventoryPage(drugs, timeline) {
  const container = document.getElementById('page-inventory');

  const lowCount = drugs.filter(d => d.quantity > 0 && d.quantity <= d.low_stock_threshold).length;
  const outCount = drugs.filter(d => d.quantity === 0).length;
  const expCount = (timeline.already_expired || []).length;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Inventory</div>
        <div class="page-subtitle">
          ${drugs.length} drugs &middot;
          ${outCount} out of stock &middot;
          ${lowCount} low stock &middot;
          ${expCount} expired batches
        </div>
      </div>
      <div class="flex-center gap-8" style="flex-wrap: wrap">
        <button class="btn btn-ghost btn-sm" onclick="openBulkRestockModal()">
          <i data-lucide="upload" style="width: 14px; height: 14px"></i>
          Bulk Restock
        </button>
        <button class="btn btn-secondary btn-sm" onclick="renderInventory()">
          <i data-lucide="refresh-cw" style="width: 14px; height: 14px"></i>
          Refresh
        </button>
        <button class="btn btn-primary" onclick="openAddDrugModal()">
          <i data-lucide="plus" style="width: 14px; height: 14px"></i>
          Add Drug
        </button>
      </div>
    </div>

    ${buildExpiryTimeline(timeline)}

    <div class="card mb-16" style="padding: 14px 20px">
      <div class="flex-center gap-8" style="flex-wrap: wrap">
        <input
          class="form-input"
          id="inv-search"
          style="max-width: 260px"
          placeholder="Search by name or brand…"
          oninput="filterInventory()"
        />
        <select class="form-select" id="inv-filter" style="max-width: 180px" onchange="filterInventory()">
          <option value="all">All drugs</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
          <option value="expiring">Expiring soon</option>
          <option value="expired">Expired</option>
        </select>
      </div>
    </div>

    <div class="card" style="padding: 0">
      <div class="table-wrap" id="inv-table-wrap">
        ${buildInventoryTable(drugs)}
      </div>
    </div>
  `;

  setTimeout(renderIcons, 100);
}


// ---------------------------------------------------------------------------
// Expiry timeline
// ---------------------------------------------------------------------------

/**
 * Build the expiry timeline card with four urgency buckets.
 *
 * Each bucket shows the count, a label, and a preview of the first two
 * drug names. A "Show details" toggle expands to the full batch tables.
 * The Write Off button appears only when expired batches with stock exist.
 *
 * @param {object} timeline  { already_expired, within_30_days, within_60_days, within_90_days }
 * @returns {string} HTML string.
 */
function buildExpiryTimeline(timeline) {
  const expired = timeline.already_expired || [];
  const d30     = timeline.within_30_days  || [];
  const d60     = timeline.within_60_days  || [];
  const d90     = timeline.within_90_days  || [];
  const hasAny  = expired.length || d30.length || d60.length || d90.length;

  /**
   * Build a single bucket tile.
   * @param {Array}  items    Batch items in this bucket.
   * @param {string} label    Bucket label text.
   * @param {string} color    Text and accent color.
   * @param {string} bgColor  Tile background color.
   */
  const buildBucket = (items, label, color, bgColor) => {
    const preview = items.length === 0
      ? 'No batches'
      : items.slice(0, 2).map(i => i.name).join(', ') +
        (items.length > 2 ? ` +${items.length - 2} more` : '');

    return `
      <div style="
        flex: 1;
        min-width: 160px;
        background: ${bgColor};
        border-radius: 8px;
        padding: 14px 16px
      ">
        <div style="
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: ${color};
          margin-bottom: 4px
        ">${label}</div>
        <div style="font-size: 28px; font-weight: 800; color: ${color}">${items.length}</div>
        <div style="font-size: 11.5px; color: ${color}; opacity: 0.8; margin-top: 2px">
          ${preview}
        </div>
      </div>`;
  };

  return `
    <div class="card mb-16">
      <div style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 14px;
        flex-wrap: wrap;
        gap: 10px
      ">
        <div class="card-title" style="margin: 0; display: flex; align-items: center; gap: 8px">
          <i data-lucide="calendar-clock" style="width: 15px; height: 15px; color: var(--blue-mid)"></i>
          Expiry Timeline
        </div>
        <div class="flex-center gap-8">
          ${expired.length > 0 ? `
            <button class="btn btn-danger btn-sm" onclick="confirmWriteoff()">
              <i data-lucide="trash-2" style="width: 13px; height: 13px"></i>
              Write Off ${expired.length} Expired Batch${expired.length !== 1 ? 'es' : ''}
            </button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="toggleTimelineDetails()">
            <span id="timeline-toggle-label">Show details</span>
          </button>
        </div>
      </div>

      <div style="display: flex; gap: 12px; flex-wrap: wrap">
        ${buildBucket(expired, 'Already Expired', '#991B1B', '#FEE2E2')}
        ${buildBucket(d30,     'Within 30 Days',  '#92400E', '#FEF3C7')}
        ${buildBucket(d60,     '31 to 60 Days',   '#1E40AF', '#DBEAFE')}
        ${buildBucket(d90,     '61 to 90 Days',   '#065F46', '#D1FAE5')}
      </div>

      <div id="timeline-details" style="display: none; margin-top: 16px">
        ${hasAny
          ? buildTimelineDetails(expired, d30, d60, d90)
          : '<div class="text-muted text-sm">No expiry concerns in the next 90 days.</div>'}
      </div>
    </div>`;
}

/**
 * Build the expandable detail tables for each timeline bucket.
 *
 * @param {Array} expired  Already expired batches with stock remaining.
 * @param {Array} d30      Batches expiring within 30 days.
 * @param {Array} d60      Batches expiring in 31–60 days.
 * @param {Array} d90      Batches expiring in 61–90 days.
 * @returns {string} HTML string.
 */
function buildTimelineDetails(expired, d30, d60, d90) {
  const buildSection = (items, title) => {
    if (!items.length) return '';
    return `
      <div style="margin-bottom: 14px">
        <div style="
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.4px;
          color: var(--text-secondary);
          margin-bottom: 8px
        ">${title}</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Drug</th><th>Brand</th><th>Batch #</th>
                <th>Qty</th><th>Expiry</th><th>Supplier</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(item => `
                <tr>
                  <td><strong>${item.name}</strong></td>
                  <td>${item.brand || '—'}</td>
                  <td class="text-muted">B-${item.batch_id}</td>
                  <td>${stockBadge(item.quantity, item.low_stock_threshold)}</td>
                  <td>${expiryBadge(item.expiry_date)}</td>
                  <td class="text-muted">${item.supplier || '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  };

  return buildSection(expired, 'Already Expired — write-off recommended')
       + buildSection(d30,     'Expiring within 30 days')
       + buildSection(d60,     'Expiring in 31–60 days')
       + buildSection(d90,     'Expiring in 61–90 days');
}

/**
 * Toggle the timeline detail tables between visible and hidden.
 * Updates the toggle button label to reflect the current state.
 */
function toggleTimelineDetails() {
  const details     = document.getElementById('timeline-details');
  const toggleLabel = document.getElementById('timeline-toggle-label');
  if (!details) return;

  const isOpen          = details.style.display !== 'none';
  details.style.display = isOpen ? 'none' : 'block';
  if (toggleLabel) toggleLabel.textContent = isOpen ? 'Show details' : 'Hide details';
}


// ---------------------------------------------------------------------------
// Write-off
// ---------------------------------------------------------------------------

/**
 * Open a confirmation modal before executing the write-off.
 *
 * Zeroing expired batches is irreversible. The modal requires an
 * explicit button click to proceed so the pharmacist cannot trigger
 * it by accident.
 */
function confirmWriteoff() {
  openModal(`
    <div class="modal-header">
      <div class="modal-title" style="display: flex; align-items: center; gap: 8px">
        <i data-lucide="trash-2" style="width: 13px; height: 13px"></i>
        Write Off Expired Stock
      </div>
      <button class="modal-close">&#x2715;</button>
    </div>
    <div class="alert alert-danger" style="margin-bottom: 16px">
      This will <strong>zero out all expired batches</strong> and log the loss
      to the write-off audit trail. This action cannot be undone.
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="submitWriteoff()">
        <i data-lucide="trash-2" style="width: 13px; height: 13px"></i>
        Write Off Expired Stock
      </button>
    </div>
  `);
  setTimeout(renderIcons, 50);
}

/**
 * Execute the write-off API call and refresh the inventory.
 */
async function submitWriteoff() {
  try {
    const result = await apiFetch('/api/drugs/writeoff-expired', { method: 'POST' });
    closeModal();
    if (result.count === 0) {
      showToast('No expired stock found.', 'warning');
    } else {
      showToast(
        `Wrote off ${result.total_units} units across ${result.count} batch${result.count !== 1 ? 'es' : ''}.`,
        'success',
        5000,
      );
    }
    App.cache.drugs = null;
    renderInventory();
  } catch (err) {
    showToast(`Write-off failed: ${err.message}`, 'error');
  }
}


// ---------------------------------------------------------------------------
// Inventory table
// ---------------------------------------------------------------------------

/**
 * Build the main inventory table.
 *
 * Each drug row has a ▶ expand toggle that loads its batch sub-rows
 * on demand. The batch content row starts hidden and is populated by
 * toggleBatches() on first expand.
 *
 * @param {Array} drugs  Drug list to render.
 * @returns {string} HTML string — either a table or an empty state.
 */
function buildInventoryTable(drugs) {
  if (drugs.length === 0) {
    return emptyHTML(
      '', 'No drugs found', 'Add your first drug using the button above.'
    );
  }

  return `
    <table id="inv-table">
      <thead>
        <tr>
          <th style="width: 32px"></th>
          <th>#</th>
          <th>Name</th>
          <th>Brand</th>
          <th>Total Stock</th>
          <th>Threshold</th>
          <th>Earliest Expiry</th>
          <th>Batches</th>
          <th>Price / Unit</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="inv-tbody">
        ${drugs.map(buildDrugRow).join('')}
      </tbody>
    </table>`;
}

/**
 * Build a single drug row and its hidden batch content row.
 *
 * The row is tinted amber when the drug is low (above zero but below
 * threshold). The batch content row is an empty placeholder; it is
 * populated asynchronously by toggleBatches() on first expand.
 *
 * @param {object} drug  Drug record with aggregated batch fields.
 * @returns {string} HTML string for two <tr> elements.
 */
function buildDrugRow(drug) {
  const isLow = drug.quantity > 0 && drug.quantity <= drug.low_stock_threshold;

  return `
    <tr
      class="drug-row${isLow ? ' row-insufficient' : ''}"
      data-id="${drug.id}"
      data-name="${drug.name.toLowerCase()}"
      data-brand="${(drug.brand || '').toLowerCase()}"
    >
      <td>
        <button
          class="batch-toggle"
          onclick="toggleBatches(${drug.id}, this)"
          style="
            background: none;
            border: none;
            cursor: pointer;
            color: var(--blue-mid);
            font-size: 13px;
            padding: 2px 6px;
            border-radius: 4px
          "
        >&#x25B6;</button>
      </td>
      <td class="text-muted">${drug.id}</td>
      <td><strong>${drug.name}</strong></td>
      <td>${drug.brand || '<span class="text-muted">—</span>'}</td>
      <td>${stockBadge(drug.quantity, drug.low_stock_threshold)}</td>
      <td>
        <span class="badge badge-neutral" title="Low stock alert threshold">
          &le; ${drug.low_stock_threshold}
        </span>
      </td>
      <td>${expiryBadge(drug.expiry_date)}</td>
      <td>
        <span
          class="badge badge-info"
          style="cursor: pointer"
          onclick="toggleBatches(${drug.id}, document.querySelector('.batch-toggle[onclick*=\'toggleBatches(${drug.id},\']'))"
        >
          ${drug.batch_count || 0} batch${(drug.batch_count || 0) !== 1 ? 'es' : ''}
        </span>
      </td>
      <td>${fmtCurrency(drug.price_per_unit)}</td>
      <td>
        <div class="flex-center gap-8">
          <button
            class="btn btn-sm btn-ghost"
            onclick="openEditDrugModal(${drug.id}, '${_escHtml(drug.name)}', '${_escHtml(drug.brand || '')}', ${drug.price_per_unit}, ${drug.low_stock_threshold})"
          >
            <i data-lucide="pencil" style="width: 13px; height: 13px"></i>
            Edit
          </button>
          <button
            class="btn btn-sm btn-secondary"
            onclick="openRestockModal(${drug.id}, '${_escHtml(drug.name)}', ${drug.quantity})"
          >
            <i data-lucide="plus-circle" style="width: 13px; height: 13px"></i>
            Restock
          </button>
          <button
            class="btn btn-sm btn-ghost"
            title="Delete drug"
            onclick="openDeleteModal(${drug.id}, '${_escHtml(drug.name)}')"
          >
            <i data-lucide="trash-2" style="width: 14px; height: 14px"></i>
          </button>
        </div>
      </td>
    </tr>

    <!-- Batch sub-rows — hidden by default, populated on first expand -->
    <tr class="batch-rows" id="batch-rows-${drug.id}" style="display: none">
      <td colspan="10" style="padding: 0 0 0 40px; background: var(--blue-pale)">
        <div id="batch-content-${drug.id}" style="padding: 8px 16px 12px">
          ${loadingHTML('')}
        </div>
      </td>
    </tr>`;
}


// ---------------------------------------------------------------------------
// Batch expand / collapse
// ---------------------------------------------------------------------------

/**
 * Toggle the batch sub-row for a drug.
 *
 * Fetches batch data from the API on the first expand and caches it
 * in the DOM. Subsequent toggles simply show or hide the cached content.
 *
 * @param {number}          drugId     Drug primary key.
 * @param {HTMLElement|null} toggleBtn The ▶/▼ button element, if available.
 */
async function toggleBatches(drugId, toggleBtn) {
  const batchRow = document.getElementById(`batch-rows-${drugId}`);
  if (!batchRow) return;

  const isOpen = batchRow.style.display !== 'none';

  if (isOpen) {
    batchRow.style.display = 'none';
    if (toggleBtn) toggleBtn.innerHTML = '&#x25B6;';
    return;
  }

  batchRow.style.display = 'table-row';
  if (toggleBtn) toggleBtn.innerHTML = '&#x25BC;';

  const content = document.getElementById(`batch-content-${drugId}`);
  content.innerHTML = loadingHTML('Loading batches…');

  try {
    const batches = await apiFetch(`/api/drugs/${drugId}/batches`);
    content.innerHTML = buildBatchSubRows(drugId, batches);
    setTimeout(renderIcons, 50);
  } catch (err) {
    content.innerHTML = `<span class="text-muted text-sm">Failed to load batches: ${err.message}</span>`;
  }
}

/**
 * Build the batch sub-rows for one drug.
 *
 * Active batches (quantity > 0) are shown directly. Depleted batches
 * are hidden under a collapsible toggle so they do not clutter the view
 * but remain accessible for audit or manual removal.
 *
 * The first active batch in FIFO order is labelled "Next to sell".
 *
 * @param {number} drugId   Drug primary key (used to generate unique DOM IDs).
 * @param {Array}  batches  Batch list in FIFO order from the API.
 * @returns {string} HTML string.
 */
function buildBatchSubRows(drugId, batches) {
  if (!batches || batches.length === 0) {
    return '<div class="text-muted text-sm" style="padding: 8px 0">No batches found.</div>';
  }

  const active   = batches.filter(b => b.quantity > 0);
  const depleted = batches.filter(b => b.quantity === 0);
  const nextId   = active.length > 0 ? active[0].id : null;

  const buildBatchRow = batch => {
    const isNext  = batch.id === nextId;
    const fifoTag = isNext
      ? '<span class="badge badge-warning"><i data-lucide="zap" style="width:11px;height:11px"></i> Next to sell</span>'
      : batch.quantity === 0
        ? '<span class="badge badge-neutral">Depleted</span>'
        : '<span class="badge badge-neutral">Queued</span>';

    const removeButton = batch.quantity === 0
      ? `<button
           class="btn btn-sm btn-ghost"
           style="font-size: 11px; padding: 3px 8px"
           onclick="submitDeleteBatch(${batch.id}, ${drugId})"
         >
           <i data-lucide="trash-2" style="width: 11px; height: 11px"></i>
           Remove
         </button>`
      : '';

    return `
      <tr style="border-top: 1px solid var(--border-light)">
        <td style="padding: 7px 12px; color: var(--text-muted)">B-${batch.id}</td>
        <td style="padding: 7px 12px">${fmtDate(batch.received_date)}</td>
        <td style="padding: 7px 12px">${stockBadge(batch.quantity)}</td>
        <td style="padding: 7px 12px">${expiryBadge(batch.expiry_date)}</td>
        <td style="padding: 7px 12px; color: var(--text-muted)">${batch.supplier   || '—'}</td>
        <td style="padding: 7px 12px; color: var(--text-muted)">${batch.batch_note || '—'}</td>
        <td style="padding: 7px 12px">${fifoTag}</td>
        <td style="padding: 7px 12px">${removeButton}</td>
      </tr>`;
  };

  const depletedToggleId = `dt-${drugId}`;
  const depletedRowsId   = `dr-${drugId}`;

  return `
    <table style="width: 100%; font-size: 12.5px; border-collapse: collapse">
      <thead>
        <tr style="
          color: var(--blue-deep);
          font-weight: 700;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.4px
        ">
          <th style="padding: 6px 12px; text-align: left">Batch #</th>
          <th style="padding: 6px 12px; text-align: left">Received</th>
          <th style="padding: 6px 12px; text-align: left">Qty</th>
          <th style="padding: 6px 12px; text-align: left">Expiry</th>
          <th style="padding: 6px 12px; text-align: left">Supplier</th>
          <th style="padding: 6px 12px; text-align: left">Note</th>
          <th style="padding: 6px 12px; text-align: left">FIFO</th>
          <th style="padding: 6px 12px; text-align: left"></th>
        </tr>
      </thead>
      <tbody>
        ${active.length === 0
          ? '<tr><td colspan="8" style="padding: 10px 12px; color: var(--text-muted); font-size: 12px">All stock in this drug has been depleted.</td></tr>'
          : active.map(buildBatchRow).join('')}
      </tbody>
    </table>

    ${depleted.length > 0 ? `
      <div style="padding: 6px 12px 4px">
        <button
          id="${depletedToggleId}"
          onclick="toggleDepletedBatches('${depletedToggleId}', '${depletedRowsId}')"
          style="
            background: none;
            border: none;
            cursor: pointer;
            font-size: 11.5px;
            color: var(--text-muted);
            padding: 4px 0;
            display: flex;
            align-items: center;
            gap: 5px
          "
        >
          &#x25B6; Show ${depleted.length} depleted batch${depleted.length !== 1 ? 'es' : ''}
        </button>
        <div id="${depletedRowsId}" style="display: none; margin-top: 6px">
          <table style="width: 100%; font-size: 12px; border-collapse: collapse; opacity: 0.65">
            <tbody>${depleted.map(buildBatchRow).join('')}</tbody>
          </table>
        </div>
      </div>` : ''}

    <div style="padding: 6px 12px 8px; font-size: 11.5px; color: var(--text-muted)">
      Stock is deducted FIFO — oldest expiry batch consumed first.
    </div>`;
}

/**
 * Toggle the depleted batches section within an expanded drug row.
 *
 * @param {string} toggleId  ID of the toggle button element.
 * @param {string} rowsId    ID of the container to show or hide.
 */
function toggleDepletedBatches(toggleId, rowsId) {
  const rowsContainer = document.getElementById(rowsId);
  const toggleButton  = document.getElementById(toggleId);
  if (!rowsContainer || !toggleButton) return;

  const isOpen = rowsContainer.style.display !== 'none';
  rowsContainer.style.display = isOpen ? 'none' : 'block';
  toggleButton.innerHTML = isOpen
    ? '&#x25B6; Show depleted batches'
    : '&#x25BC; Hide depleted batches';
}

/**
 * Delete a depleted batch record after confirming it has no sales.
 *
 * @param {number} batchId  Batch primary key.
 * @param {number} drugId   Parent drug primary key.
 */
async function submitDeleteBatch(batchId, drugId) {
  try {
    await apiFetch(`/api/batches/${batchId}`, { method: 'DELETE' });
    showToast('Empty batch removed.', 'success');
    App.cache.drugs = null;
    renderInventory();
  } catch (err) {
    showToast(`Could not remove batch: ${err.message}`, 'error');
  }
}


// ---------------------------------------------------------------------------
// Inventory filter
// ---------------------------------------------------------------------------

/**
 * Filter the inventory table by name/brand search and status dropdown.
 *
 * Operates on the cached App.cache.drugs dataset — no API call is made.
 * Re-renders only the table wrapper element, leaving the rest of the
 * page (timeline, filter bar) unchanged.
 */
function filterInventory() {
  const search = (document.getElementById('inv-search')?.value || '').toLowerCase();
  const filter = document.getElementById('inv-filter')?.value || 'all';
  const drugs  = App.cache.drugs || [];

  const filtered = drugs.filter(drug => {
    const matchesSearch = !search ||
      drug.name.toLowerCase().includes(search) ||
      (drug.brand || '').toLowerCase().includes(search);

    const days = daysUntil(drug.expiry_date);
    const matchesFilter = (
      filter === 'all'      ? true :
      filter === 'low'      ? (drug.quantity > 0 && drug.quantity <= drug.low_stock_threshold) :
      filter === 'out'      ? drug.quantity === 0 :
      filter === 'expiring' ? (days !== null && days >= 0 && days <= 90) :
      filter === 'expired'  ? (days !== null && days < 0) :
      true
    );

    return matchesSearch && matchesFilter;
  });

  const tableWrapper = document.getElementById('inv-table-wrap');
  if (tableWrapper) tableWrapper.innerHTML = buildInventoryTable(filtered);
}


// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/**
 * Export the current drug inventory as a CSV file download.
 *
 * Uses the cached App.cache.drugs dataset. The filename includes today's
 * date so exported files are easy to identify and archive.
 */
function exportInventoryCSV() {
  const drugs = App.cache.drugs || [];
  if (drugs.length === 0) {
    showToast('No data to export.', 'warning');
    return;
  }

  const headers = [
    'ID', 'Name', 'Brand', 'Total Stock', 'Low Stock Threshold',
    'Earliest Expiry', 'Batch Count', 'Price Per Unit',
  ];

  const rows = drugs.map(drug => [
    drug.id,
    `"${drug.name}"`,
    `"${drug.brand || ''}"`,
    drug.quantity,
    drug.low_stock_threshold,
    drug.expiry_date    || '',
    drug.batch_count    || 0,
    drug.price_per_unit,
  ]);

  const csv      = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob     = new Blob([csv], { type: 'text/csv' });
  const url      = URL.createObjectURL(blob);
  const anchor   = document.createElement('a');
  const filename = `pharmassist_inventory_${new Date().toISOString().slice(0, 10)}.csv`;

  anchor.href     = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);

  showToast(`Exported ${drugs.length} drugs to CSV.`, 'success');
}


// ---------------------------------------------------------------------------
// Bulk restock via CSV
// ---------------------------------------------------------------------------

/**
 * Open the bulk restock modal.
 *
 * The modal contains a template download link, a CSV file input, a
 * preview table (populated after parsing), and an Import button that
 * is disabled until at least one valid row is matched.
 */
function openBulkRestockModal() {
  openModal(`
    <div class="modal-header">
      <div class="modal-title" style="display: flex; align-items: center; gap: 8px">
        <i data-lucide="upload" style="width: 14px; height: 14px"></i>
        Bulk Restock via CSV
      </div>
      <button class="modal-close">&#x2715;</button>
    </div>

    <div class="alert alert-info" style="margin-bottom: 16px; font-size: 12.5px">
      Upload a CSV with columns:
      <strong>name, quantity, expiry_date, supplier, batch_note</strong><br>
      The first row must be a header. Drug names are matched case-insensitively.
    </div>

    <div class="form-group">
      <label class="form-label">Template</label>
      <button class="btn btn-ghost btn-sm" onclick="downloadBulkTemplate()">
        <i data-lucide="download" style="width: 13px; height: 13px"></i>
        Download CSV Template
      </button>
    </div>

    <div class="form-group">
      <label class="form-label">Upload CSV File</label>
      <input
        type="file"
        id="bulk-csv-input"
        accept=".csv"
        class="form-input"
        style="padding: 6px"
        onchange="parseBulkCSV(this)"
      />
    </div>

    <div id="bulk-preview"></div>

    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="bulk-submit-btn" disabled onclick="submitBulkRestock()">
        <i data-lucide="check" style="width: 14px; height: 14px"></i>
        Import Batches
      </button>
    </div>
  `);
  setTimeout(renderIcons, 50);
}

/**
 * Trigger a CSV template file download for the bulk restock import.
 *
 * The template includes two example rows so the pharmacist can see
 * the expected column format before filling in their own data.
 */
function downloadBulkTemplate() {
  const csv = [
    'name,quantity,expiry_date,supplier,batch_note',
    'Amoxicillin,100,2027-12-01,MedCo Pharma,Lot #ABC123',
    'Ibuprofen,50,2027-06-15,HealthSupply,',
  ].join('\n');

  const blob   = new Blob([csv], { type: 'text/csv' });
  const url    = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href     = url;
  anchor.download = 'bulk_restock_template.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Parse the uploaded CSV file and populate the preview table.
 *
 * Reads the file with FileReader, validates that required columns exist,
 * parses each data row, and attempts to match each drug name against the
 * cached inventory (exact match first, then prefix match as fallback).
 *
 * Populates the global _bulkRestockData array and enables the Import
 * button if at least one row was successfully matched.
 *
 * @param {HTMLInputElement} input  The file input element.
 */
function parseBulkCSV(input) {
  const file = input.files[0];
  if (!file) return;

  const reader    = new FileReader();
  reader.onload   = event => {
    const lines   = event.target.result.trim().split('\n');
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim());

    const nameIdx     = headers.indexOf('name');
    const qtyIdx      = headers.indexOf('quantity');
    const expiryIdx   = headers.indexOf('expiry_date');
    const supplierIdx = headers.indexOf('supplier');
    const noteIdx     = headers.indexOf('batch_note');

    if (nameIdx === -1 || qtyIdx === -1) {
      document.getElementById('bulk-preview').innerHTML = `
        <div class="alert alert-danger">
          CSV must contain "name" and "quantity" columns.
        </div>`;
      return;
    }

    _bulkRestockData  = [];
    const parseErrors = [];
    const cachedDrugs = App.cache.drugs || [];

    lines.slice(1).forEach((line, index) => {
      if (!line.trim()) return;

      const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      const name = cols[nameIdx];
      const qty  = parseInt(cols[qtyIdx]);

      if (!name || isNaN(qty) || qty <= 0) {
        parseErrors.push(`Row ${index + 2}: invalid name or quantity`);
        return;
      }

      // Exact match first, then loose prefix match as fallback
      const matchedDrug =
        cachedDrugs.find(d => d.name.toLowerCase() === name.toLowerCase()) ||
        cachedDrugs.find(d => d.name.toLowerCase().startsWith(name.toLowerCase().split(' ')[0]));

      _bulkRestockData.push({
        name,
        drug_id:    matchedDrug ? matchedDrug.id   : null,
        matched:    matchedDrug ? matchedDrug.name  : null,
        quantity:   qty,
        expiry_date: expiryIdx   >= 0 ? cols[expiryIdx]   : '',
        supplier:    supplierIdx >= 0 ? cols[supplierIdx]  : '',
        batch_note:  noteIdx     >= 0 ? cols[noteIdx]      : '',
      });
    });

    const validRows = _bulkRestockData.filter(r => r.drug_id);
    const preview   = document.getElementById('bulk-preview');
    const submitBtn = document.getElementById('bulk-submit-btn');

    preview.innerHTML = `
      ${parseErrors.length
        ? `<div class="alert alert-warning">${parseErrors.join('<br>')}</div>`
        : ''}
      <div class="table-wrap" style="max-height: 240px; overflow-y: auto">
        <table>
          <thead>
            <tr>
              <th>CSV Name</th><th>Matched Drug</th>
              <th>Qty</th><th>Expiry</th><th>Supplier</th>
            </tr>
          </thead>
          <tbody>
            ${_bulkRestockData.map(row => `
              <tr>
                <td>${row.name}</td>
                <td>${row.matched
                  ? `<span class="badge badge-success">${row.matched}</span>`
                  : '<span class="badge badge-danger">Not found</span>'}</td>
                <td>${row.quantity}</td>
                <td>${row.expiry_date || '—'}</td>
                <td>${row.supplier    || '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="mt-8 text-sm text-muted">
        ${validRows.length} of ${_bulkRestockData.length} rows matched — ready to import.
      </div>`;

    if (submitBtn) submitBtn.disabled = validRows.length === 0;
  };

  reader.readAsText(file);
}

/**
 * Import all matched rows from the parsed CSV as new batch records.
 *
 * Sends one POST /api/drugs/{id}/restock request per valid row.
 * Requests are sent sequentially (not in parallel) to avoid overwhelming
 * the server and to provide an accurate success/failure count.
 */
async function submitBulkRestock() {
  const validRows = _bulkRestockData.filter(r => r.drug_id);
  if (validRows.length === 0) return;

  const submitButton = document.getElementById('bulk-submit-btn');
  if (submitButton) {
    submitButton.disabled    = true;
    submitButton.textContent = 'Importing…';
  }

  let successCount = 0;
  let failCount    = 0;

  for (const row of validRows) {
    try {
      await apiFetch(`/api/drugs/${row.drug_id}/restock`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          quantity_added: row.quantity,
          expiry_date:    row.expiry_date,
          supplier:       row.supplier,
          batch_note:     row.batch_note,
        }),
      });
      successCount++;
    } catch {
      failCount++;
    }
  }

  closeModal();
  showToast(
    `Bulk restock: ${successCount} batch${successCount !== 1 ? 'es' : ''} added` +
    (failCount ? `, ${failCount} failed` : '.'),
    failCount ? 'warning' : 'success',
    4000,
  );
  App.cache.drugs = null;
  renderInventory();
}


// ---------------------------------------------------------------------------
// Add drug modal
// ---------------------------------------------------------------------------

/**
 * Open the Add Drug modal.
 *
 * The form is split into two sections: drug master data (name, brand,
 * price, alert threshold) and initial batch data (quantity, expiry).
 * If quantity is 0 no initial batch is created.
 */
function openAddDrugModal(prefillName = '') {
  openModal(`
    <div class="modal-header">
      <div class="modal-title" style="display: flex; align-items: center; gap: 8px">
        <i data-lucide="plus-circle" style="width: 14px; height: 14px"></i>
        Add New Drug
      </div>
      <button class="modal-close">&#x2715;</button>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label">Drug Name *</label>
        <input class="form-input" id="add-name" placeholder="e.g. Amoxicillin" value="${prefillName}" />
      </div>
      <div class="form-group">
        <label class="form-label">Brand</label>
        <input class="form-input" id="add-brand" placeholder="e.g. Amoxil" />
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label">Price / Unit ($)</label>
        <input class="form-input" id="add-price" type="number" min="0" step="0.01" placeholder="0.50" />
      </div>
      <div class="form-group">
        <label class="form-label">Low Stock Alert Threshold</label>
        <input class="form-input" id="add-threshold" type="number" min="1" value="20" />
      </div>
    </div>

    <hr class="divider" />

    <div style="
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--text-secondary);
      margin-bottom: 10px
    ">Initial Batch</div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label">Quantity *</label>
        <input class="form-input" id="add-qty" type="number" min="0" placeholder="100" />
      </div>
      <div class="form-group">
        <label class="form-label">Expiry Date</label>
        <input class="form-input" id="add-expiry" type="date" />
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitAddDrug()">Add Drug</button>
    </div>
  `);
  setTimeout(renderIcons, 50);
}

/**
 * Read the Add Drug form values and submit the API request.
 */
async function submitAddDrug() {
  const name      = document.getElementById('add-name')?.value.trim();
  const brand     = document.getElementById('add-brand')?.value.trim()     || '';
  const qty       = parseInt(document.getElementById('add-qty')?.value)     || 0;
  const price     = parseFloat(document.getElementById('add-price')?.value) || 0;
  const expiry    = document.getElementById('add-expiry')?.value            || '';
  const threshold = parseInt(document.getElementById('add-threshold')?.value) || 20;

  if (!name) { showToast('Drug name is required.', 'warning'); return; }

  try {
    await apiFetch('/api/drugs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        name,
        brand,
        quantity:            qty,
        expiry_date:         expiry,
        price_per_unit:      price,
        low_stock_threshold: threshold,
      }),
    });
    closeModal();
    showToast(`${name} added to inventory.`, 'success');
    App.cache.drugs = null;
    renderInventory();
  } catch (err) {
    showToast(`Failed to add drug: ${err.message}`, 'error');
  }
}


// ---------------------------------------------------------------------------
// Edit drug modal
// ---------------------------------------------------------------------------

/**
 * Open the Edit Drug modal pre-populated with the drug's current values.
 *
 * Only master data is editable here (name, brand, price, threshold).
 * Stock and expiry changes must go through the Restock modal.
 *
 * @param {number} drugId    Drug primary key.
 * @param {string} name      Current drug name.
 * @param {string} brand     Current brand name.
 * @param {number} price     Current price per unit.
 * @param {number} threshold Current low stock alert threshold.
 */
function openEditDrugModal(drugId, name, brand, price, threshold) {
  openModal(`
    <div class="modal-header">
      <div class="modal-title" style="display: flex; align-items: center; gap: 8px">
        <i data-lucide="pencil" style="width: 13px; height: 13px"></i>
        Edit Drug
      </div>
      <button class="modal-close">&#x2715;</button>
    </div>

    <div class="alert alert-info" style="margin-bottom: 16px; font-size: 12.5px">
      Updates name, brand, price, and the low stock alert threshold.<br>
      To change stock levels or expiry dates, use the
      <strong>Restock</strong> button to add a new batch.
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label">Drug Name *</label>
        <input class="form-input" id="edit-name" value="${_escHtml(name)}" />
      </div>
      <div class="form-group">
        <label class="form-label">Brand</label>
        <input class="form-input" id="edit-brand" value="${_escHtml(brand)}" />
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label">Price / Unit ($)</label>
        <input class="form-input" id="edit-price" type="number" min="0" step="0.01" value="${price}" />
      </div>
      <div class="form-group">
        <label class="form-label">Low Stock Alert Threshold</label>
        <input class="form-input" id="edit-threshold" type="number" min="1" value="${threshold}" />
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitEditDrug(${drugId})">Save Changes</button>
    </div>
  `);
  setTimeout(renderIcons, 50);
}

/**
 * Read the Edit Drug form values and submit the API request.
 *
 * @param {number} drugId  Drug primary key.
 */
async function submitEditDrug(drugId) {
  const name      = document.getElementById('edit-name')?.value.trim();
  const brand     = document.getElementById('edit-brand')?.value.trim()      || '';
  const price     = parseFloat(document.getElementById('edit-price')?.value)  || 0;
  const threshold = parseInt(document.getElementById('edit-threshold')?.value) || 20;

  if (!name) { showToast('Drug name is required.', 'warning'); return; }

  try {
    await apiFetch(`/api/drugs/${drugId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        name,
        brand,
        price_per_unit:      price,
        low_stock_threshold: threshold,
      }),
    });
    closeModal();
    showToast(`${name} updated successfully.`, 'success');
    App.cache.drugs = null;
    renderInventory();
  } catch (err) {
    showToast(`Update failed: ${err.message}`, 'error');
  }
}


// ---------------------------------------------------------------------------
// Restock modal
// ---------------------------------------------------------------------------

/**
 * Open the Restock modal for adding a new batch to a drug.
 *
 * Expiry date is required — every new batch must carry an expiry date
 * so the FIFO algorithm can order batches correctly.
 *
 * @param {number} drugId      Drug primary key.
 * @param {string} name        Drug name (displayed in modal title).
 * @param {number} currentQty  Current total stock (displayed as context).
 */
function openRestockModal(drugId, name, currentQty) {
  openModal(`
    <div class="modal-header">
      <div class="modal-title" style="display: flex; align-items: center; gap: 8px">
        <i data-lucide="package" style="width: 15px; height: 15px"></i>
        Add Stock Batch &mdash; ${name}
      </div>
      <button class="modal-close">&#x2715;</button>
    </div>

    <div class="alert alert-info" style="margin-bottom: 16px; font-size: 12.5px">
      Current total stock: <strong>${currentQty} units</strong><br>
      Each restock creates a new batch. Stock is sold FIFO (oldest expiry first).
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label">Quantity *</label>
        <input class="form-input" id="restock-qty" type="number" min="1" placeholder="e.g. 100" />
      </div>
      <div class="form-group">
        <label class="form-label">Expiry Date *</label>
        <input class="form-input" id="restock-expiry" type="date" />
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label">Supplier</label>
        <input class="form-input" id="restock-supplier" placeholder="e.g. MedCo Pharma" />
      </div>
      <div class="form-group">
        <label class="form-label">Batch Note</label>
        <input class="form-input" id="restock-note" placeholder="e.g. Lot #ABC123" />
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitRestock(${drugId}, '${_escHtml(name)}')">
        Add Batch
      </button>
    </div>
  `);
  document.getElementById('restock-qty')?.focus();
}

/**
 * Read the Restock form values and submit the API request.
 *
 * @param {number} drugId  Drug primary key.
 * @param {string} name    Drug name (used in success toast).
 */
async function submitRestock(drugId, name) {
  const qty      = parseInt(document.getElementById('restock-qty')?.value)     || 0;
  const expiry   = document.getElementById('restock-expiry')?.value            || '';
  const supplier = document.getElementById('restock-supplier')?.value.trim()   || '';
  const note     = document.getElementById('restock-note')?.value.trim()       || '';

  if (qty <= 0) { showToast('Enter a positive quantity.',   'warning'); return; }
  if (!expiry)  { showToast('Expiry date is required.',     'warning'); return; }

  try {
    await apiFetch(`/api/drugs/${drugId}/restock`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        quantity_added: qty,
        expiry_date:    expiry,
        supplier,
        batch_note:     note,
      }),
    });
    closeModal();
    showToast(`New batch of ${qty} units added for ${name}.`, 'success');
    App.cache.drugs = null;
    renderInventory();
  } catch (err) {
    showToast(`Restock failed: ${err.message}`, 'error');
  }
}


// ---------------------------------------------------------------------------
// Delete drug modal
// ---------------------------------------------------------------------------

/**
 * Open a confirmation modal before deleting a drug.
 *
 * The API will reject the deletion if the drug has any sales records.
 * The modal notes this to set expectations before the user clicks Delete.
 *
 * @param {number} drugId  Drug primary key.
 * @param {string} name    Drug name (displayed in confirmation message).
 */
function openDeleteModal(drugId, name) {
  openModal(`
    <div class="modal-header">
      <div class="modal-title" style="display: flex; align-items: center; gap: 8px">
        <i data-lucide="trash-2" style="width: 14px; height: 14px"></i>
        Delete Drug
      </div>
      <button class="modal-close">&#x2715;</button>
    </div>
    <div class="alert alert-danger" style="margin-bottom: 16px">
      <strong>This cannot be undone.</strong>
      Delete <strong>${name}</strong> and all its batches from inventory?<br>
      <span class="text-sm">
        Deletion is blocked if the drug has any sales history.
      </span>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="submitDelete(${drugId}, '${_escHtml(name)}')">
        Delete
      </button>
    </div>
  `);
  setTimeout(renderIcons, 50);
}

/**
 * Submit the drug deletion API request.
 *
 * @param {number} drugId  Drug primary key.
 * @param {string} name    Drug name (used in success/error toast).
 */
async function submitDelete(drugId, name) {
  try {
    await apiFetch(`/api/drugs/${drugId}`, { method: 'DELETE' });
    closeModal();
    showToast(`${name} deleted from inventory.`, 'success');
    App.cache.drugs = null;
    renderInventory();
  } catch (err) {
    closeModal();
    showToast(`Delete failed: ${err.message}`, 'error');
  }
}


// Settings and reset moved to the global Settings panel (gear icon in nav bar)


// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe use as an HTML attribute value or
 * inside a JavaScript string literal within an inline onclick handler.
 *
 * Escapes backslashes first to prevent double-escaping, then single
 * quotes (which would break the onclick string delimiter), then
 * double quotes (which would break the attribute value delimiter).
 *
 * @param {string} str  Raw string from user data (e.g. a drug name).
 * @returns {string}    Escaped string safe for inline HTML use.
 */
function _escHtml(str) {
  return String(str)
    .replace(/\\/g,  '\\\\')
    .replace(/'/g,   "\\'")
    .replace(/"/g,   '&quot;');
}


// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/*
 * openAddDrugModal is called from dashboard.js via the Quick Actions panel
 * after navigating to the inventory page. It must be on window so the
 * dashboard module can access it without a direct import.
 */
window.openAddDrugModal = openAddDrugModal;

/*
 * openRestockModal and confirmWriteoff are called from dashboard.js
 * alert action buttons after navigating to the inventory page.
 */
window.openRestockModal  = openRestockModal;
window.confirmWriteoff   = confirmWriteoff;

// Auto-exports — functions called from inline HTML handlers
window.downloadBulkTemplate = downloadBulkTemplate;
window.exportInventoryCSV = exportInventoryCSV;
window.filterInventory = filterInventory;
window.openBulkRestockModal = openBulkRestockModal;
window.openDeleteModal = openDeleteModal;
window.openEditDrugModal = openEditDrugModal;
window.parseBulkCSV = parseBulkCSV;
window.submitAddDrug = submitAddDrug;
window.submitBulkRestock = submitBulkRestock;
window.submitDelete = submitDelete;
window.submitDeleteBatch = submitDeleteBatch;
window.submitEditDrug = submitEditDrug;
window.submitRestock = submitRestock;
window.submitWriteoff = submitWriteoff;
window.toggleBatches = toggleBatches;
window.toggleDepletedBatches = toggleDepletedBatches;
window.toggleTimelineDetails = toggleTimelineDetails;
