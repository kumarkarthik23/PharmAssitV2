/**
 * prescriptions.js
 * ================
 * Prescription scanning and dispensing flow for PharmAssist V2.
 *
 * Four-step workflow
 * ------------------
 * Step 1 — Upload      Drop/select image. Duplicate detection via file hash.
 *                      "Enter Manually" fallback always visible.
 * Step 2 — Review      Gemini extracts medicines. Edit Medicines modal lets
 *                      the pharmacist correct names/frequencies/durations.
 *                      Prescription image stays visible.
 * Step 3 — Dispense    Availability check with fuzzy match warnings, inline
 *                      qty over-stock validation, "Add to Inventory & Return"
 *                      on not-found rows, Cancel button. Image still visible.
 * Step 4 — Receipt     Sale complete card shows per-item dispensed/failed,
 *                      grand total, failed-item callout, Print Receipt button.
 *
 * State
 * -----
 * _rxState    — current prescription flow data
 * _pendingReturn — true when pharmacist left to add a drug to inventory
 *
 * Both are exposed on window so history.js can set them for Resume flow.
 */

'use strict';


// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const _rxState = {
  prescriptionId: null,
  medicines:      [],
  imageB64:       null,
  checkResults:   [],
  saleResults:    [],
  step:           'upload',
  fileHash:       null,
};

let _selectedFile  = null;
let _pendingReturn = false;


// ---------------------------------------------------------------------------
// Page entry point
// ---------------------------------------------------------------------------

function renderPrescriptions() {
  // Resume after adding a drug to inventory
  if (_pendingReturn) {
    _pendingReturn = false;
    _resumeAfterInventoryAdd();
    return;
  }

  // Resume from history (history.js sets step='results')
  if (_rxState.step === 'results' && _rxState.medicines.length > 0) {
    const container = document.getElementById('page-prescriptions');
    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Prescriptions</div>
          <div class="page-subtitle">Upload a handwritten prescription — AI extracts the drug list automatically</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="openManualEntryModal()">
          <i data-lucide="keyboard" style="width:14px;height:14px"></i> Enter Manually
        </button>
      </div>
      <div class="alert alert-info" style="margin-bottom:16px;display:flex;align-items:center;gap:10px">
        <i data-lucide="rotate-ccw" style="width:14px;height:14px;flex-shrink:0"></i>
        <div>
          <strong>Resumed prescription #${_rxState.prescriptionId}</strong>
          &mdash; ${_rxState.medicines.length} drug${_rxState.medicines.length !== 1 ? 's' : ''} loaded.
          Review and check stock availability.
        </div>
      </div>
      <div id="rx-body"></div>`;
    renderExtractionResults();
    setTimeout(renderIcons, 100);
    return;
  }

  // Fresh start
  _rxState.prescriptionId = null;
  _rxState.medicines      = [];
  _rxState.imageB64       = null;
  _rxState.checkResults   = [];
  _rxState.saleResults    = [];
  _rxState.step           = 'upload';
  _rxState.fileHash       = null;
  _selectedFile           = null;

  const container = document.getElementById('page-prescriptions');
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Prescriptions</div>
        <div class="page-subtitle">Upload a handwritten prescription — AI extracts the drug list automatically</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="openManualEntryModal()">
        <i data-lucide="keyboard" style="width:14px;height:14px"></i> Enter Manually
      </button>
    </div>
    <div id="rx-body">${_buildUploadStep()}</div>`;
  setTimeout(renderIcons, 100);
}


// ---------------------------------------------------------------------------
// Step 1 — Upload
// ---------------------------------------------------------------------------

function _buildUploadStep() {
  return `
    <div class="section-row cols-1-2">
      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;gap:8px">
          <i data-lucide="file-scan" style="width:16px;height:16px;color:var(--blue-mid)"></i>
          Upload Prescription
        </div>
        <div class="upload-zone" id="upload-zone">
          <input type="file" id="rx-file-input" accept="image/jpeg,image/png,image/webp" />
          <div class="upload-icon">
            <i data-lucide="image-plus" style="width:36px;height:36px;color:var(--blue-mid);opacity:0.5"></i>
          </div>
          <div class="upload-label">Drop image here or click to browse</div>
          <div class="upload-hint">JPEG, PNG, or WebP &middot; Handwritten prescriptions supported</div>
        </div>
        <div id="upload-status" class="mt-8"></div>
        <div id="duplicate-warning"></div>
        <div class="mt-16">
          <button class="btn btn-primary btn-full" id="extract-btn" disabled>
            <i data-lucide="sparkles" style="width:14px;height:14px"></i>
            Extract with AI
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;gap:8px">
          <i data-lucide="info" style="width:16px;height:16px;color:var(--blue-mid)"></i>
          How It Works
        </div>
        <div style="display:flex;flex-direction:column;gap:16px;color:var(--text-secondary);font-size:13.5px">
          ${_howStep('camera',       'var(--blue-light)', 'var(--blue-mid)', '1. Upload',      'Photo or scan of the prescription')}
          ${_howStep('sparkles',     'var(--purple-bg)',  'var(--purple)',   '2. AI Reads',    'Gemini Vision extracts drugs, dosing, and duration')}
          ${_howStep('search',       'var(--yellow-bg)',  'var(--yellow)',   '3. Check Stock', 'Each drug matched to inventory with fuzzy matching')}
          ${_howStep('check-circle', 'var(--green-bg)',   'var(--green)',    '4. Dispense',    'Select drugs to sell — stock deducted automatically')}
        </div>
      </div>
    </div>`;
}

function _howStep(icon, bg, color, title, desc) {
  return `
    <div class="flex-center">
      <div style="width:36px;height:36px;border-radius:8px;background:${bg};
                  display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i data-lucide="${icon}" style="width:18px;height:18px;color:${color}"></i>
      </div>
      <div>
        <strong style="color:var(--text-primary)">${title}</strong><br>${desc}
      </div>
    </div>`;
}


// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const page = document.getElementById('page-prescriptions');

  page.addEventListener('change', e => {
    if (e.target.id === 'rx-file-input') _handleFileSelect(e.target.files[0]);
  });

  page.addEventListener('click', e => {
    const id = e.target.closest('[id]')?.id || e.target.id;
    if (id === 'extract-btn')             handleExtract();
    if (id === 'check-btn')               handleCheckAvailability();
    if (id === 'confirm-sale-btn')        handleConfirmSale();
    if (id === 'edit-medicines-btn')      openEditMedicinesModal();
    if (id === 'cancel-prescription-btn') handleCancelPrescription();
    if (id === 'print-receipt-btn')       printReceipt();
    if (id === 'start-over-btn')          renderPrescriptions();
  });

  page.addEventListener('input', e => {
    if (e.target.classList.contains('qty-input')) _validateQtyInput(e.target);
  });

  page.addEventListener('dragover', e => {
    const zone = document.getElementById('upload-zone');
    if (zone) { e.preventDefault(); zone.classList.add('drag-over'); }
  });

  page.addEventListener('drop', e => {
    e.preventDefault();
    const zone = document.getElementById('upload-zone');
    if (!zone) return;
    zone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) _handleFileSelect(file);
  });
});


// ---------------------------------------------------------------------------
// File select + duplicate detection
// ---------------------------------------------------------------------------

async function _handleFileSelect(file) {
  if (!file) return;
  _selectedFile     = file;
  _rxState.fileHash = `${file.name}-${file.size}-${file.lastModified}`;

  const status = document.getElementById('upload-status');
  if (status) {
    status.innerHTML = `
      <div class="flex-center">
        <span class="badge badge-info">${file.name}</span>
        <span class="text-muted text-sm">${(file.size / 1024).toFixed(1)} KB</span>
      </div>`;
  }

  const btn = document.getElementById('extract-btn');
  if (btn) btn.disabled = false;

  // Duplicate detection
  const dupEl = document.getElementById('duplicate-warning');
  if (dupEl) {
    try {
      const history = await apiFetch('/api/history?limit=20');
      const isDupe  = history.some(r => r.notes && r.notes.includes(_rxState.fileHash));
      dupEl.innerHTML = isDupe ? `
        <div class="alert alert-warning mt-8">
          <i data-lucide="alert-triangle" style="width:13px;height:13px"></i>
          <strong>Possible duplicate</strong> — this file appears to have been processed recently.
          You can still proceed if intentional.
        </div>` : '';
      if (isDupe) setTimeout(renderIcons, 50);
    } catch { dupEl.innerHTML = ''; }
  }
}


// ---------------------------------------------------------------------------
// Step 2 — Extract
// ---------------------------------------------------------------------------

async function handleExtract() {
  if (!_selectedFile) return;

  const rxBody = document.getElementById('rx-body');
  rxBody.innerHTML = loadingHTML('Sending to Gemini Vision&hellip; this may take 5&ndash;10 seconds');

  const formData = new FormData();
  formData.append('file', _selectedFile);

  try {
    const data = await apiFetch('/api/prescriptions/extract', { method:'POST', body:formData });

    _rxState.prescriptionId = data.prescription_id;
    _rxState.medicines      = data.medicines;
    _rxState.imageB64       = data.image_b64;
    _rxState.step           = 'results';

    // Save file hash for duplicate detection
    if (_rxState.fileHash) {
      apiFetch(`/api/prescriptions/${data.prescription_id}/notes`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ notes: _rxState.fileHash }),
      }).catch(() => null);
    }

    renderExtractionResults();
    setTimeout(renderIcons, 100);

  } catch (err) {
    rxBody.innerHTML = _buildExtractionError(err);
    setTimeout(renderIcons, 100);
  }
}

function _buildExtractionError(err) {
  const isQuota = err.status===429 || err.message.includes('quota') || err.message.includes('RESOURCE_EXHAUSTED');
  const is503   = err.status===503 || err.message.includes('503');

  if (isQuota) return `
    <div class="card" style="text-align:center;padding:48px 32px">
      <i data-lucide="wallet" style="width:48px;height:48px;color:var(--yellow)"></i>
      <div style="font-size:20px;font-weight:800;margin:16px 0 8px">Oops. The AI is on a budget.</div>
      <div style="font-size:14px;color:var(--text-secondary);margin-bottom:24px">
        Gemini free tier quota exhausted. Resets daily at midnight Pacific Time.
      </div>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="openManualEntryModal()">
          <i data-lucide="keyboard" style="width:13px;height:13px"></i> Enter Manually
        </button>
        <button class="btn btn-ghost" id="start-over-btn">
          <i data-lucide="arrow-left" style="width:13px;height:13px"></i> Try Another Image
        </button>
      </div>
    </div>`;

  if (is503) return `
    <div class="card" style="text-align:center;padding:48px 32px">
      <i data-lucide="cloud-off" style="width:40px;height:40px;color:var(--text-muted)"></i>
      <div style="font-size:18px;font-weight:800;margin:16px 0 8px">Gemini temporarily unavailable</div>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="start-over-btn">
          <i data-lucide="refresh-cw" style="width:13px;height:13px"></i> Try Again
        </button>
        <button class="btn btn-ghost" onclick="openManualEntryModal()">
          <i data-lucide="keyboard" style="width:13px;height:13px"></i> Enter Manually
        </button>
      </div>
    </div>`;

  return `
    <div class="card" style="text-align:center;padding:40px 32px">
      <i data-lucide="alert-circle" style="width:40px;height:40px;color:var(--red)"></i>
      <div style="font-size:18px;font-weight:700;margin:14px 0 8px">Extraction failed</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:24px">${err.message}</div>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-secondary" id="start-over-btn">
          <i data-lucide="arrow-left" style="width:13px;height:13px"></i> Try Again
        </button>
        <button class="btn btn-ghost" onclick="openManualEntryModal()">
          <i data-lucide="keyboard" style="width:13px;height:13px"></i> Enter Manually
        </button>
      </div>
    </div>`;
}


// ---------------------------------------------------------------------------
// Step 2 — Render extraction results
// ---------------------------------------------------------------------------

function renderExtractionResults() {
  const rxBody = document.getElementById('rx-body');
  const meds   = _rxState.medicines;

  const rows = meds.map((m, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${m.drug_name || '—'}</strong></td>
      <td>${m.frequency != null ? `${m.frequency}/day` : '<span class="text-muted">—</span>'}</td>
      <td>${m.duration   != null ? `${m.duration} days` : '<span class="text-muted">—</span>'}</td>
      <td><strong>${m.required_quantity != null ? m.required_quantity : '—'}</strong></td>
    </tr>`).join('');

  const imagePanel = _rxState.imageB64 ? `
    <div class="rx-image-box" style="margin-bottom:16px">
      <img src="data:image/jpeg;base64,${_rxState.imageB64}" alt="Prescription"
        style="width:100%;border-radius:var(--radius-sm);display:block" />
    </div>` : '';

  rxBody.innerHTML = `
    <div class="section-row cols-1-2">
      <div>
        ${imagePanel}
        <div class="card" style="padding:12px 14px;font-size:12.5px;color:var(--text-secondary)">
          <i data-lucide="info" style="width:13px;height:13px"></i>
          Review the list carefully. Use <strong>Edit Medicines</strong> to correct misreads
          before checking stock.
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;gap:8px">
          <i data-lucide="check-circle" style="width:15px;height:15px;color:var(--green)"></i>
          Extraction Complete &mdash;
          ${meds.length} medicine${meds.length !== 1 ? 's' : ''} found
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Drug Name</th><th>Frequency</th><th>Duration</th><th>Qty Needed</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>

        <div class="flex mt-16 gap-8" style="justify-content:flex-end">
          <button class="btn btn-ghost" id="start-over-btn">
            <i data-lucide="arrow-left" style="width:13px;height:13px"></i> Rescan
          </button>
          <button class="btn btn-secondary" id="edit-medicines-btn">
            <i data-lucide="pencil" style="width:13px;height:13px"></i> Edit Medicines
          </button>
          <button class="btn btn-primary" id="check-btn">
            Check Stock Availability
            <i data-lucide="arrow-right" style="width:13px;height:13px"></i>
          </button>
        </div>
      </div>
    </div>`;
}


// ---------------------------------------------------------------------------
// Edit medicines modal
// ---------------------------------------------------------------------------

function openEditMedicinesModal() {
  openModal(`
    <div class="modal-header">
      <div class="modal-title" style="display:flex;align-items:center;gap:8px">
        <i data-lucide="pencil" style="width:14px;height:14px"></i> Edit Medicines
      </div>
      <button class="modal-close">&#x2715;</button>
    </div>
    <div class="alert alert-info" style="margin-bottom:14px;font-size:12.5px">
      Correct any names, frequencies, or durations Gemini misread.
      Qty Needed = Frequency &times; Duration.
    </div>
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;margin-bottom:6px">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted)">Drug Name</span>
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted)">Freq/day</span>
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted)">Days</span>
      <span></span>
    </div>
    <div id="edit-med-rows">${_buildEditRows(_rxState.medicines)}</div>
    <button class="btn btn-ghost btn-sm mt-8" onclick="addEditRow()">
      <i data-lucide="plus" style="width:13px;height:13px"></i> Add Row
    </button>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Discard</button>
      <button class="btn btn-primary" onclick="saveEditedMedicines()">
        <i data-lucide="check" style="width:13px;height:13px"></i> Save &amp; Continue
      </button>
    </div>
  `);
  setTimeout(renderIcons, 50);
}

function _buildEditRows(meds) {
  if (!meds.length) return '<div class="text-muted text-sm" style="padding:8px 0">No medicines — add a row below.</div>';
  return meds.map((m, i) => `
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;align-items:center;margin-bottom:8px">
      <input class="form-input" id="ed-name-${i}" value="${m.drug_name||''}" placeholder="Drug name"/>
      <input class="form-input" id="ed-freq-${i}" type="number" min="1" value="${m.frequency||''}" placeholder="2"/>
      <input class="form-input" id="ed-dur-${i}"  type="number" min="1" value="${m.duration||''}"  placeholder="5"/>
      <button class="btn btn-ghost btn-sm" style="padding:6px 8px" onclick="removeEditRow(${i})">
        <i data-lucide="trash-2" style="width:13px;height:13px"></i>
      </button>
    </div>`).join('');
}

function addEditRow() {
  _rxState.medicines.push({ drug_name:'', frequency:null, duration:null, required_quantity:null });
  const c = document.getElementById('edit-med-rows');
  if (c) { c.innerHTML = _buildEditRows(_rxState.medicines); setTimeout(renderIcons, 50); }
}

function removeEditRow(index) {
  _rxState.medicines.splice(index, 1);
  const c = document.getElementById('edit-med-rows');
  if (c) { c.innerHTML = _buildEditRows(_rxState.medicines); setTimeout(renderIcons, 50); }
}

function saveEditedMedicines() {
  const updated = [];
  _rxState.medicines.forEach((_, i) => {
    const name = document.getElementById(`ed-name-${i}`)?.value.trim();
    const freq = parseInt(document.getElementById(`ed-freq-${i}`)?.value);
    const dur  = parseInt(document.getElementById(`ed-dur-${i}`)?.value);
    if (!name) return;
    updated.push({ drug_name:name, frequency:isNaN(freq)?null:freq, duration:isNaN(dur)?null:dur,
                   required_quantity:(!isNaN(freq)&&!isNaN(dur))?freq*dur:null });
  });
  if (!updated.length) { showToast('Add at least one medicine.', 'warning'); return; }
  _rxState.medicines = updated;
  closeModal();
  renderExtractionResults();
  setTimeout(renderIcons, 100);
  showToast('Medicines updated.', 'success');
}


// ---------------------------------------------------------------------------
// Manual entry fallback
// ---------------------------------------------------------------------------

function openManualEntryModal() {
  _rxState.medicines = [{ drug_name:'', frequency:null, duration:null, required_quantity:null }];
  openModal(`
    <div class="modal-header">
      <div class="modal-title" style="display:flex;align-items:center;gap:8px">
        <i data-lucide="keyboard" style="width:14px;height:14px"></i> Enter Prescription Manually
      </div>
      <button class="modal-close">&#x2715;</button>
    </div>
    <div class="alert alert-info" style="margin-bottom:14px;font-size:12.5px">
      Enter each drug exactly as written. Fuzzy matching will find the closest inventory match.
    </div>
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;margin-bottom:6px">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted)">Drug Name</span>
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted)">Freq/day</span>
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted)">Days</span>
      <span></span>
    </div>
    <div id="edit-med-rows">${_buildEditRows(_rxState.medicines)}</div>
    <button class="btn btn-ghost btn-sm mt-8" onclick="addEditRow()">
      <i data-lucide="plus" style="width:13px;height:13px"></i> Add Drug
    </button>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveManualEntry()">
        <i data-lucide="arrow-right" style="width:13px;height:13px"></i> Check Availability
      </button>
    </div>
  `);
  setTimeout(renderIcons, 50);
}

async function saveManualEntry() {
  const updated = [];
  _rxState.medicines.forEach((_, i) => {
    const name = document.getElementById(`ed-name-${i}`)?.value.trim();
    const freq = parseInt(document.getElementById(`ed-freq-${i}`)?.value);
    const dur  = parseInt(document.getElementById(`ed-dur-${i}`)?.value);
    if (!name) return;
    updated.push({ drug_name:name, frequency:isNaN(freq)?null:freq, duration:isNaN(dur)?null:dur,
                   required_quantity:(!isNaN(freq)&&!isNaN(dur))?freq*dur:null });
  });
  if (!updated.length) { showToast('Add at least one drug.', 'warning'); return; }
  _rxState.medicines = updated;
  _rxState.step      = 'results';
  try {
    const resp = await apiFetch('/api/prescriptions/manual', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ medicines: updated }),
    });
    _rxState.prescriptionId = resp.prescription_id;
  } catch { /* non-critical */ }
  closeModal();
  renderExtractionResults();
  setTimeout(renderIcons, 100);
}


// ---------------------------------------------------------------------------
// Step 3 — Availability check
// ---------------------------------------------------------------------------

async function handleCheckAvailability() {
  const rxBody = document.getElementById('rx-body');
  rxBody.innerHTML = loadingHTML('Checking inventory&hellip;');

  try {
    const results = await apiFetch('/api/prescriptions/check', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(_rxState.medicines),
    });
    _rxState.checkResults = results;
    _rxState.step         = 'confirm';
    renderAvailabilityResults(results);
    setTimeout(renderIcons, 100);
  } catch (err) {
    rxBody.innerHTML = `
      <div class="card">
        <div class="alert alert-danger">Stock check failed: ${err.message}</div>
        <button class="btn btn-secondary mt-16" id="start-over-btn">
          <i data-lucide="arrow-left" style="width:13px;height:13px"></i> Start Over
        </button>
      </div>`;
  }
}

function _validateQtyInput(input) {
  const max  = parseInt(input.max) || 0;
  const val  = parseInt(input.value) || 0;
  const warn = input.parentElement.querySelector('.qty-warning');
  if (val > max && max > 0) {
    input.style.borderColor = 'var(--red)';
    if (!warn) {
      const s = document.createElement('span');
      s.className = 'qty-warning text-sm';
      s.style.cssText = 'color:var(--red);display:block;margin-top:3px';
      s.textContent = `Max available: ${max}`;
      input.parentElement.appendChild(s);
    }
  } else { input.style.borderColor = ''; if (warn) warn.remove(); }
}

function renderAvailabilityResults(results) {
  const rxBody = document.getElementById('rx-body');

  const sufficientCount   = results.filter(r => r.status === 'sufficient').length;
  const insufficientCount = results.filter(r => r.status === 'insufficient').length;
  const notFoundCount     = results.filter(r => r.status === 'not_found').length;

  const rows = results.map((result, index) => {
    const drug    = result.drug;
    const canSell = result.found;
    const defQty  = Math.min(result.required_quantity || 0, drug?.quantity || 0);
    const rowClass = result.status === 'sufficient' ? 'row-sufficient' :
                     result.status === 'insufficient' ? 'row-insufficient' : 'row-not-found';

    // Fuzzy match warning — show original vs matched
    const fuzzyTag = result.fuzzy_match ? `
      <div style="font-size:11px;color:var(--purple);margin-top:3px;display:flex;align-items:center;gap:4px">
        <i data-lucide="shuffle" style="width:11px;height:11px"></i>
        Fuzzy match for &ldquo;${result.drug_name}&rdquo;
      </div>` : '';

    // Add to Inventory shortcut for not-found drugs
    const addAction = !result.found ? `
      <div style="margin-top:4px">
        <button class="btn btn-sm btn-ghost" style="font-size:11px;padding:3px 8px"
          onclick="navigateToInventoryAndReturn('${(result.drug_name||'').replace(/'/g,"\\'")}')">
          <i data-lucide="plus-circle" style="width:11px;height:11px"></i>
          Add to Inventory &amp; Return
        </button>
      </div>` : '';

    return `
      <tr class="${rowClass}" data-index="${index}">
        <td>
          <input type="checkbox" class="sale-checkbox" data-index="${index}"
            ${canSell ? '' : 'disabled'}
            ${result.status === 'sufficient' ? 'checked' : ''} />
        </td>
        <td><strong>${result.drug_name}</strong></td>
        <td>
          ${drug ? `<strong>${drug.name}</strong>` : '<span class="text-muted">Not found</span>'}
          ${fuzzyTag}${addAction}
        </td>
        <td>${result.required_quantity ?? '—'}</td>
        <td>${drug ? stockBadge(drug.quantity, drug.low_stock_threshold) : '<span class="badge badge-danger">—</span>'}</td>
        <td>
          ${canSell ? `
            <div>
              <input type="number" class="qty-input" data-index="${index}"
                value="${defQty}" min="1" max="${drug?.quantity || 999}" />
            </div>` : '—'}
        </td>
        <td>${_statusBadge(result.status)}</td>
      </tr>`;
  }).join('');

  const imagePanel = _rxState.imageB64 ? `
    <div class="rx-image-box" style="margin-bottom:16px">
      <img src="data:image/jpeg;base64,${_rxState.imageB64}" alt="Prescription"
        style="width:100%;border-radius:var(--radius-sm);display:block" />
    </div>` : '';

  rxBody.innerHTML = `
    <div class="section-row cols-1-2">
      <div>${imagePanel}</div>

      <div class="card">
        <div class="page-header" style="margin-bottom:14px">
          <div class="card-title" style="margin:0;display:flex;align-items:center;gap:8px">
            <i data-lucide="package" style="width:15px;height:15px"></i>
            Availability Check
          </div>
          <div class="flex-center gap-8">
            <span class="badge badge-success">
              <i data-lucide="check" style="width:10px;height:10px"></i>
              ${sufficientCount} available
            </span>
            ${insufficientCount ? `
              <span class="badge badge-warning">
                <i data-lucide="alert-triangle" style="width:10px;height:10px"></i>
                ${insufficientCount} low
              </span>` : ''}
            ${notFoundCount ? `
              <span class="badge badge-danger">
                <i data-lucide="x-circle" style="width:10px;height:10px"></i>
                ${notFoundCount} not found
              </span>` : ''}
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Sell?</th><th>Prescribed</th><th>Matched Drug</th>
                <th>Qty Needed</th><th>In Stock</th><th>Sell Qty</th><th>Status</th>
              </tr>
            </thead>
            <tbody id="availability-tbody">${rows}</tbody>
          </table>
        </div>

        <div class="flex mt-16 gap-8" style="justify-content:flex-end">
          <button class="btn btn-ghost" id="start-over-btn">
            <i data-lucide="arrow-left" style="width:13px;height:13px"></i> Rescan
          </button>
          <button class="btn btn-danger" id="cancel-prescription-btn">
            <i data-lucide="x-circle" style="width:14px;height:14px"></i> Cancel
          </button>
          <button class="btn btn-success" id="confirm-sale-btn">
            <i data-lucide="check-circle" style="width:14px;height:14px"></i> Confirm Sale
          </button>
        </div>
      </div>
    </div>`;
}

function _statusBadge(status) {
  if (status === 'sufficient')   return '<span class="badge badge-success">In Stock</span>';
  if (status === 'insufficient') return '<span class="badge badge-warning">Insufficient</span>';
  return '<span class="badge badge-danger">Not Found</span>';
}


// ---------------------------------------------------------------------------
// Cancel prescription
// ---------------------------------------------------------------------------

async function handleCancelPrescription() {
  if (_rxState.prescriptionId) {
    try {
      await apiFetch(`/api/prescriptions/${_rxState.prescriptionId}/cancel`, { method:'POST' });
    } catch { /* non-critical */ }
  }
  showToast('Prescription cancelled.', 'warning');
  renderPrescriptions();
}


// ---------------------------------------------------------------------------
// Navigate to inventory preserving prescription state
// ---------------------------------------------------------------------------

function navigateToInventoryAndReturn(drugName) {
  _pendingReturn = true;
  showToast(`Adding "${drugName}" to inventory — return to Prescriptions when done.`, 'info', 5000);
  navigateTo('inventory');
  setTimeout(() => { if (typeof openAddDrugModal === 'function') openAddDrugModal(drugName); }, 350);
}

async function _resumeAfterInventoryAdd() {
  const container = document.getElementById('page-prescriptions');
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Prescriptions</div>
        <div class="page-subtitle">Upload a handwritten prescription — AI extracts the drug list automatically</div>
      </div>
    </div>
    <div class="alert alert-info" style="margin-bottom:16px;display:flex;align-items:center;gap:10px">
      <i data-lucide="rotate-ccw" style="width:14px;height:14px;flex-shrink:0"></i>
      <div><strong>Resuming prescription</strong> — re-checking availability with updated inventory&hellip;</div>
    </div>
    <div id="rx-body">${loadingHTML('Re-checking stock availability…')}</div>`;
  setTimeout(renderIcons, 50);

  try {
    const results = await apiFetch('/api/prescriptions/check', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(_rxState.medicines),
    });
    _rxState.checkResults = results;
    _rxState.step         = 'confirm';
    container.querySelector('.alert-info')?.remove();
    renderAvailabilityResults(results);
    setTimeout(renderIcons, 100);
    const found = results.filter(r => r.status === 'sufficient' || r.status === 'insufficient').length;
    showToast(`Prescription resumed — ${found} drug${found !== 1 ? 's' : ''} matched.`, 'success', 4000);
  } catch (err) {
    const rxBody = document.getElementById('rx-body');
    if (rxBody) rxBody.innerHTML = `
      <div class="card">
        <div class="alert alert-danger">Re-check failed: ${err.message}</div>
        <div class="flex mt-16 gap-8">
          <button class="btn btn-secondary" onclick="_pendingReturn=false; renderPrescriptions()">
            <i data-lucide="arrow-left" style="width:13px;height:13px"></i> Start Over
          </button>
          <button class="btn btn-primary" onclick="_pendingReturn=true; renderPrescriptions()">
            <i data-lucide="refresh-cw" style="width:13px;height:13px"></i> Retry
          </button>
        </div>
      </div>`;
  }
}


// ---------------------------------------------------------------------------
// Step 4 — Confirm sale
// ---------------------------------------------------------------------------

async function handleConfirmSale() {
  const tbody = document.getElementById('availability-tbody');
  if (!tbody) return;

  // Inline over-stock validation
  let hasOverStock = false;
  tbody.querySelectorAll('.qty-input').forEach(input => {
    const max = parseInt(input.max) || 0;
    const val = parseInt(input.value) || 0;
    if (val > max && max > 0) { hasOverStock = true; _validateQtyInput(input); }
  });
  if (hasOverStock) {
    showToast('One or more quantities exceed available stock. Please correct first.', 'warning', 5000);
    return;
  }

  const items = [];
  tbody.querySelectorAll('.sale-checkbox:checked').forEach(cb => {
    const index  = parseInt(cb.dataset.index);
    const result = _rxState.checkResults[index];
    const drug   = result?.drug;
    if (!drug) return;
    const qtyInput = tbody.querySelector(`.qty-input[data-index="${index}"]`);
    const quantity = qtyInput ? parseInt(qtyInput.value) || 0 : (result.required_quantity || 0);
    if (quantity <= 0) return;
    items.push({ drug_id: drug.id, drug_name: drug.name, quantity_sold: quantity });
  });

  if (!items.length) { showToast('Select at least one drug to sell.', 'warning'); return; }

  try {
    const saleResult = await apiFetch('/api/sales', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        items,
        prescription_id:  _rxState.prescriptionId,
        total_prescribed: _rxState.medicines.length,
      }),
    });

    _rxState.saleResults = saleResult.results;
    _rxState.step        = 'complete';
    App.cache.dashboard  = null;
    App.cache.drugs      = null;

    const dispensed = saleResult.results.filter(r => r.success);
    const failed    = saleResult.results.filter(r => !r.success);

    if (saleResult.success) {
      showToast(`Sale complete — ${dispensed.length} drug${dispensed.length !== 1 ? 's' : ''} dispensed.`, 'success');
    } else if (saleResult.partial) {
      showToast(`Partial sale — ${dispensed.length} dispensed, ${failed.length} failed (${failed.map(r=>r.drug_name).join(', ')}).`, 'warning', 6000);
    } else {
      showToast(`Sale failed — insufficient stock for all items.`, 'error', 5000);
    }

    document.getElementById('rx-body').innerHTML = buildReceiptCard(
      saleResult.results, saleResult.success, saleResult.partial, _rxState.checkResults
    );
    setTimeout(renderIcons, 100);

  } catch (err) {
    showToast(`Sale failed: ${err.message}`, 'error');
  }
}


// ---------------------------------------------------------------------------
// Receipt card
// ---------------------------------------------------------------------------

function buildReceiptCard(saleResults, allSuccess, isPartial, checkResults) {
  const dispensed = saleResults.filter(r => r.success);
  const failed    = saleResults.filter(r => !r.success);

  const headerIcon  = allSuccess ? 'check-circle'  : isPartial ? 'alert-triangle' : 'x-circle';
  const headerColor = allSuccess ? 'var(--green)'  : isPartial ? 'var(--yellow)'  : 'var(--red)';
  const headerTitle = allSuccess ? 'Sale Complete' : isPartial ? 'Partial Sale'   : 'Sale Failed';
  const headerSub   = allSuccess
    ? `${dispensed.length} drug${dispensed.length !== 1 ? 's' : ''} dispensed successfully`
    : isPartial
      ? `${dispensed.length} dispensed &mdash; ${failed.length} could not be fulfilled`
      : `All ${failed.length} item${failed.length !== 1 ? 's' : ''} failed — insufficient stock`;

  const rows = saleResults.map(r => {
    const check     = (checkResults || []).find(c => c.drug?.id === r.drug_id);
    const price     = check?.drug?.price_per_unit || 0;
    const lineTotal = r.success ? fmtCurrency(r.quantity * price) : '—';
    const rowStyle  = r.success ? '' : 'opacity:0.5;text-decoration:line-through';
    const badge     = r.success
      ? '<span class="badge badge-success"><i data-lucide="check" style="width:10px;height:10px"></i> Dispensed</span>'
      : '<span class="badge badge-danger"><i data-lucide="x" style="width:10px;height:10px"></i> Failed</span>';
    return `
      <tr style="${rowStyle}">
        <td>${r.drug_name}</td>
        <td>${r.quantity}</td>
        <td>${fmtCurrency(price)}</td>
        <td style="font-weight:700">${lineTotal}</td>
        <td>${badge}</td>
      </tr>`;
  }).join('');

  const grandTotal = dispensed.reduce((sum, r) => {
    const check = (checkResults || []).find(c => c.drug?.id === r.drug_id);
    return sum + r.quantity * (check?.drug?.price_per_unit || 0);
  }, 0);

  const failedBlock = failed.length ? `
    <div class="alert alert-${isPartial ? 'warning' : 'danger'} mt-16" style="font-size:12.5px">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <i data-lucide="alert-triangle" style="width:13px;height:13px;flex-shrink:0;margin-top:2px"></i>
        <div>
          <strong>${failed.length} item${failed.length !== 1 ? 's' : ''} could not be dispensed:</strong>
          <div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">
            ${failed.map(r => `
              <div style="display:flex;align-items:center;gap:6px">
                <i data-lucide="x-circle" style="width:11px;height:11px;color:var(--red)"></i>
                <strong>${r.drug_name}</strong> &mdash; ${r.quantity} units requested, insufficient stock
              </div>`).join('')}
          </div>
          <div style="margin-top:8px;color:var(--text-muted)">
            Restock these drugs and process a new prescription for the unfulfilled items.
          </div>
        </div>
      </div>
    </div>` : '';

  return `
    <div class="card" style="max-width:680px;margin:0 auto">
      <div style="text-align:center;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--border)">
        <i data-lucide="${headerIcon}" style="width:44px;height:44px;color:${headerColor}"></i>
        <div style="font-size:20px;font-weight:700;margin-top:10px;color:${headerColor}">${headerTitle}</div>
        <div style="color:var(--text-secondary);font-size:13px;margin-top:4px">${headerSub}</div>
        <div style="color:var(--text-muted);font-size:12px;margin-top:2px">
          ${new Date().toLocaleString('en-US', { dateStyle:'medium', timeStyle:'short' })}
        </div>
      </div>

      <div class="table-wrap" id="receipt-table">
        <table>
          <thead>
            <tr><th>Drug</th><th>Qty</th><th>Unit Price</th><th>Total</th><th>Status</th></tr>
          </thead>
          <tbody>${rows}</tbody>
          ${dispensed.length ? `
          <tfoot>
            <tr style="border-top:2px solid var(--border);background:var(--bg)">
              <td colspan="3" style="padding:12px 16px;font-weight:700;text-transform:uppercase;font-size:12px;letter-spacing:0.4px">
                Grand Total
              </td>
              <td style="padding:12px 16px;font-size:18px;font-weight:800;color:var(--green)">
                ${fmtCurrency(grandTotal)}
              </td>
              <td></td>
            </tr>
          </tfoot>` : ''}
        </table>
      </div>

      ${failedBlock}

      <div class="flex-center mt-16" style="justify-content:center;gap:12px;flex-wrap:wrap">
        ${dispensed.length ? `
          <button class="btn btn-ghost" id="print-receipt-btn">
            <i data-lucide="printer" style="width:14px;height:14px"></i> Print Receipt
          </button>` : ''}
        ${failed.length ? `
          <button class="btn btn-secondary" onclick="navigateTo('inventory')">
            <i data-lucide="package" style="width:14px;height:14px"></i> Restock Missing Drugs
          </button>` : ''}
        <button class="btn btn-primary" id="start-over-btn">
          <i data-lucide="camera" style="width:14px;height:14px"></i> New Prescription
        </button>
      </div>
    </div>`;
}


// ---------------------------------------------------------------------------
// Print receipt
// ---------------------------------------------------------------------------

function printReceipt() {
  const table = document.getElementById('receipt-table');
  if (!table) return;
  const win = window.open('', '_blank', 'width=600,height=500');
  win.document.write(`<!DOCTYPE html><html><head><title>PharmAssist Receipt</title>
    <style>body{font-family:sans-serif;font-size:13px;padding:24px;color:#0D1B2A}
    table{width:100%;border-collapse:collapse}
    th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #E2E8F0}
    th{background:#F0F4F8;font-weight:700;font-size:11px;text-transform:uppercase}
    tfoot td{font-weight:800;font-size:15px;border-top:2px solid #0D1B2A}
    @media print{button{display:none}}</style></head><body>
    <h2>PharmAssist</h2>
    <p>Receipt — ${new Date().toLocaleString('en-US',{dateStyle:'long',timeStyle:'short'})}</p>
    ${table.outerHTML}
    <script>window.onload=()=>{window.print();window.close();}<\/script>
    </body></html>`);
  win.document.close();
}


// ---------------------------------------------------------------------------
// Window exports — accessible from history.js resume flow
// ---------------------------------------------------------------------------

Object.defineProperty(window, '_rxState',      { get: () => _rxState,      set: v => { Object.assign(_rxState, v); } });
Object.defineProperty(window, '_pendingReturn', { get: () => _pendingReturn, set: v => { _pendingReturn = v; } });

window.renderPrescriptions       = renderPrescriptions;
window.openManualEntryModal      = openManualEntryModal;
window.openEditMedicinesModal    = openEditMedicinesModal;
window.addEditRow                = addEditRow;
window.removeEditRow             = removeEditRow;
window.saveEditedMedicines       = saveEditedMedicines;
window.saveManualEntry           = saveManualEntry;
window.handleCancelPrescription  = handleCancelPrescription;
window.navigateToInventoryAndReturn = navigateToInventoryAndReturn;
window.printReceipt              = printReceipt;
