import { h, mount, $, api, GET, POST, toast, setAuthLost, loading, errorBox, field, run, label } from './lib.js';
import * as emp from './views_employee.js';
import * as rev from './views_review.js';
import * as adm from './views_admin.js';
import * as cus from './views_customer.js';
import * as common from './views_common.js';

export const state = { user: null, demo: false, unread: 0 };
const root = $('#app');

const NAV = {
  EMPLOYEE: [['#/', 'Dashboard'], ['#/add', 'Add customer'], ['#/customers', 'Customers'], ['#/collect', 'Collect payment'], ['#/payments', 'Payment history'], ['#/overdue', 'Overdue'], ['#/applications', 'Applications'], ['#/notifications', 'Notifications', 'bell'], ['#/profile', 'Profile']],
  ACCOUNTS: [['#/', 'Dashboard'], ['#/queue', 'Verification queue'], ['#/applications', 'All applications'], ['#/notifications', 'Notifications', 'bell'], ['#/profile', 'Profile']],
  ADMIN: [['#/', 'Dashboard'], ['#/queue', 'Review queue'], ['#/applications', 'All applications'], ['#/customers', 'Customers & loans'], ['#/overdue', 'Overdue'], ['#/payments', 'Payments'], ['#/reports', 'Reports'], ['#/employees', 'Users'], ['#/products', 'Loan products'], ['#/rules', 'Eligibility rules'], ['#/penalty', 'Penalty policy'], ['#/expenses', 'Expenses'], ['#/audit', 'Audit log'], ['#/notifications', 'Notifications', 'bell'], ['#/profile', 'Profile']],
  CUSTOMER: [['#/', 'My loan'], ['#/payments', 'My payments'], ['#/notifications', 'Notifications', 'bell'], ['#/profile', 'Profile']],
};

const routes = [ // [regex, handler(ctx) for roles]
  [/^\/$/, { EMPLOYEE: emp.dashboard, ACCOUNTS: rev.accountsDashboard, ADMIN: adm.dashboard, CUSTOMER: cus.home }],
  [/^\/add(?:\/(\d+))?$/, { EMPLOYEE: emp.addCustomer }],
  [/^\/customers$/, { EMPLOYEE: emp.cases, ADMIN: emp.cases }],
  [/^\/collect(?:\/(\d+))?$/, { EMPLOYEE: emp.collect, ADMIN: emp.collect }],
  [/^\/payments$/, { EMPLOYEE: common.payments, ADMIN: common.payments, CUSTOMER: common.payments }],
  [/^\/receipt\/(\d+)$/, { EMPLOYEE: common.receipt, ADMIN: common.receipt, CUSTOMER: common.receipt }],
  [/^\/overdue$/, { EMPLOYEE: emp.overdue, ADMIN: emp.overdue }],
  [/^\/applications$/, { EMPLOYEE: common.applications, ACCOUNTS: common.applications, ADMIN: common.applications }],
  [/^\/queue$/, { ACCOUNTS: rev.queue, ADMIN: rev.queue }],
  [/^\/application\/(\d+)$/, { EMPLOYEE: rev.application, ACCOUNTS: rev.application, ADMIN: rev.application, CUSTOMER: cus.application }],
  [/^\/print\/package\/(\d+)$/, { EMPLOYEE: common.printPackage, ACCOUNTS: common.printPackage, ADMIN: common.printPackage }],
  [/^\/loan\/(\d+)$/, { EMPLOYEE: common.loan, ADMIN: common.loan, CUSTOMER: common.loan }],
  [/^\/notifications$/, { EMPLOYEE: common.notifications, ACCOUNTS: common.notifications, ADMIN: common.notifications, CUSTOMER: common.notifications }],
  [/^\/profile$/, { EMPLOYEE: common.profile, ACCOUNTS: common.profile, ADMIN: common.profile, CUSTOMER: common.profile }],
  [/^\/employees$/, { ADMIN: adm.users }], [/^\/products$/, { ADMIN: adm.products }], [/^\/rules$/, { ADMIN: adm.rules }], [/^\/penalty$/, { ADMIN: adm.penalty }],
  [/^\/reports(?:\/(\w+))?$/, { ADMIN: adm.reports }], [/^\/expenses$/, { ADMIN: adm.expenses }], [/^\/audit$/, { ADMIN: adm.audit }],
];

async function refreshMe() {
  try { const d = await GET('/api/me'); state.user = d.user; state.demo = d.demoMode; state.unread = d.unread || 0; } catch { state.user = null; }
}
export const ctx = state;
export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

function authShell(...kids) { return h('div', { class: 'login' }, h('div', { class: 'brand', style: 'color:var(--brand);padding-left:0' }, h('div', { class: 'logo', style: 'background:var(--brand);color:#fff' }, 'HS'), 'HS Small Finance'), ...kids); }

async function loginScreen() {
  let status; try { status = await GET('/api/setup-status'); } catch (e) { return mount(root, authShell(errorBox(e))); }
  if (status.needsSetup) return setupScreen(status);
  const err = h('div', { class: 'banner bad', hidden: true });
  const u = h('input', { id: 'u', autocomplete: 'username', autocapitalize: 'none', required: true }), p = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'primary', type: 'submit', style: 'width:100%;justify-content:center' }, 'Log in');
  const form = h('form', { class: 'card', onsubmit: async e => { e.preventDefault(); err.hidden = true; btn.disabled = true;
    try { await POST('/api/login', { username: u.value, password: p.value }); await boot(); } catch (x) { err.hidden = false; err.textContent = x.message; } finally { btn.disabled = false; } } },
    h('h1', {}, 'Log in'), err, field('Username', u), field('Password', p), btn,
    h('p', { class: 'muted small mt' }, 'Forgot your password? Ask your Admin to issue a temporary password. Admins cannot see your current password.'));
  mount(root, authShell(status.demoMode && h('div', { class: 'banner demo' }, 'DEMO MODE is on. OTP codes appear on screen instead of being sent by SMS. Do not use it for real customers.'), form)); u.focus();
}
function setupScreen(status) {
  const err = h('div', { class: 'banner bad', hidden: true });
  const f = { name: h('input', { id: 'n', required: true }), username: h('input', { id: 'un', required: true, autocapitalize: 'none' }), mobile: h('input', { id: 'm', inputmode: 'numeric' }), password: h('input', { id: 'pw', type: 'password', required: true, autocomplete: 'new-password' }), setupToken: h('input', { id: 'setup-token', type: 'password', required: status.setupTokenRequired, autocomplete: 'off' }) };
  const form = h('form', { class: 'card', onsubmit: async e => { e.preventDefault(); err.hidden = true;
    try { await POST('/api/setup', { name: f.name.value, username: f.username.value, mobile: f.mobile.value, password: f.password.value, setupToken: f.setupToken.value }); await boot(); } catch (x) { err.hidden = false; err.textContent = x.message; } } },
    h('h1', {}, 'First-time setup'), h('p', { class: 'muted' }, 'Create the Admin account. There are no built-in passwords; this is the only way an Admin is created.'), err,
    status.setupTokenRequired && field('Setup token', f.setupToken, { hint: 'Find HS_SETUP_TOKEN in your hosting service’s environment settings.' }),
    field('Full name', f.name), field('Username', f.username, { hint: 'letters, numbers, . _ -' }), field('Mobile (optional)', f.mobile), field('Password', f.password, { hint: 'at least 8 characters with letters and numbers' }),
    h('button', { class: 'primary', type: 'submit' }, 'Create Admin account'));
  mount(root, authShell(form));
}
function changePasswordScreen() {
  const err = h('div', { class: 'banner bad', hidden: true }); const cur = h('input', { type: 'password', id: 'cp', required: true, autocomplete: 'current-password' }), np = h('input', { type: 'password', id: 'np', required: true, autocomplete: 'new-password' });
  mount(root, authShell(h('form', { class: 'card', onsubmit: async e => { e.preventDefault(); err.hidden = true;
    try { await POST('/api/change-password', { current: cur.value, password: np.value }); toast('Password changed. Please log in again.', 'ok'); state.user = null; await loginScreen(); } catch (x) { err.hidden = false; err.textContent = x.message; } } },
    h('h1', {}, 'Choose a new password'), h('p', { class: 'muted' }, `Hello ${state.user.name}. Your temporary password must be replaced before you continue.`), err,
    field('Temporary password', cur), field('New password', np, { hint: 'at least 8 characters with letters and numbers' }), h('button', { class: 'primary', type: 'submit' }, 'Save new password'),
    h('button', { type: 'button', class: 'ghost', onclick: logout }, 'Log out'))));
}
async function logout() { try { await POST('/api/logout'); } catch {} state.user = null; location.hash = '#/'; await loginScreen(); }
export { logout };

function layout(content) {
  const u = state.user; const cur = location.hash || '#/';
  const side = h('nav', { class: 'side', 'aria-label': 'Main' }, h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'HS'), 'HS Small Finance'),
    NAV[u.role].map(([href, text, kind]) => h('a', { class: 'nav' + (cur === href || (href !== '#/' && cur.startsWith(href + '/')) ? ' on' : ''), href, onclick: () => side.classList.remove('open') }, text, kind === 'bell' && state.unread > 0 && h('span', { class: 'badge-n' }, state.unread))),
    h('div', { class: 'who' }, h('div', {}, u.name), h('div', {}, `${label(u.role)} · ${u.code || ''}`), h('button', { class: 'sm mt', onclick: logout, style: 'width:100%;justify-content:center' }, 'Log out')));
  const top = h('div', { class: 'topbar' }, h('button', { onclick: () => side.classList.toggle('open'), 'aria-label': 'Menu' }, '☰'), h('strong', {}, 'HS Small Finance'), h('a', { href: '#/notifications', style: 'color:#fff;text-decoration:none' }, '🔔' + (state.unread ? ` ${state.unread}` : '')));
  mount(root, h('div', { class: 'shell' }, side, h('div', {}, top, h('main', { class: 'main', id: 'main' }, content))), state.demo && h('div', { class: 'demo-tag' }, 'DEMO MODE'));
}

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  if (!state.user) return loginScreen();
  if (state.user.mustChange) return changePasswordScreen();
  const path = (location.hash.slice(1) || '/').split('?')[0]; let handler, m;
  for (const [re, map] of routes) { m = path.match(re); if (m) { handler = map[state.user.role]; break; } }
  const holder = h('div', {}, loading()); layout(holder); window.scrollTo(0, 0);
  if (!handler) { mount(holder, h('div', { class: 'card empty' }, m ? 'You do not have access to this page.' : 'Page not found.')); return; }
  try {
    const q = Object.fromEntries(new URLSearchParams((location.hash.split('?')[1]) || ''));
    const node = await handler({ params: m.slice(1), query: q, user: state.user, go, state, logout });
    if (token !== renderToken) return; mount(holder, node);
    document.title = (holder.querySelector('h1')?.textContent || 'HS Small Finance') + ' | HS Small Finance';
  } catch (e) { if (token === renderToken) mount(holder, errorBox(e)); }
}
window.addEventListener('hashchange', render);
setAuthLost(() => { if (state.user) { state.user = null; toast('Your session has ended. Please log in again.', 'bad'); loginScreen(); } });
async function boot() { await refreshMe(); await render(); }
// keep the unread badge fresh
setInterval(async () => { if (!state.user || document.hidden) return; try { const d = await GET('/api/me'); if (!d.user) { state.user = null; toast('Your session has ended. Please log in again.', 'bad'); return loginScreen(); } if (d.unread !== state.unread) { state.unread = d.unread; document.querySelectorAll('.badge-n').forEach(b => b.textContent = d.unread); if (d.unread > 0 && !document.querySelector('.badge-n')) render(); } } catch {} }, 30000);
boot();
