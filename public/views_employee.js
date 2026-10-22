import { h, GET, POST, PUT, DEL, api, rupees, parseRupees, rupeesInput, fmtDate, fmtDT, todayIso, pill, label, pct, table, kv, toast, run, field, loading, errorBox, uid, prepareFile, filePicker, uploadJson, confirmBox, modal, viewDocument, ApiErr } from './lib.js';
import { tile, pageHead, appList } from './views_common.js';

// ================= Dashboard =================
export async function dashboard({ user }) {
  const d = (await GET('/api/dashboard')).metrics;
  return h('div', {}, pageHead(`Welcome, ${user.name}`, 'Your customers, collections and pending work'),
    h('div', { class: 'grid g4 mb' }, tile('Assigned customers', d.assignedCustomers, '#/customers'), tile('Active loans', d.activeLoans, '#/customers?filter=active'), tile('Closed loans', d.closedLoans, '#/customers?filter=closed'),
      tile('Pending applications', d.pendingApplications, '#/customers?filter=pending'), tile('Awaiting my action', d.awaitingAction, '#/applications', d.awaitingAction ? 'warn' : ''), tile('Documents required', d.docsRequired, '#/applications?status=ADDITIONAL_DOCUMENTS_REQUIRED', d.docsRequired ? 'warn' : ''),
      tile("Today's collections", rupees(d.todayCollections), '#/payments', 'ok'), tile('Month to date', rupees(d.monthCollections), '#/payments', 'ok'), tile('Overdue customers', d.overdueCustomers, '#/overdue', d.overdueCustomers ? 'bad' : ''), tile('Total overdue', rupees(d.overdueAmount), '#/overdue', d.overdueAmount ? 'bad' : '')),
    h('h2', {}, 'Quick actions'), h('div', { class: 'row' }, [['#/add', '+ Add customer'], ['#/customers', 'Customer list'], ['#/collect', 'Collect payment'], ['#/overdue', 'Overdue list'], ['#/applications', 'Applications'], ['#/notifications', 'Notifications'], ['#/profile', 'Profile']].map(([href, t]) => h('a', { class: 'btn' + (t[0] === '+' ? ' primary' : ''), href }, t))));
}

// ================= Customer / case list =================
export async function cases({ query, user }) {
  let filter = query.filter || 'all', search = query.search || ''; const holder = h('div', {}); const tabs = h('div', { class: 'tabs', role: 'tablist' }); const box = h('div', {});
  const input = h('input', { type: 'search', placeholder: 'Search name, customer ref, mobile, loan ref', value: search, 'aria-label': 'Search' });
  let t; input.oninput = () => { clearTimeout(t); t = setTimeout(() => { search = input.value; load(); }, 250); };
  async function load() {
    box.replaceChildren(loading());
    try { const d = await GET('/api/cases', { filter, search });
      tabs.replaceChildren(...[['all', 'All'], ['pending', 'Pending'], ['active', 'Active'], ['closed', 'Closed'], ['overdue', 'Overdue']].map(([k, l]) => h('button', { role: 'tab', 'aria-selected': filter === k, class: filter === k ? 'on' : '', onclick: () => { filter = k; load(); } }, l, h('span', { class: 'c' }, d.counts[k]))));
      box.replaceChildren(table([{ h: 'Customer', f: r => h('div', {}, h('strong', {}, r.customerName), h('div', { class: 'muted small' }, `${r.customerRef}${r.mobile ? ' · ' + r.mobile : ''}`)) }, { h: 'Loan / application', f: r => h('div', {}, r.loanRef || r.applicationRef, h('div', {}, pill(r.loanStatus === 'ACTIVE' || r.loanStatus === 'CLOSED' ? r.loanStatus : r.applicationStatus))) },
        { h: 'Amount', num: true, f: r => rupees(r.amount) }, { h: 'Outstanding', num: true, f: r => r.outstanding == null ? '-' : rupees(r.outstanding) }, { h: 'Next due', f: r => fmtDate(r.nextDueDate) }, { h: 'Overdue', num: true, f: r => r.overdueAmount ? h('span', { style: 'color:var(--bad);font-weight:600' }, rupees(r.overdueAmount)) : '-' }],
        d.rows, { onRow: r => { location.hash = r.loanId && r.loanStatus !== 'PENDING_DISBURSEMENT' ? `#/loan/${r.loanId}` : `#/application/${r.applicationId}`; }, empty: search ? 'No customers match your search.' : `No ${filter === 'all' ? '' : filter + ' '}customers yet.` }));
    } catch (e) { box.replaceChildren(errorBox(e)); }
  }
  holder.append(pageHead('Customers', null, user.role === 'EMPLOYEE' && h('a', { class: 'btn primary', href: '#/add' }, '+ Add customer')), user.role === 'EMPLOYEE' && await drafts(), h('div', { class: 'mb', style: 'max-width:420px' }, input), tabs, box); load(); return holder;
}
async function drafts() {
  const d = await GET('/api/applications', { draft: '1' }); if (!d.applications.length) return null;
  return h('div', { class: 'card' }, h('h2', {}, `Saved drafts (${d.applications.length})`), h('div', { class: 'muted small mb' }, 'Drafts are not submitted. Resume to continue.'),
    d.applications.map(a => h('div', { class: 'row between', style: 'margin-bottom:.4rem' }, h('div', {}, h('strong', {}, a.customerName || 'Unnamed customer'), h('span', { class: 'muted small' }, ` · saved ${fmtDT(a.updatedAt)}`)),
      h('div', { class: 'row' }, h('a', { class: 'btn sm primary', href: `#/add/${a.id}` }, 'Resume'), h('button', { class: 'sm', onclick: async e => { if (await confirmBox('Discard draft?', 'This draft will be removed from your list.', 'Discard', true)) { await run(e.target, () => DEL('/api/applications/' + a.id)); window.dispatchEvent(new HashChangeEvent('hashchange')); } } }, 'Discard'))))); 
}

// ================= Add customer wizard =================
const STEPS = ['Personal information', 'Mobile verification', 'Loan request', 'Bank details', 'Review', 'Submitted'];
export async function addCustomer({ params }) {
  let appId = params[0] ? Number(params[0]) : null; let step = 0; let form = { adults: '', children: '', bank: {} }; const docs = {}; let products = [], estimate = null, elig = null, otp = { sent: false, demo: null, ref: null, sentAt: 0 }; let result = null;
  const root = h('div', {});
  products = (await GET('/api/products')).products;
  if (appId) { const d = await GET('/api/applications/' + appId); if (d.application.status !== 'DRAFT') { location.hash = '#/application/' + appId; return h('div'); }
    form = { adults: '', children: '', bank: {}, ...(d.application.draft || {}) }; for (const x of d.documents || []) if (x.status !== 'SUPERSEDED' && !docs[x.type]) docs[x.type] = { id: x.id, state: 'done', mime: x.mime, name: x.original_name, url: x.mime.startsWith('image/') ? `/api/documents/${x.id}/file` : null }; }
  const ensureDraft = async () => { if (!appId) { appId = (await POST('/api/applications')).id; history.replaceState(null, '', '#/add/' + appId); } return appId; };
  const sync = () => { form.productId = form.productId ? Number(form.productId) : undefined; form.term = form.term ? Number(form.term) : undefined; form.income = parseRupees(form.incomeText); form.amount = parseRupees(form.amountText); form.adults = form.adultsText === '' || form.adultsText == null ? form.adults : Number(form.adultsText); form.children = form.childrenText === '' || form.childrenText == null ? form.children : Number(form.childrenText); };
  const save = async (quiet) => { sync(); await ensureDraft(); await PUT(`/api/applications/${appId}/draft`, { form }); if (!quiet) toast('Draft saved. You can resume it from the customer list.', 'ok'); };
  const errBox = h('div', { class: 'banner bad', hidden: true });
  const showErr = list => { errBox.hidden = !list.length; errBox.replaceChildren(...list.map(e => h('div', {}, e))); if (list.length) errBox.scrollIntoView({ block: 'center' }); return list.length > 0; };
  const bind = (key, opts = {}) => { const inp = h(opts.tag || 'input', { id: 'f_' + key, value: form[key] ?? '', inputmode: opts.mode, type: opts.type, max: opts.max, autocomplete: 'off', maxlength: opts.maxlength, oninput: e => { form[key] = opts.upper ? e.target.value.toUpperCase() : e.target.value; if (opts.after) opts.after(); } }); if (opts.tag === 'textarea') inp.value = form[key] ?? ''; return inp; };
  const bindBank = (key, opts = {}) => h('input', { id: 'b_' + key, value: form.bank[key] ?? '', inputmode: opts.mode, autocomplete: 'off', type: opts.type, oninput: e => { form.bank[key] = opts.upper ? e.target.value.toUpperCase() : e.target.value; } });

  function docBox(type, title, required) {
    const d = docs[type]; const thumb = h('div', { class: 'thumb' }, d?.url ? h('img', { src: d.url, alt: title, style: 'width:64px;height:64px;object-fit:cover;border-radius:8px' }) : d?.mime === 'application/pdf' ? 'PDF' : 'No file');
    const status = h('div', { class: 'small ' + (d?.state === 'error' ? '' : 'muted'), style: d?.state === 'error' ? 'color:var(--bad)' : '' }, d?.state === 'uploading' ? `Uploading… ${d.pct || 0}%` : d?.state === 'error' ? d.err : d?.state === 'done' ? '✓ Uploaded' : required ? 'Required' : 'Optional');
    const upload = async (file, retryKey) => {
      let p; try { p = await prepareFile(file); } catch (e) { toast(e.message, 'bad'); return; }
      const key = retryKey || uid(); docs[type] = { state: 'uploading', pct: 0, url: p.preview, mime: p.mime, key, file };
      render();
      try { await ensureDraft(); await save(true); const r = await uploadJson(`/api/applications/${appId}/documents`, { type, mime: p.mime, name: p.name, data: p.data, uploadKey: key }, pc => { docs[type].pct = pc; status.textContent = `Uploading… ${pc}%`; });
        docs[type] = { id: r.id, state: 'done', url: p.preview, mime: p.mime, name: p.name }; } catch (e) { docs[type] = { state: 'error', err: e.message + ' Tap Retry.', url: p.preview, mime: p.mime, key, retry: () => upload(file, key) }; }
      render();
    };
    return h('div', { class: 'docbox' + (d?.state === 'error' ? ' err' : '') }, thumb, h('div', { class: 'grow' }, h('strong', {}, title, required && ' *'), status),
      d?.state === 'error' && h('button', { class: 'sm', type: 'button', onclick: d.retry }, 'Retry'), d?.state !== 'uploading' && filePicker(f => upload(f)));
  }
  const personalErrors = () => { sync(); const e = []; const age = form.dob ? Math.floor((Date.now() - Date.parse(form.dob)) / 31557600000) : null;
    if (!form.name?.trim()) e.push('Customer name is required.'); if (!form.dob) e.push('Date of birth is required.'); else if (age < 18) e.push('Customer must be at least 18 years old.');
    if (!/^[6-9]\d{9}$/.test(form.mobile || '')) e.push('Enter a valid 10-digit mobile number.'); if (!form.address?.trim()) e.push('Address is required.'); if (!form.occupation?.trim()) e.push('Occupation is required.');
    if (!(form.income > 0)) e.push('Enter a valid monthly income (rupees).'); if (!Number.isInteger(form.adults) || form.adults < 0) e.push('Enter the number of adult family members.'); if (!Number.isInteger(form.children) || form.children < 0) e.push('Enter the number of children.');
    if (!/^[A-Za-z]{3}\d{7}$/.test(form.voter || '')) e.push('Voter ID must be 3 letters followed by 7 digits.'); if (form.pan && !/^[A-Za-z]{5}\d{4}[A-Za-z]$/.test(form.pan)) e.push('PAN format is invalid.');
    if (form.aadhaar && !/^[2-9]\d{11}$/.test(form.aadhaar.replace(/\s/g, ''))) e.push('Aadhaar must be 12 digits.');
    const need = [['PROFILE_PHOTO', 'Customer photograph'], ['VOTER_ID', 'Voter ID document'], ...(form.aadhaar ? [['AADHAAR_FRONT', 'Aadhaar front'], ['AADHAAR_BACK', 'Aadhaar back']] : [])];
    for (const [t, l] of need) if (docs[t]?.state !== 'done') e.push(`${l} must be uploaded${docs[t]?.state === 'uploading' ? ' (still uploading)' : ''}.`); return e; };

  const stepPersonal = () => { const today = todayIso(); return h('div', {}, h('div', { class: 'grid g2' },
    field('Customer full name *', bind('name')), field('Date of birth *', bind('dob', { type: 'date', max: today }), { hint: 'pick from calendar' }), field('Mobile number *', bind('mobile', { mode: 'numeric', maxlength: 10 }), { hint: 'an OTP will be sent' }),
    field('Occupation *', bind('occupation')), field('Monthly income (₹) *', bind('incomeText', { mode: 'decimal' })), field('Voter ID number *', bind('voter', { upper: true, maxlength: 10 })),
    field('Adult family members *', bind('adultsText', { mode: 'numeric', maxlength: 2 })), field('Number of children *', bind('childrenText', { mode: 'numeric', maxlength: 2 })), field('PAN (optional)', bind('pan', { upper: true, maxlength: 10 })),
    field('Aadhaar (only if needed)', bind('aadhaar', { mode: 'numeric', maxlength: 14 }), { hint: 'collect only where permitted' })), field('Full residential address *', bind('address', { tag: 'textarea' })),
    h('h3', {}, 'Documents'), docBox('PROFILE_PHOTO', 'Customer photograph', true), docBox('VOTER_ID', 'Voter ID (photo/scan)', true), docBox('PAN', 'PAN card', false),
    form.aadhaar && h('div', {}, docBox('AADHAAR_FRONT', 'Aadhaar front', true), docBox('AADHAAR_BACK', 'Aadhaar back', true)), docBox('ADDRESS_PROOF', 'Address proof', false), docBox('INCOME_PROOF', 'Income / occupation proof', false)); };

  const stepOtp = () => { const code = h('input', { id: 'otp', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', placeholder: '6-digit code' }); const verifyBtn = h('button', { class: 'primary', type: 'button' }, 'Verify code');
    const resend = h('button', { type: 'button' }, 'Resend code'); const wait = () => { const left = 30 - Math.floor((Date.now() - otp.sentAt) / 1000); resend.disabled = left > 0; resend.textContent = left > 0 ? `Resend in ${left}s` : 'Resend code'; if (left > 0 && resend.isConnected) setTimeout(wait, 1000); };
    const send = async () => { try { const r = await POST(`/api/applications/${appId}/otp/send`, { mobile: form.mobile }); otp = { sent: true, demo: r.demo ? r : null, ref: r.ref, sentAt: Date.now() }; render(); } catch (e) { toast(e.message, 'bad'); } };
    verifyBtn.onclick = () => run(verifyBtn, async () => { await POST(`/api/applications/${appId}/otp/verify`, { mobile: form.mobile, code: code.value.trim() }); form.otpVerifiedMobile = form.mobile; await save(true); step = 2; render(); }, 'Mobile number verified');
    resend.onclick = send; if (!otp.sent) setTimeout(send, 0); setTimeout(wait, 0);
    return h('div', {}, h('p', {}, 'A verification code is sent to ', h('strong', {}, '+91 ' + form.mobile), '. The customer must read it out to you.'),
      otp.demo && h('div', { class: 'banner demo' }, h('strong', {}, 'DEMO MODE: '), otp.demo.label, h('div', { style: 'font-size:1.4rem;font-weight:700;letter-spacing:.2em' }, otp.demo.demoCode)),
      otp.sent ? h('div', {}, field('Enter code', code, { hint: 'valid for 5 minutes' }), h('div', { class: 'row' }, verifyBtn, resend), h('p', { class: 'muted small mt' }, `Reference ${otp.ref}`)) : h('div', { class: 'loading' }, h('span', { class: 'spinner' }), ' Sending code…'),
      h('p', { class: 'muted small mt' }, 'Wrong number? Go back and correct it; a new code will be needed.')); };

  let estTimer; const refreshEstimate = () => { clearTimeout(estTimer); estTimer = setTimeout(async () => { sync(); const box = $est(); if (!box) return; if (!form.productId || !(form.amount > 0)) { box.replaceChildren(h('div', { class: 'muted' }, 'Enter an amount to see the estimate.')); return; }
    try { estimate = await POST('/api/estimate', { productId: Number(form.productId), amount: form.amount, term: Number(form.term) || undefined }); } catch (e) { estimate = null; box.replaceChildren(h('div', { class: 'banner bad' }, e.message)); return; }
    try { elig = await POST(`/api/applications/${appId}/eligibility`, { form: { ...form, productId: Number(form.productId) } }); } catch (e) { elig = null; }
    const ps = products.find(p => p.id === Number(form.productId));
    box.replaceChildren(h('div', { class: 'banner info' }, 'Provisional estimate. Final terms apply only after Admin approval.'), kv([['Interest', `${pct(estimate.rateBps)} ${estimate.ratePeriod === 'ANNUAL' ? 'per year' : 'per month'}, ${estimate.method === 'FLAT' ? 'flat' : 'reducing balance'}`], ['Processing fee', `${pct(estimate.feeBps)} = ${rupees(estimate.processingFee)}`],
      ['Instalments', `${estimate.instalments} ${label(estimate.frequency).toLowerCase()}`], ['Estimated instalment', rupees(estimate.instalment)], ['Total interest', rupees(estimate.totalInterest)], ['Total repayment', rupees(estimate.totalRepayment)], ['Allowed amount', `${rupees(ps.min_amount)} to ${rupees(ps.max_amount)}`]]),
      elig && h('div', { class: 'mt' }, h('strong', {}, 'Preliminary eligibility: '), elig.evaluated ? pill(elig.eligible ? 'PASSED' : 'FAILED', elig.eligible ? 'Likely eligible' : 'Not eligible') : pill('NOT_REACHABLE', 'Not evaluated'), h('div', { class: 'small muted' }, 'Preliminary only. Final decision rests with Accounts and Admin.'),
        h('ul', { class: 'small' }, elig.checks.map(c => h('li', {}, (c.passed ? '✓ ' : '✗ ') + c.name + ': ' + c.detail))))); }, 300); };
  const $est = () => root.querySelector('#est');
  const stepLoan = () => { const prod = h('select', { id: 'f_product', onchange: e => { form.productId = e.target.value; const p = products.find(x => x.id === Number(form.productId)); if (p) form.term = p.term; refreshEstimate(); } }, h('option', { value: '' }, products.length ? 'Select a product' : 'No loan products are available'), products.map(p => h('option', { value: p.id, selected: Number(form.productId) === p.id }, `${p.name} (${rupees(p.min_amount)} - ${rupees(p.max_amount)})`)));
    const amt = bind('amountText', { mode: 'decimal', after: refreshEstimate }); const p = products.find(x => x.id === Number(form.productId)); setTimeout(refreshEstimate, 0);
    return h('div', {}, !products.length && h('div', { class: 'banner warn' }, 'No usable loan product exists. Ask the Admin to configure and activate one (including the interest rate period and method).'), field('Loan product *', prod), field('Requested amount (₹) *', amt, { hint: p ? `between ${rupees(p.min_amount)} and ${rupees(p.max_amount)}` : '' }),
      p && field('Number of instalments', h('input', { id: 'f_term', type: 'number', min: 1, max: p.term, value: form.term || p.term, oninput: e => { form.term = e.target.value; refreshEstimate(); } }), { hint: `up to ${p.term}, ${label(p.frequency).toLowerCase()}` }), h('div', { id: 'est', class: 'card flat' }, h('span', { class: 'muted' }, 'Choose a product and amount.'))); };
  const stepBank = () => h('div', {}, h('div', { class: 'banner info' }, 'Bank details are recorded as entered. Account ownership is not verified by this app.'), h('div', { class: 'grid g2' }, field('Account holder name *', bindBank('holder')), field('Bank name *', bindBank('bankName')),
    field('Account number *', bindBank('account', { mode: 'numeric', type: 'password' })), field('Confirm account number *', bindBank('confirmAccount', { mode: 'numeric' })), field('IFSC code *', bindBank('ifsc', { upper: true }), { hint: 'e.g. SBIN0001234' })), docBox('BANK_PROOF', 'Bank passbook / cheque (optional)', false));
  const bankErrors = () => { const b = form.bank, e = []; if (!b.holder?.trim()) e.push('Account holder name is required.'); if (!b.bankName?.trim()) e.push('Bank name is required.'); if (!/^\d{9,18}$/.test(b.account || '')) e.push('Account number must be 9 to 18 digits.'); if (b.account !== b.confirmAccount) e.push('Account numbers do not match.'); if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(b.ifsc || '')) e.push('IFSC must look like SBIN0001234.'); return e; };
  const loanErrors = () => { sync(); const e = []; const p = products.find(x => x.id === Number(form.productId)); if (!p) e.push('Select a loan product.'); else if (!(form.amount >= p.min_amount && form.amount <= p.max_amount)) e.push(`Amount must be between ${rupees(p.min_amount)} and ${rupees(p.max_amount)}.`); if (p && (Number(form.term) > p.term || Number(form.term) < 1)) e.push(`Instalments must be between 1 and ${p.term}.`); return e; };
  const stepReview = () => { const p = products.find(x => x.id === Number(form.productId)); const mask = v => v ? 'X'.repeat(Math.max(0, v.length - 4)) + v.slice(-4) : '-';
    return h('div', {}, h('div', { class: 'card flat' }, h('h3', {}, 'Customer'), kv([['Name', form.name], ['Date of birth', fmtDate(form.dob)], ['Mobile', `${form.mobile} ✓ OTP verified`], ['Address', form.address], ['Occupation', form.occupation], ['Monthly income', rupees(form.income)], ['Family', `${form.adults} adults, ${form.children} children`], ['Voter ID', mask(form.voter)], form.pan && ['PAN', mask(form.pan)], form.aadhaar && ['Aadhaar', mask(form.aadhaar.replace(/\s/g, ''))]])),
      h('div', { class: 'card flat' }, h('h3', {}, 'Loan request (provisional)'), kv([['Product', p?.name], ['Amount', rupees(form.amount)], ['Instalments', `${form.term || p?.term} ${label(p?.frequency).toLowerCase()}`], estimate && ['Estimated instalment', rupees(estimate.instalment)], elig && ['Preliminary eligibility', elig.evaluated ? (elig.eligible ? 'Likely eligible' : 'Not eligible (Admin may override)') : 'Not evaluated']])),
      h('div', { class: 'card flat' }, h('h3', {}, 'Bank'), kv([['Holder', form.bank.holder], ['Bank', form.bank.bankName], ['Account', mask(form.bank.account)], ['IFSC', form.bank.ifsc]])),
      h('div', { class: 'card flat' }, h('h3', {}, 'Documents'), h('div', { class: 'row' }, Object.entries(docs).filter(([, d]) => d.state === 'done').map(([t, d]) => h('div', { style: 'text-align:center;font-size:.75rem' }, d.url ? h('img', { src: d.url, alt: label(t), style: 'width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line)' }) : h('div', { class: 'thumb' }, 'PDF'), h('div', {}, label(t)))))), h('p', { class: 'muted small' }, 'Use Back to correct anything before submitting.')); };
  const stepDone = () => h('div', { class: 'card' }, h('div', { class: 'banner ok' }, h('strong', {}, 'Application submitted. '), `Reference ${result.ref}. It is now with the Accounts team.`), result.eligibility && !result.eligibility.eligible && h('div', { class: 'banner warn' }, 'Preliminary eligibility was not met; Admin approval will require an override.'),
    h('h3', {}, 'What happens next'), h('ol', {}, h('li', {}, 'Accounts verifies by phone.'), h('li', {}, 'Admin reviews documents and does physical verification.'), h('li', {}, 'You print the agreement, get it signed and upload it.'), h('li', {}, 'Admin gives final approval and disburses.')), h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `#/application/${appId}` }, 'Track application'), h('a', { class: 'btn', href: '#/add' }, 'Add another customer'), h('a', { class: 'btn', href: '#/customers' }, 'Customer list')));

  function render() {
    const body = [stepPersonal, stepOtp, stepLoan, stepBank, stepReview, stepDone][step]();
    const next = h('button', { class: 'primary', type: 'button' }, step === 4 ? 'Submit application' : 'Next'); const back = h('button', { type: 'button', onclick: () => { showErr([]); step = step === 2 ? 0 : step - 1; render(); } }, 'Back'); const draft = h('button', { type: 'button', onclick: e => run(e.target, () => save()) }, 'Save draft');
    next.onclick = async () => { showErr([]); next.disabled = true; try {
      if (step === 0) { if (showErr(personalErrors())) return; await save(true); if (form.otpVerifiedMobile === form.mobile) { step = 2; } else { otp = { sent: false }; step = 1; } }
      else if (step === 2) { if (showErr(loanErrors())) return; await save(true); step = 3; }
      else if (step === 3) { if (showErr(bankErrors())) return; await save(true); step = 4; }
      else if (step === 4) { await save(true); result = await POST(`/api/applications/${appId}/submit`); step = 5; toast('Application submitted', 'ok'); }
      render(); } catch (e) { showErr(e.message.split('\n').filter(Boolean)); } finally { next.disabled = false; } };
    root.replaceChildren(h('h1', {}, params[0] || appId ? 'Continue customer application' : 'Add customer'), h('div', { class: 'steps', role: 'progressbar', 'aria-valuenow': step + 1, 'aria-valuemax': 6 }, STEPS.map((_, i) => h('div', { class: 's ' + (i < step ? 'done' : i === step ? 'cur' : '') }))),
      h('div', { class: 'stepname' }, `Step ${step + 1} of 6: ${STEPS[step]}`), errBox, h('div', { class: 'card' }, body),
      step < 5 && h('div', { class: 'row between' }, h('div', { class: 'row' }, step > 0 && step !== 1 && h('button', { type: 'button', onclick: () => { showErr([]); step--; render(); } }, 'Back'), step === 1 && back, draft), step !== 1 && next));
    if (step === 2) refreshEstimate();
  }
  if (form.otpVerifiedMobile) otp.sent = false; render(); return root;
}

// ================= Collect payment =================
export async function collect({ params, user }) {
  const root = h('div', {}); let search = ''; const list = h('div', {}); const formBox = h('div', {});
  async function showList() { formBox.replaceChildren(); list.replaceChildren(loading()); try { const d = await GET('/api/loans', { status: 'ACTIVE', search });
    list.replaceChildren(d.loans.length ? d.loans.map(l => h('a', { class: 'rowcard', href: `#/collect/${l.id}` }, h('div', { class: 'row between' }, h('strong', {}, l.customerName), h('span', { class: 'muted small' }, `${l.customerRef} · ${l.ref}`)),
      h('div', { class: 'row small muted', style: 'gap:1rem' }, h('span', {}, 'Principal outstanding ' + rupees(l.outstandingPrincipal)), h('span', {}, 'Next due ' + fmtDate(l.nextDueDate)), l.overdueAmount > 0 && h('span', { style: 'color:var(--bad);font-weight:600' }, 'Overdue ' + rupees(l.overdueAmount))))) : h('div', { class: 'card empty' }, search ? 'No matching active loans.' : 'No active loans you can collect from.')); } catch (e) { list.replaceChildren(errorBox(e)); } }
  async function showForm(id) {
    list.replaceChildren(); formBox.replaceChildren(loading()); const d = await GET('/api/loans/' + id); const L = d.loan, s = d.summary; if (L.status !== 'ACTIVE') { formBox.replaceChildren(h('div', { class: 'banner warn' }, 'This loan is not active.'), h('a', { href: '#/collect' }, 'Back')); return; }
    let key = uid(); const due = s.overdueAmount > 0 ? s.overdueAmount : s.nextDueAmount; const amount = h('input', { id: 'c_amt', inputmode: 'decimal', value: rupeesInput(due), 'aria-label': 'Collection amount' }); const method = h('select', { id: 'c_method' }, ['CASH', 'BANK_TRANSFER', 'UPI', 'OTHER'].map(m => h('option', { value: m }, label(m))));
    const ref = h('input', { id: 'c_ref' }), remarks = h('input', { id: 'c_rem' }); const refField = field('Reference number', ref, { hint: 'required for bank transfer / UPI' }); const btn = h('button', { class: 'primary' }, 'Confirm collection'); const msg = h('div', {});
    btn.onclick = async () => { const p = parseRupees(amount.value); if (!p || p <= 0) return toast('Enter a valid amount.', 'bad'); if (p > s.outstandingTotal) return toast(`Amount exceeds the total outstanding of ${rupees(s.outstandingTotal)}.`, 'bad'); if (method.value !== 'CASH' && !ref.value.trim() && method.value !== 'OTHER') return toast('Enter the reference number.', 'bad');
      if (!await confirmBox('Confirm collection', `Record ${rupees(p)} (${label(method.value)}) from ${d.customer.name} for ${L.ref}?`, 'Record payment')) return;
      btn.disabled = true; try { const r = await api('POST', `/api/loans/${id}/payments`, { amount: p, method: method.value, reference: ref.value, remarks: remarks.value, deviceTime: new Date().toISOString() }, { 'idempotency-key': key });
        formBox.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'banner ok' }, h('strong', {}, `${rupees(p)} recorded. `), `Receipt ${r.receiptNo}${r.duplicate ? ' (this was already recorded; no duplicate created)' : ''}.`, r.loanClosed && ' The loan is now fully settled and closed.', method.value === 'CASH' && h('div', { class: 'small' }, 'Cash collected. This does not confirm bank deposit.')),
          h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `#/receipt/${r.paymentId}` }, 'View / print receipt'), h('a', { class: 'btn', href: `#/loan/${id}` }, 'Loan details'), h('a', { class: 'btn', href: '#/collect' }, 'Collect another')))); } catch (e) { toast(e.message, 'bad'); btn.disabled = false; } };
    method.onchange = () => { refField.style.opacity = method.value === 'CASH' ? .6 : 1; };
    formBox.replaceChildren(h('a', { href: '#/collect' }, '← All customers'), h('div', { class: 'card mt' }, h('h2', {}, d.customer.name), h('div', { class: 'muted' }, `${d.customer.ref} · Loan ${L.ref}`),
      h('div', { class: 'grid g4 mt' }, tile('Outstanding principal', rupees(s.outstandingPrincipal)), tile('Total outstanding', rupees(s.outstandingTotal)), tile('Amount due', rupees(due), null, s.overdueAmount ? 'bad' : ''), tile('Next due', fmtDate(s.nextDueDate))),
      s.overdueAmount > 0 && h('div', { class: 'banner warn mt' }, `${rupees(s.overdueAmount)} overdue (includes penalty ${rupees(s.penaltyOutstanding)}).`), s.lastPaymentAt && h('div', { class: 'muted small' }, 'Last payment: ' + fmtDT(s.lastPaymentAt))),
      h('div', { class: 'card' }, h('h2', {}, 'Record collection'), h('div', { class: 'grid g2' }, field('Collection amount (₹)', amount), field('Payment method', method), refField, field('Collection date', h('input', { value: fmtDate(todayIso()), readonly: true, 'aria-readonly': 'true' }), { hint: "today, set by the server" })), field('Remarks (optional)', remarks), msg, btn));
  }
  const input = h('input', { type: 'search', placeholder: 'Search name, customer ref or loan ref', 'aria-label': 'Search' }); let t; input.oninput = () => { clearTimeout(t); t = setTimeout(() => { search = input.value; showList(); }, 250); };
  root.append(pageHead('Collect payment'), params[0] ? null : h('div', { class: 'mb', style: 'max-width:420px' }, input), list, formBox); params[0] ? await showForm(params[0]) : await showList(); return root;
}

// ================= Overdue =================
export async function overdue({ user }) {
  const d = await GET('/api/overdue');
  return h('div', {}, pageHead('Overdue customers', `${d.rows.length} loans · total overdue ${rupees(d.totalOverdue)}`),
    table([{ h: 'Customer', f: r => h('div', {}, h('strong', {}, r.customerName), h('div', { class: 'muted small' }, `${r.customerRef} · ${r.mobile}`)) }, { h: 'Loan', f: r => h('a', { href: `#/loan/${r.loanId}` }, r.loanRef) }, { h: 'Oldest due', f: r => `${r.maxDaysOverdue} days late` },
      { h: 'Instalments', num: true, f: r => r.overdueCount }, { h: 'Penalty', num: true, f: r => rupees(r.penaltyOutstanding) }, { h: 'Total due', num: true, f: r => h('strong', { style: 'color:var(--bad)' }, rupees(r.overdueAmount)) }, { h: 'Last payment', f: r => fmtDate(r.lastPaymentAt ? new Date(r.lastPaymentAt + 5.5 * 3600e3).toISOString().slice(0, 10) : null) },
      { h: 'Follow-up', f: r => h('div', {}, pill(r.followupStatus === 'NONE' ? 'DRAFT' : r.followupStatus, r.followupStatus === 'NONE' ? 'None' : label(r.followupStatus)), r.followupNote && h('div', { class: 'muted small' }, r.followupNote)) },
      { h: '', f: r => h('a', { class: 'btn sm primary', href: `#/collect/${r.loanId}` }, 'Collect') }], d.rows, { empty: 'No overdue loans. All instalments are up to date.' }));
}
