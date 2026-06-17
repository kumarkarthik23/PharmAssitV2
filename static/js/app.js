/**
 * app.js
 * ======
 * Application core for PharmAssist V2.
 *
 * This file must be loaded first. Every other page module (dashboard.js,
 * inventory.js, etc.) depends on the globals exported at the bottom of
 * this file.
 *
 * Responsibilities
 * ----------------
 * Router       Hash-based client-side routing. navigateTo(page) switches
 *              the visible page container and calls the page module's
 *              render function.
 *
 * Shared state window.App holds the current page name and a data cache.
 *              Page modules write to the cache after fetching so that
 *              switching back to a tab does not trigger a redundant request.
 *
 * API client   apiFetch() wraps fetch() with JSON parsing, unified error
 *              handling, and HTTP status codes on thrown errors.
 *
 * UI utilities loadingHTML, emptyHTML, showToast, openModal, closeModal —
 *              shared building blocks used by every page module.
 *
 * Formatters   fmtCurrency, fmtDate, daysUntil, stockBadge, expiryBadge —
 *              pure functions that convert raw values into display strings.
 *
 * Icon helpers icon(), renderIcons() — wrappers around the Lucide CDN
 *              library. renderIcons() must be called after any innerHTML
 *              assignment that contains <i data-lucide="..."> elements.
 */

'use strict';


// ---------------------------------------------------------------------------
// Shared application state
// ---------------------------------------------------------------------------

/**
 * Global application state object.
 *
 * currentPage  The page name that is currently rendered (matches a hash
 *              and a render function name, e.g. 'dashboard').
 *
 * cache        Data fetched from the API, keyed by page name. Modules
 *              write here after a successful fetch so navigating back
 *              to a page does not trigger an unnecessary network request.
 *              Set a key to null to force a fresh fetch on next visit.
 *
 * @type {{ currentPage: string, cache: Record<string, any> }}
 */
window.App = {
  currentPage: 'dashboard',
  cache: {
    dashboard:        null,
    drugs:            null,
    analytics:        null,
    pharmacyAnalytics: null,
    history:          null,
  },
};


// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Navigate to a page by name.
 *
 * Hides all page containers and nav links, then shows the target container
 * and highlights its nav link. Updates the URL hash and calls the page
 * module's render function (e.g. renderDashboard for page 'dashboard').
 * Lucide icons are re-initialised 50ms after the render function runs,
 * giving the DOM time to settle after innerHTML assignments.
 *
 * @param {string} page  Page identifier — must match a data-page attribute
 *                       and a render function named render{Page}.
 */
function navigateTo(page) {
  // Deactivate all pages and nav links
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));

  // Activate the target page and its nav link
  const pageContainer = document.getElementById(`page-${page}`);
  const navLink       = document.querySelector(`.nav-link[data-page="${page}"]`);

  if (pageContainer) pageContainer.classList.add('active');
  if (navLink)       navLink.classList.add('active');

  App.currentPage      = page;
  window.location.hash = page;

  // Call the page module's render function if it exists
  const renderFn = window[`render${_capitalize(page)}`];
  if (typeof renderFn === 'function') renderFn();

  // Re-initialise Lucide icons after the render function has written to the DOM
  setTimeout(renderIcons, 50);
  _refreshAlertBadge();
}

/**
 * Capitalise the first character of a string.
 * Used to derive render function names from page identifiers.
 *
 * @param {string} str
 * @returns {string}
 */
function _capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}


// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Bootstrap the application once the DOM is ready.
 *
 * Attaches click handlers to nav links and the "New Prescription" button,
 * then navigates to the page indicated by the URL hash (defaulting to
 * 'dashboard' for an unrecognised or missing hash).
 */
document.addEventListener('DOMContentLoaded', () => {
  // Nav link clicks
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(link.dataset.page);
    });
  });

  // "New Prescription" CTA in the nav bar
  const uploadButton = document.getElementById('nav-upload-btn');
  if (uploadButton) {
    uploadButton.addEventListener('click', () => navigateTo('prescriptions'));
  }

  // Resolve the initial page from the URL hash
  const validPages = ['dashboard', 'prescriptions', 'inventory', 'analytics', 'history'];
  const hash       = window.location.hash.replace('#', '');
  navigateTo(validPages.includes(hash) ? hash : 'dashboard');

  // Badge + keyboard
  _refreshAlertBadge();
  setInterval(_refreshAlertBadge, 60_000);
  document.addEventListener('keydown', _handleKeyboardShortcut);
});


// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

/**
 * Fetch a JSON endpoint and return the parsed response.
 *
 * On a non-2xx response the function reads the FastAPI error body
 * (which follows the { detail: string } convention), constructs a
 * descriptive Error, and attaches the HTTP status code as err.status
 * so callers can distinguish quota errors (429) from server errors (500).
 *
 * @param {string} path     URL path, e.g. '/api/drugs'.
 * @param {object} options  Optional fetch() options (method, body, headers).
 * @returns {Promise<any>}  Parsed JSON response body.
 * @throws {Error}          On any non-2xx status. err.status holds the code.
 */
async function apiFetch(path, options = {}) {
  const response = await fetch(path, options);

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      // Response body was not valid JSON — keep the generic detail string
    }
    const error    = new Error(detail);
    error.status   = response.status;
    throw error;
  }

  return response.json();
}


// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------

/** Timer handle used to cancel a pending toast dismiss. */
let _toastTimer = null;

/**
 * Show a brief notification at the bottom of the screen.
 *
 * The toast is hidden by removing the .show class after the duration
 * elapses. Calling showToast while one is already visible cancels the
 * previous timer and restarts it for the new message.
 *
 * @param {string} message   Text to display.
 * @param {string} type      CSS variant: 'success' | 'error' | 'warning' | 'info'.
 * @param {number} duration  Milliseconds before auto-dismiss (default 3500).
 */
function showToast(message, type = 'info', duration = 3500) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className   = `toast ${type} show`;

  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}


// ---------------------------------------------------------------------------
// Modal dialog
// ---------------------------------------------------------------------------

/**
 * Populate and show the modal dialog.
 *
 * Inserts the provided HTML into the modal box, makes the overlay visible,
 * and attaches two close triggers: clicking the overlay backdrop, and
 * clicking any element with the class .modal-close inside the box.
 *
 * @param {string} html  Inner HTML for the modal box.
 */
function openModal(html) {
  const overlay = document.getElementById('modal-overlay');
  const box     = document.getElementById('modal-box');

  box.innerHTML         = html;
  overlay.style.display = 'flex';

  // Close when the backdrop is clicked (but not when the box itself is clicked)
  overlay.onclick = e => {
    if (e.target === overlay) closeModal();
  };

  // Close when the explicit close button inside the modal is clicked
  const closeButton = box.querySelector('.modal-close');
  if (closeButton) closeButton.onclick = closeModal;
}

/**
 * Hide the modal dialog and clear its content.
 *
 * Clearing the innerHTML ensures that form state and event listeners
 * inside the modal do not persist between openings.
 */
function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('modal-box').innerHTML = '';
}


// ---------------------------------------------------------------------------
// Loading and empty state helpers
// ---------------------------------------------------------------------------

/**
 * Return an HTML string for a centred loading spinner with a message.
 *
 * @param {string} message  Text shown beneath the spinner.
 * @returns {string}
 */
function loadingHTML(message = 'Loading…') {
  return `
    <div class="spinner-wrap">
      <div class="spinner"></div>
      <span>${message}</span>
    </div>`;
}

/**
 * Return an HTML string for a centred empty state placeholder.
 *
 * @param {string} icon   Icon character or HTML fragment shown above the title.
 * @param {string} title  Primary message — explains why there is no content.
 * @param {string} sub    Optional secondary message — suggests an action.
 * @returns {string}
 */
function emptyHTML(icon, title, sub = '') {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon}</div>
      <div class="empty-title">${title}</div>
      ${sub ? `<div class="empty-sub">${sub}</div>` : ''}
    </div>`;
}


// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Format a number as a USD currency string.
 * Always produces exactly two decimal places (e.g. "$12.50", "$0.00").
 *
 * @param {number|null} n
 * @returns {string}
 */
function fmtCurrency(n) {
  return '$' + Number(n || 0).toFixed(2);
}

/**
 * Format an ISO date string (YYYY-MM-DD) as a human-readable date.
 * Returns '—' for null or empty input.
 *
 * The 'T00:00:00' suffix forces parsing in local time rather than UTC,
 * which prevents the date from appearing one day earlier in western timezones.
 *
 * @param {string|null} dateStr  ISO date string.
 * @returns {string}             e.g. "Jun 15, 2026"
 */
function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', {
    year:  'numeric',
    month: 'short',
    day:   'numeric',
  });
}

/**
 * Calculate the number of calendar days between today and a date string.
 * Returns null for null or empty input.
 * Negative values indicate the date is in the past.
 *
 * @param {string|null} dateStr  ISO date string (YYYY-MM-DD).
 * @returns {number|null}
 */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now  = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - now) / 86_400_000);
}

/**
 * Return an HTML badge reflecting a drug's stock level.
 *
 * Thresholds:
 *   0 units             danger  "Out of stock"
 *   1–threshold units   warning "Low — N"
 *   >threshold units    success "N units"
 *
 * @param {number} qty        Current stock quantity.
 * @param {number} threshold  Per-drug low stock alert threshold (default 20).
 * @returns {string}          HTML badge string.
 */
function stockBadge(qty, threshold = 20) {
  if (qty === 0)           return '<span class="badge badge-danger">Out of stock</span>';
  if (qty <= threshold)    return `<span class="badge badge-warning">Low — ${qty}</span>`;
  return `<span class="badge badge-success">${qty} units</span>`;
}

/**
 * Return an HTML badge reflecting how close a date is to expiry.
 *
 * Thresholds:
 *   Past          danger  "Expired"
 *   0–30 days     danger  "Nd left"
 *   31–90 days    warning "Nd left"
 *   >90 days      neutral formatted date
 *   null/empty    plain dash
 *
 * @param {string|null} dateStr  ISO date string (YYYY-MM-DD).
 * @returns {string}             HTML badge string or '—'.
 */
function expiryBadge(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return '—';
  if (days < 0)    return '<span class="badge badge-danger">Expired</span>';
  if (days <= 30)  return `<span class="badge badge-danger">${days}d left</span>`;
  if (days <= 90)  return `<span class="badge badge-warning">${days}d left</span>`;
  return `<span class="badge badge-neutral">${fmtDate(dateStr)}</span>`;
}


// ---------------------------------------------------------------------------
// Lucide icon helpers
// ---------------------------------------------------------------------------

/**
 * Return an HTML string for a Lucide icon element.
 *
 * The element is a placeholder — Lucide replaces it with an inline SVG
 * when renderIcons() is called. Extra CSS can be passed via the style
 * parameter and is appended to the inline style attribute.
 *
 * @param {string} name   Lucide icon name (e.g. 'pill', 'alert-triangle').
 * @param {number} size   Width and height in pixels (default 16).
 * @param {string} style  Additional CSS declarations (default '').
 * @returns {string}      HTML string for a <i data-lucide> element.
 */
function icon(name, size = 16, style = '') {
  const base = `width: ${size}px; height: ${size}px; display: inline-block; vertical-align: middle`;
  const full = style ? `${base}; ${style}` : base;
  return `<i data-lucide="${name}" style="${full}"></i>`;
}

/**
 * Initialise all pending Lucide icon placeholders in the document.
 *
 * Must be called after any innerHTML assignment that includes
 * <i data-lucide="..."> elements. Typically called via setTimeout to
 * allow the browser to complete the DOM update before scanning for icons.
 */
function renderIcons() {
  if (window.lucide) window.lucide.createIcons();
}


// ---------------------------------------------------------------------------
// Alert badge — global refresh (uses apiFetch so auth token is sent)
// ---------------------------------------------------------------------------

async function _refreshAlertBadge() {
  try {
    const data = await apiFetch('/api/dashboard').catch(() => null);
    if (!data) return;
    const badge   = document.getElementById('alert-badge');
    const countEl = document.getElementById('alert-badge-count');
    const labelEl = document.getElementById('alert-badge-label');
    if (!badge) return;
    const alerts = data.alerts || [];
    if (!alerts.length) { badge.style.display = 'none'; return; }
    const counts = {
      expired:      alerts.filter(a => a.type === 'expired').length,
      out_of_stock: alerts.filter(a => a.type === 'out_of_stock').length,
      low_stock:    alerts.filter(a => a.type === 'low_stock').length,
      expiring:     alerts.filter(a => a.type === 'expiring').length,
    };
    badge.style.display = 'inline-flex';
    if (countEl) countEl.textContent = alerts.length;
    if (labelEl) {
      if (counts.expired)           labelEl.textContent = `${counts.expired} expired`;
      else if (counts.out_of_stock) labelEl.textContent = `${counts.out_of_stock} out of stock`;
      else if (counts.low_stock)    labelEl.textContent = `${counts.low_stock} low stock`;
      else if (counts.expiring)     labelEl.textContent = `${counts.expiring} expiring`;
    }
  } catch { /* silent — badge is non-critical */ }
}


// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function _handleKeyboardShortcut(e) {
  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (document.getElementById('modal-overlay')?.style.display === 'flex') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const map = { d:'dashboard', n:'prescriptions', i:'inventory', a:'analytics', h:'history' };
  const page = map[e.key.toLowerCase()];
  if (page) { e.preventDefault(); navigateTo(page); return; }
  if (e.key === '?') { e.preventDefault(); if (typeof openAppSettings === 'function') openAppSettings(); }
}


// ---------------------------------------------------------------------------
// Global exports
// ---------------------------------------------------------------------------

/*
 * All functions are attached to window so they are accessible from
 * page modules loaded in separate script tags. In a module-based build
 * system these would be proper ES module exports instead.
 */
window.navigateTo  = navigateTo;
window.apiFetch    = apiFetch;
window.showToast   = showToast;
window.openModal   = openModal;
window.closeModal  = closeModal;
window.loadingHTML = loadingHTML;
window.emptyHTML   = emptyHTML;
window.fmtCurrency = fmtCurrency;
window.fmtDate     = fmtDate;
window.daysUntil   = daysUntil;
window.stockBadge  = stockBadge;
window.expiryBadge = expiryBadge;
window.icon        = icon;
window.renderIcons = renderIcons;