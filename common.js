// Shared utilities + the global Alpine `ui` store (navbar user, account menu,
// loading overlay, toast notifications). Used by every page that extends base.html.

// A normal account session can expire while a page remains open. Anonymous and
// TA pages use their own backend authorization and must not redirect to login.
if (document.body.dataset.loginRequired === 'true') {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const response = await originalFetch(...args);
    const url = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
    const redirectedToLogin = response.redirected && response.url &&
      ['/', '/login'].includes(new URL(response.url).pathname);
    if (url.origin === location.origin && (response.status === 401 || redirectedToLogin)) {
      // A 401 can also mean "wrong role for this endpoint" (e.g. an instructor session hitting a
      // student-only API such as /api/student/active_assignments), not an expired login. Only
      // leave the page when /api/me confirms the session is really gone.
      if (redirectedToLogin || url.pathname === '/api/me') { location.assign('/login'); return response; }
      try {
        const me = await originalFetch('/api/me', { headers: { Accept: 'application/json' } });
        const info = me.ok ? await me.json() : null;
        if (!info || info.logged_in === false) location.assign('/login');
      } catch { /* network hiccup: stay on the page */ }
    }
    return response;
  };
}

// HTML-escape a value for safe interpolation into template strings. Still used by
// the rich-content render helpers and a few list builders, so it stays a global.
function escapeHtml(text) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(text ?? '')));
  return d.innerHTML;
}

// Render the backend's `auto_repair_diff` (rows of {op:" "|"-"|"+"|"@", text}) as a
// colored unified diff: removed lines red, added lines green. Every line is escaped, so
// the returned HTML is safe to inject. Returns '' when there's no diff. Shared by the
// student file panel, the Deep Coding IDE, and the instructor panels (super-admin audit
// defines its own copy — that page doesn't load common.js).
function autoRepairDiffHtml(diff) {
  if (!Array.isArray(diff) || !diff.length) return '';
  const CLS = { '-': 'd-del', '+': 'd-ins', '@': 'd-gap', ' ': 'd-ctx' };
  const PFX = { '-': '-', '+': '+', '@': '', ' ': ' ' };
  const body = diff.map(function (r) {
    const op = (r && PFX.hasOwnProperty(r.op)) ? r.op : ' ';
    const text = (op === '@') ? '…' : (PFX[op] + ' ' + ((r && r.text) || ''));
    return '<span class="' + CLS[op] + '">' + escapeHtml(text) + '</span>';
  }).join('\n');
  return '<div class="ar-diff">'
       + '<div class="ar-diff-head">What I changed (auto-fix)</div>'
       + '<pre class="ar-diff-body">' + body + '</pre></div>';
}

// Register the shared `ui` store. Runs on Alpine's `alpine:init` event, which fires
// once when Alpine boots (alpine.min.js is loaded last in base.html), guaranteeing
// this listener is already attached. Alpine auto-invokes store.init() at startup.
document.addEventListener('alpine:init', () => {
  Alpine.store('ui', {
    user: { name: '', email: '', initials: '??' },
    accountOpen: false,
    loading: false,
    notifications: [],
    _seq: 0,

    init() {
      this.loadUser();
    },

    async loadUser() {
      if (document.body.dataset.loginRequired === 'false') return;
      try {
        const response = await fetch('/api/me');
        if (response.status === 404) { location.assign('/login'); return; }
        const d = response.ok ? await response.json() : null;
        if (d && d.logged_in === false) { location.assign('/login'); return; }
        if (!d) return;
        const name = d.name || [d.first_name, d.last_name].filter(Boolean).join(' ') || d.user_id || '';
        const email = d.email || d.user_id || '';
        const initials = name.split(' ').map(s => s[0] || '').join('').slice(0, 2).toUpperCase() || '??';
        this.user = { name, email, initials };
      } catch {}
    },

    toggleAccount() { this.accountOpen = !this.accountOpen; },
    closeAccount()  { this.accountOpen = false; },

    showLoading() { this.loading = true; },
    hideLoading() { this.loading = false; },

    // Toast: push a record, flip `show` next frame so the .notification → .notification.show
    // CSS transition runs (matches the original requestAnimationFrame two-step), then auto-hide.
    notify(msg, isError = false) {
      const id = ++this._seq;
      this.notifications.push({ id, msg: msg || (isError ? 'Error' : 'Done'), isError, show: false });
      const find = () => this.notifications.find(n => n.id === id);
      requestAnimationFrame(() => { const n = find(); if (n) n.show = true; });
      setTimeout(() => {
        const n = find();
        if (n) n.show = false;
        setTimeout(() => { this.notifications = this.notifications.filter(x => x.id !== id); }, 400);
      }, 1800);
    },
  });
});

// Back-compat shims so any code path (converted or not) can fire a toast / overlay
// without reaching into the store directly. Safe no-ops before Alpine has started.
function showNotification(msg, isError = false) {
  try { Alpine.store('ui').notify(msg, isError); }
  catch { try { alert(msg); } catch {} }
}
function showLoading() { try { Alpine.store('ui').showLoading(); } catch {} }
function hideLoading() { try { Alpine.store('ui').hideLoading(); } catch {} }

// ── Date/time display ─────────────────────────────────────────────────────────
// The backend stores naive UTC timestamps (datetime.utcnow), so values reach the
// client either as ISO strings without a zone ("2026-05-30T14:30:00") or as
// "YYYY-MM-DD HH:MM" (server strftime). Both are UTC, so we tag any zone-less value
// as UTC and let the browser render it in the viewer's own time zone. All output
// uses a 12-hour AM/PM clock; the zone itself is not shown.
function parseServerTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  let s = String(v).trim();
  // Tag bare date-times (no trailing Z and no ±HH:MM offset) as UTC.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    s = s.replace(' ', 'T') + 'Z';
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Format a backend timestamp in the viewer's local time zone. `opts` are Intl
// DateTimeFormat options; hour12 (AM/PM) is forced on. The locale is pinned to
// en-US so dates always read mm/dd/yyyy regardless of the viewer's locale — only
// the time zone follows the device. Returns '' for empty/bad input.
function fmtLocal(v, opts) {
  const d = parseServerTime(v);
  if (!d) return '';
  try { return d.toLocaleString('en-US', Object.assign({ hour12: true }, opts)); }
  catch { return d.toLocaleString('en-US', { hour12: true }); }
}

// Date + time, e.g. "05/30/2026, 04:30 PM".
function fmtDateTime(v) { return fmtLocal(v, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
// Time only, e.g. "04:30 PM".
function fmtTime(v)     { return fmtLocal(v, { hour: '2-digit', minute: '2-digit' }); }
// Date only, e.g. "05/30/2026".
function fmtDate(v)     { return fmtLocal(v, { year: 'numeric', month: '2-digit', day: '2-digit' }); }
