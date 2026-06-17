/**
 * settings.js
 * ===========
 * Global settings panel for PharmAssist V2.
 *
 * Accessible via the gear icon in the nav bar — available from every page.
 * Contains five collapsible sections:
 *
 *   Security     Change PIN (logs out all sessions after save)
 *   Preferences  Default threshold, currency symbol, date format
 *   Data Export  Inventory CSV, Sales CSV
 *   Data Reset   Selective reset with live row counts
 *   About        App version, keyboard shortcuts reference
 *
 * Preferences are persisted in localStorage and applied to app.js
 * formatters at runtime so currency/date changes take effect immediately.
 */

'use strict';




// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Open the settings panel. Renders immediately, fetches reset counts async.
 */
async function openAppSettings() {
  openModal(_buildShell());
  setTimeout(renderIcons, 50);

  // Load reset counts in background — don't block modal open
  try {
    const counts = await apiFetch('/api/reset/counts');
    const el = document.getElementById('settings-reset-body');
    if (el) { el.innerHTML = _buildResetBody(counts); setTimeout(renderIcons, 50); }
  } catch (err) {
    const el = document.getElementById('settings-reset-body');
    if (el) el.innerHTML = `<div class="alert alert-danger" style="font-size:12.5px">Could not load counts: ${err.message}</div>`;
  }
}

/**
 * Build the full modal HTML.
 */
function _buildShell() {
  return `
    <div class="modal-header">
      <div class="modal-title" style="display:flex;align-items:center;gap:8px">
        <i data-lucide="settings" style="width:15px;height:15px"></i>
        Settings
      </div>
      <button class="modal-close">&#x2715;</button>
    </div>

    <div style="display:flex;flex-direction:column">
      ${_section('shield',   'Security',    _securityBody())}
      ${_section('download', 'Data Export', _exportBody())}
      ${_section('trash-2',  'Data Reset',  `<div id="settings-reset-body">${loadingHTML('Loading data counts…')}</div>`)}
      ${_section('info',     'About',       _aboutBody())}
    </div>

    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Close</button>
    </div>
  `;
}

/**
 * Build a collapsible section row.
 */
function _section(icon, title, body) {
  const id = 'sset-' + title.toLowerCase().replace(/\s+/g, '-');
  return `
    <div style="border-bottom:1px solid var(--border);padding:14px 0">
      <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none"
           onclick="toggleSettingsSection('${id}')">
        <div style="display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;color:var(--text-primary)">
          <i data-lucide="${icon}" style="width:14px;height:14px;color:var(--blue-mid)"></i>
          ${title}
        </div>
        <i data-lucide="chevron-down" id="${id}-chev"
           style="width:14px;height:14px;color:var(--text-muted);transition:transform 0.2s"></i>
      </div>
      <div id="${id}" style="margin-top:12px">${body}</div>
    </div>`;
}

/** Toggle a section open/closed. */
function toggleSettingsSection(id) {
  const el   = document.getElementById(id);
  const chev = document.getElementById(id + '-chev');
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display        = open ? 'none' : 'block';
  if (chev) chev.style.transform = open ? 'rotate(-90deg)' : '';
}


// ---------------------------------------------------------------------------
// Security — Change PIN
// ---------------------------------------------------------------------------

function _securityBody() {
  return `
    <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:10px">
      Change your 4-digit PIN. All sessions will be logged out after saving.
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
      <div class="form-group" style="margin:0">
        <label class="form-label">New PIN</label>
        <input class="form-input" id="sset-new-pin" type="password" maxlength="4"
          placeholder="4 digits" oninput="this.value=this.value.replace(/[^0-9]/g,'')" />
      </div>
      <div class="form-group" style="margin:0">
        <label class="form-label">Confirm PIN</label>
        <input class="form-input" id="sset-confirm-pin" type="password" maxlength="4"
          placeholder="Repeat PIN" oninput="this.value=this.value.replace(/[^0-9]/g,'')" />
      </div>
    </div>
    <button class="btn btn-secondary btn-sm" onclick="submitChangePIN()">
      <i data-lucide="lock" style="width:13px;height:13px"></i>
      Save New PIN
    </button>`;
}

async function submitChangePIN() {
  const newPin  = document.getElementById('sset-new-pin')?.value.trim();
  const confirm = document.getElementById('sset-confirm-pin')?.value.trim();
  if (!newPin || newPin.length !== 4 || !/^\d{4}$/.test(newPin)) {
    showToast('PIN must be exactly 4 digits.', 'warning'); return;
  }
  if (newPin !== confirm) {
    showToast('PINs do not match.', 'warning'); return;
  }
  try {
    await apiFetch('/api/auth/pin', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ new_pin: newPin }),
    });
    closeModal();
    showToast('PIN changed. Logging out…', 'success', 3000);
    setTimeout(() => { sessionStorage.clear(); window.location.reload(); }, 2000);
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}



// ---------------------------------------------------------------------------
// Data Export
// ---------------------------------------------------------------------------

function _exportBody() {
  return `
    <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:10px">
      Download your data as CSV files for backup or external analysis.
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-secondary btn-sm" onclick="settingsExportInventory()">
        <i data-lucide="download" style="width:13px;height:13px"></i>
        Inventory CSV
      </button>
      <button class="btn btn-secondary btn-sm" onclick="settingsExportSales()">
        <i data-lucide="download" style="width:13px;height:13px"></i>
        Sales CSV
      </button>
    </div>`;
}

async function settingsExportInventory() {
  try {
    const data   = await apiFetch('/api/export/csv');
    const blob   = new Blob([data.csv], { type: 'text/csv' });
    const anchor = document.createElement('a');
    anchor.href     = URL.createObjectURL(blob);
    anchor.download = data.filename;
    anchor.click();
    showToast('Inventory exported.', 'success');
  } catch (err) { showToast(`Export failed: ${err.message}`, 'error'); }
}

async function settingsExportSales() {
  try {
    const data   = await apiFetch('/api/export/sales-csv');
    const blob   = new Blob([data.csv], { type: 'text/csv' });
    const anchor = document.createElement('a');
    anchor.href     = URL.createObjectURL(blob);
    anchor.download = data.filename;
    anchor.click();
    showToast('Sales exported.', 'success');
  } catch (err) { showToast(`Export failed: ${err.message}`, 'error'); }
}


// ---------------------------------------------------------------------------
// Data Reset
// ---------------------------------------------------------------------------

function _buildResetBody(counts) {
  return `
    <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:14px">
      Current data: <strong>${counts.drugs} drugs</strong> &middot;
      <strong>${counts.sales} sales</strong> &middot;
      <strong>${counts.prescriptions} prescriptions</strong> &middot;
      <strong>${counts.writeoffs} write-offs</strong>
    </div>

    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">

      <label style="display:flex;align-items:flex-start;gap:10px;padding:14px 16px;
        background:var(--blue-pale);border:1px solid var(--blue-light);
        border-radius:8px;cursor:pointer">
        <input type="radio" name="rst-mode" id="rst-mode-demo" value="demo"
          style="margin-top:3px;flex-shrink:0" checked />
        <div>
          <div style="font-size:13.5px;font-weight:700;color:var(--blue-deep);display:flex;align-items:center;gap:6px">
            <i data-lucide="refresh-cw" style="width:13px;height:13px"></i>
            Reset to Demo Data
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:3px">
            Wipes all data and reseeds with <strong>13 prescription drugs</strong>,
            21 days of sales history, and prescription records.
            App looks fully functional immediately — ideal for demos and portfolio.
          </div>
        </div>
      </label>

      <label style="display:flex;align-items:flex-start;gap:10px;padding:14px 16px;
        background:var(--red-bg);border:1px solid var(--red);
        border-radius:8px;cursor:pointer">
        <input type="radio" name="rst-mode" id="rst-mode-clean" value="clean"
          style="margin-top:3px;flex-shrink:0" />
        <div>
          <div style="font-size:13.5px;font-weight:700;color:var(--red);display:flex;align-items:center;gap:6px">
            <i data-lucide="trash-2" style="width:13px;height:13px"></i>
            Clear Everything
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:3px">
            Wipes all data with <strong>no reseed</strong>.
            Leaves a completely blank database ready for real pharmacy use in production.
          </div>
        </div>
      </label>

    </div>

    <div class="alert alert-warning" style="margin-bottom:12px;font-size:12.5px">
      <i data-lucide="alert-triangle" style="width:13px;height:13px"></i>
      This permanently deletes all current data. <strong>Cannot be undone.</strong>
    </div>

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <input class="form-input" id="rst-confirm" placeholder="Type RESET to confirm"
        style="max-width:200px" oninput="rstUpdateBtn()" />
      <button class="btn btn-danger btn-sm" id="rst-btn" disabled onclick="submitSettingsReset()">
        <i data-lucide="trash-2" style="width:13px;height:13px"></i>
        Reset Now
      </button>
    </div>`;
}

function rstUpdateBtn() {
  // A mode is always selected via radio — just need RESET typed
  const confirmed = document.getElementById('rst-confirm')?.value.trim() === 'RESET';
  const btn = document.getElementById('rst-btn');
  if (btn) btn.disabled = !confirmed;
}

async function submitSettingsReset() {
  if (document.getElementById('rst-confirm')?.value.trim() !== 'RESET') {
    showToast('Type RESET to confirm.', 'warning'); return;
  }

  const modeEl = document.querySelector('input[name="rst-mode"]:checked');
  const mode   = modeEl ? modeEl.value : 'demo';

  const btn = document.getElementById('rst-btn');
  if (btn) { btn.disabled = true; btn.textContent = mode === 'demo' ? 'Reseeding…' : 'Clearing…'; }

  try {
    await apiFetch('/api/reset/selective', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mode, confirm: 'RESET' }),
    });

    closeModal();
    const msg = mode === 'demo'
      ? 'Reset to demo data complete — app is ready to show.'
      : 'Database cleared. Ready for real pharmacy data.';
    showToast(msg, 'success', 5000);

    App.cache.drugs = App.cache.dashboard = App.cache.analytics = App.cache.history = null;
    const fn = window['render' + App.currentPage.charAt(0).toUpperCase() + App.currentPage.slice(1)];
    if (typeof fn === 'function') fn();

  } catch (err) {
    showToast(`Reset failed: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="trash-2" style="width:13px;height:13px"></i> Reset Now';
      setTimeout(renderIcons, 30);
    }
  }
}


// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function _aboutBody() {
  const shortcuts = [
    ['D','Dashboard'],['N','New Prescription'],['I','Inventory'],
    ['A','Analytics'],['H','History'],['?','Shortcut help'],
  ];
  return `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      <div style="flex:1;min-width:110px;padding:10px 14px;background:var(--blue-pale);border-radius:8px">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">App</div>
        <div style="font-size:14px;font-weight:700;color:var(--blue-deep);margin-top:2px">PharmAssist V2</div>
      </div>
      <div style="flex:1;min-width:110px;padding:10px 14px;background:var(--green-bg);border-radius:8px">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">Status</div>
        <div style="font-size:14px;font-weight:700;color:var(--green);margin-top:2px">Running</div>
      </div>
      <div style="flex:1;min-width:110px;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">AI Model</div>
        <div style="font-size:14px;font-weight:700;color:var(--text-primary);margin-top:2px">Gemini 2.5 Flash</div>
      </div>
    </div>
    <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-secondary);margin-bottom:8px">
      Keyboard Shortcuts
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
      ${shortcuts.map(([k,d]) => `
        <div style="display:flex;align-items:center;justify-content:space-between;
                    padding:6px 10px;background:var(--bg);border-radius:6px">
          <span style="font-size:12.5px;color:var(--text-secondary)">${d}</span>
          <kbd style="background:var(--surface);border:1.5px solid var(--border);border-radius:4px;
                      padding:2px 8px;font-size:12px;font-weight:700;font-family:monospace;
                      color:var(--blue-deep)">${k}</kbd>
        </div>`).join('')}
    </div>`;
}




// ---------------------------------------------------------------------------
// Window exports
// ---------------------------------------------------------------------------

window.openAppSettings       = openAppSettings;
window.toggleSettingsSection = toggleSettingsSection;
window.submitChangePIN       = submitChangePIN;
window.settingsExportInventory = settingsExportInventory;
window.settingsExportSales   = settingsExportSales;
window.rstUpdateBtn          = rstUpdateBtn;
window.submitSettingsReset   = submitSettingsReset;