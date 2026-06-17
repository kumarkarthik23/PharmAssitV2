/**
 * auth.js
 * =======
 * Simple PIN-based authentication for PharmAssist V2.
 *
 * The PIN is validated against the server via POST /api/auth/login which
 * returns a session token. The token is stored in sessionStorage and sent
 * as a Bearer header on every apiFetch call via a monkey-patch applied at
 * the bottom of this file.
 *
 * Sessions expire when the browser tab is closed (sessionStorage).
 * For a shared pharmacy terminal, the pharmacist should log out explicitly
 * using the logout button in the nav bar.
 *
 * Default PIN: 1234 (set in .env as PHARMASSIST_PIN)
 */

'use strict';

const _AUTH_KEY = 'pharmassist_token';

/**
 * Return the stored session token, or null if not authenticated.
 * @returns {string|null}
 */
function getAuthToken() {
  return sessionStorage.getItem(_AUTH_KEY);
}

/**
 * Check if the current session is authenticated.
 * @returns {boolean}
 */
function isAuthenticated() {
  return !!getAuthToken();
}

/**
 * Show the PIN login screen, replacing the main content.
 * Called on page load if no token is present.
 */
function showLoginScreen() {
  document.querySelector('.topnav').style.display     = 'none';
  document.querySelector('.main-content').style.display = 'none';

  const loginDiv = document.createElement('div');
  loginDiv.id    = 'login-screen';
  loginDiv.style.cssText = `
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--bg); z-index: 9999
  `;
  loginDiv.innerHTML = `
    <div style="
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 16px; padding: 48px 40px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.12);
      width: 100%; max-width: 380px; text-align: center
    ">
      <svg viewBox="0 0 32 32" fill="none" style="width:48px;height:48px;margin:0 auto 16px">
        <rect width="32" height="32" rx="8" fill="#1565C0"/>
        <path d="M16 5L7 9v7c0 5 4 9.5 9 11 5-1.5 9-6 9-11V9L16 5z"
          fill="#1976D2" stroke="white" stroke-width="1.2"/>
        <rect x="11" y="14" width="10" height="5" rx="2.5" fill="white" opacity="0.95"/>
        <rect x="16" y="14" width="5" height="5" fill="#90CAF9" opacity="0.9"
          style="clip-path:inset(0 0 0 0 round 0 2.5px 2.5px 0)"/>
        <line x1="16" y1="14" x2="16" y2="19" stroke="#1565C0" stroke-width="0.8"/>
      </svg>

      <div style="font-size:22px;font-weight:800;color:var(--text-primary);margin-bottom:4px">
        PharmAssist
      </div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:32px">
        Enter your PIN to continue
      </div>

      <div id="pin-display" style="
        display: flex; justify-content: center; gap: 12px; margin-bottom: 24px
      ">
        ${[0,1,2,3].map(i => `
          <div id="pin-dot-${i}" style="
            width: 14px; height: 14px; border-radius: 50%;
            background: var(--border); transition: background 0.15s
          "></div>`).join('')}
      </div>

      <div id="pin-grid" style="
        display: grid; grid-template-columns: repeat(3, 1fr);
        gap: 10px; max-width: 220px; margin: 0 auto
      ">
        ${[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map(key => `
          <button
            onclick="_pinKeyPress('${key}')"
            style="
              padding: 16px; font-size: 18px; font-weight: 600;
              background: ${key === '' ? 'transparent' : 'var(--bg)'};
              border: ${key === '' ? 'none' : '1.5px solid var(--border)'};
              border-radius: 8px; cursor: ${key === '' ? 'default' : 'pointer'};
              color: var(--text-primary);
              transition: background 0.1s
            "
            ${key === '' ? 'disabled' : ''}
          >${key}</button>`).join('')}
      </div>

      <div id="pin-error" style="
        margin-top: 16px; font-size: 13px; color: var(--red);
        min-height: 20px; font-weight: 500
      "></div>
    </div>
  `;
  document.body.appendChild(loginDiv);
}

// PIN entry state
let _pinBuffer = '';

/**
 * Handle PIN keypad button press.
 * @param {string} key  Digit string or '⌫' for backspace.
 */
function _pinKeyPress(key) {
  if (key === '⌫') {
    _pinBuffer = _pinBuffer.slice(0, -1);
  } else if (_pinBuffer.length < 4) {
    _pinBuffer += key;
  }

  // Update dot display
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById(`pin-dot-${i}`);
    if (dot) dot.style.background = i < _pinBuffer.length ? 'var(--blue-mid)' : 'var(--border)';
  }

  // Auto-submit when 4 digits entered
  if (_pinBuffer.length === 4) {
    setTimeout(_submitPin, 150);
  }
}

/**
 * Submit the entered PIN to the server.
 */
async function _submitPin() {
  const pin     = _pinBuffer;
  _pinBuffer    = '';
  // Reset dots
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById(`pin-dot-${i}`);
    if (dot) dot.style.background = 'var(--border)';
  }

  try {
    const resp = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ pin }),
    });

    if (resp.ok) {
      const data = await resp.json();
      sessionStorage.setItem(_AUTH_KEY, data.token);
      _onAuthSuccess();
    } else {
      const errEl = document.getElementById('pin-error');
      if (errEl) {
        errEl.textContent = 'Incorrect PIN. Please try again.';
        setTimeout(() => { if (errEl) errEl.textContent = ''; }, 2000);
      }
      // Shake animation
      const grid = document.getElementById('pin-grid');
      if (grid) {
        grid.style.animation = 'shake 0.4s ease';
        setTimeout(() => { grid.style.animation = ''; }, 400);
      }
    }
  } catch {
    const errEl = document.getElementById('pin-error');
    if (errEl) errEl.textContent = 'Server error. Please try again.';
  }
}

/**
 * Called after successful authentication.
 * Removes the login screen and shows the main app.
 */
function _onAuthSuccess() {
  const loginScreen = document.getElementById('login-screen');
  if (loginScreen) loginScreen.remove();
  document.querySelector('.topnav').style.display      = '';
  document.querySelector('.main-content').style.display = '';

  const validPages = ['dashboard', 'prescriptions', 'inventory', 'analytics', 'history'];
  const hash       = window.location.hash.replace('#', '');
  const page       = validPages.includes(hash) ? hash : 'dashboard';
  if (typeof window.navigateTo === 'function') window.navigateTo(page);
}

/**
 * Log out — clear token and show login screen.
 */
function logout() {
  sessionStorage.removeItem(_AUTH_KEY);
  window.location.reload();
}

// ---------------------------------------------------------------------------
// Inject shake keyframe and logout button into nav
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Inject shake animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%       { transform: translateX(-8px); }
      40%       { transform: translateX(8px); }
      60%       { transform: translateX(-6px); }
      80%       { transform: translateX(6px); }
    }
  `;
  document.head.appendChild(style);

  // Add logout button to nav
  const navRight = document.querySelector('.nav-right');
  if (navRight) {
    const logoutBtn = document.createElement('button');
    logoutBtn.className   = 'btn btn-ghost btn-sm';
    logoutBtn.style.color = 'rgba(255,255,255,0.7)';
    logoutBtn.innerHTML   = '<i data-lucide="log-out" style="width:14px;height:14px"></i>';
    logoutBtn.title       = 'Log out';
    logoutBtn.onclick     = logout;
    navRight.prepend(logoutBtn);
  }

  if (!isAuthenticated()) {
    showLoginScreen();
  }
});

// ---------------------------------------------------------------------------
// Monkey-patch apiFetch to send auth token on every request
// Runs after all scripts load (window.onload) so app.js has already
// set window.apiFetch before we wrap it.
// ---------------------------------------------------------------------------

window.addEventListener('load', () => {
  const _originalApiFetch = window.apiFetch;
  if (!_originalApiFetch) return;

  window.apiFetch = async function(path, options = {}) {
    const token = getAuthToken();
    if (token) {
      options.headers = {
        ...(options.headers || {}),
        'Authorization': `Bearer ${token}`,
      };
    }
    try {
      return await _originalApiFetch(path, options);
    } catch (err) {
      if (err.status === 401) {
        sessionStorage.removeItem(_AUTH_KEY);
        window.location.reload();
      }
      throw err;
    }
  };
});

window.logout          = logout;
window.isAuthenticated = isAuthenticated;
window._pinKeyPress    = _pinKeyPress;
