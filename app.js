(() => {
'use strict';

const BATCH_SIZE    = 50;     
const SCAN_COOLDOWN = 3000;  
const FETCH_TIMEOUT = 20000; 
const TZ            = 'Africa/Cairo'; 

const $ = id => document.getElementById(id);
const norm = v => String(v ?? '').trim().toLowerCase();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const shortDate = ts => new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', timeZone: TZ });

const isManual   = () => meta.pick && meta.pick !== 'auto';
const curSession = () => isManual() ? Number(meta.pick) : (meta.serverSession || meta.session || null);

function presentCount() {
  return students.filter(st => isRegistered(st)).length;
}
function isRegistered(st) {
  const n = curSession();
  if (Array.isArray(st.att) && n) return !!st.att[n - 1];
  return !!st.checkedIn;
}
function markAttended(st, ts, session) {
  const n = session || curSession();
  if (!Array.isArray(st.att) || !n) return;
  if (n - 1 < st.att.length) st.att[n - 1] = shortDate(ts);
}
const fmtMoney = n => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { toast('Storage is full or blocked on this device', 'bad'); return false; }
  }
};

let students = store.get('icpc.students', []);      
let records  = store.get('icpc.records', []);    
let cfg      = store.get('icpc.cfg', { url: '', code: '' });
let meta     = store.get('icpc.meta', { studentsAt: 0, syncAt: 0 });
let index    = new Map();
let current  = null;    
let syncing  = false;
let scanner  = null, scanning = false;
let lastText = '', lastAt = 0;

const rebuildIndex = () => { index = new Map(students.map(s => [norm(s.id), s])); };
const saveStudents = () => store.set('icpc.students', students);
const saveRecords  = () => store.set('icpc.records', records);

let toastTimer;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = kind + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function go(view) {
  ['scan', 'log', 'set'].forEach(v => {
    const el = $('view-' + v);
    if (el) el.hidden = v !== view;
  });
  document.querySelectorAll('nav [data-go]').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.go === view)));
  if (view !== 'scan') stopCamera();
  if (view === 'log') { renderLog(); renderToday(); refreshStudents(true); }
  window.scrollTo(0, 0);
}

function updateSessionUI() {
  const sel = $('sessSel');
  if (!sel) return;
  const n = (students[0] && Array.isArray(students[0].att) && students[0].att.length) || 8;
  const serverNo = meta.serverSession || meta.session;

  sel.textContent = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = 'Auto' + (serverNo ? ` (${serverNo})` : '');
  sel.appendChild(auto);
  for (let k = 1; k <= n; k++) {
    const o = document.createElement('option');
    o.value = String(k);
    o.textContent = String(k);
    sel.appendChild(o);
  }
  if (isManual() && Number(meta.pick) > n) meta.pick = 'auto';
  sel.value = isManual() ? String(meta.pick) : 'auto';

  const chip = sel.parentNode;                      // gold chip = session chosen by hand
  chip.style.background = isManual() ? '#F7B500' : '';
  chip.style.color = isManual() ? '#08142B' : '';
}

function resetVerdict() {
  const v = $('verdict');
  v.className = 'verdict';
  $('vIdle').hidden = false;
  $('vBody').hidden = true;
  current = null;
}

function sessionTotals(n) {
  const t = (meta.totals && meta.totals[n - 1]) || { count: 0, paid: 0, remaining: 0 };
  let count = t.count, paid = t.paid, rem = t.remaining;
  records.forEach(r => {
    if ((r.session || curSession()) !== n) return;
    const notInList = r.status === 'pending' || (r.status === 'synced' && r.syncedAt > (meta.studentsAt || 0));
    if (!notInList) return;
    if (r.type === 'checkin') count++;
    if (r.type === 'payment') { paid += Number(r.paid) || 0; rem += Number(r.balance) || 0; }
  });
  return { count, paid, rem, ours: paid - rem };
}

function renderToday() {
  let box = $('todayBox');
  if (!box) {
    const sum = document.querySelector('#view-log .sum');
    if (!sum) return;
    box = document.createElement('div');
    box.id = 'todayBox';
    const title = document.createElement('div');
    title.id = 'todayTitle';
    title.style.cssText = 'font-size:13px;font-weight:700;color:var(--muted);margin:0 2px 8px';
    const grid = document.createElement('div');
    grid.className = 'sum';
    grid.id = 'todayGrid';
    [['tAtt', 'Attended', 'var(--ink)'], ['tAll', 'Collected', 'var(--green)'],
     ['tOurs', 'With us', 'var(--gold)'], ['tRem', 'Remaining', 'var(--blue-soft)']].forEach(([id, label, color]) => {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.id = id;
      b.style.color = color;
      d.append(b, label);
      grid.appendChild(d);
    });
    box.append(title, grid);
    sum.before(box);
  }
  const n = curSession();
  box.hidden = !n || !students.length;
  if (!n) return;
  const t = sessionTotals(n);
  $('todayTitle').textContent = `Session ${n} · all devices`;
  $('tAtt').textContent  = t.count;
  $('tAll').textContent  = fmtMoney(t.paid);
  $('tOurs').textContent = fmtMoney(t.ours);
  $('tRem').textContent  = fmtMoney(t.rem);
}

function updateCounts() {
  const c = { synced: 0, pending: 0, failed: 0 };
  records.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });

  $('cStudents').textContent = students.length;
  updateSessionUI();
  renderToday();
  if ($('cPresent')) $('cPresent').textContent = `${presentCount()} / ${students.length}`;
  $('cPending').textContent  = c.pending;
  $('cFail').textContent     = c.failed;
  $('chipFail').hidden       = c.failed === 0;
  const fb = $('clearFailBtn'); if (fb) fb.disabled = c.failed === 0;

  $('sTotal').textContent   = records.length;
  $('sSynced').textContent  = c.synced;
  $('sPending').textContent = c.pending;
  $('sFail').textContent    = c.failed;

  $('banner').hidden = students.length > 0;

  $('studentsInfo').textContent = students.length
    ? `${students.length} students · updated ${new Date(meta.studentsAt).toLocaleString()}`
    : 'No student list on this device yet.';
  $('syncInfo').textContent = meta.syncAt
    ? `Last sync: ${new Date(meta.syncAt).toLocaleString()}`
    : 'Nothing synced yet.';
}

function updateNet() {
  const on = navigator.onLine;
  $('dot').classList.toggle('off', !on);
  $('netTxt').textContent = on ? 'Online' : 'Offline';
}

function renderLog() {
  const ul = $('logList');
  ul.textContent = '';
  [...records].reverse().forEach(r => {
    const li = document.createElement('li');
    li.className = r.status === 'failed' ? 'fail' : r.status;

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.textContent = r.name || r.id;
    const sub = document.createElement('small');
    const what = r.type === 'payment' ? `Paid ${fmtMoney(r.paid)} · remaining ${fmtMoney(r.balance)}`
               : r.type === 'settle'  ? `Returned ${fmtMoney(r.amount)}`
               : 'Check-in';
    sub.textContent = `${r.id} · ${what}` + (r.error ? ` · ${r.error}` : '');
    left.append(name, sub);

    const right = document.createElement('small');
    right.className = 't';
    right.textContent = `${fmtTime(r.ts)} · ${r.status}`;

    li.append(left, right);
    ul.appendChild(li);
  });
}

function renderRemaining(st) {
  let box = $('vRem');
  if (!box) {
    box = document.createElement('div');
    box.id = 'vRem';
    box.className = 'owed';
    box.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px';
    const txt = document.createElement('span');
    txt.id = 'vRemTxt';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn light';
    btn.style.cssText = 'min-height:40px;padding:0 14px;font-size:14px';
    btn.textContent = 'Returned';
    btn.addEventListener('click', settleRemaining);
    box.append(txt, btn);
    $('vOwed').after(box);
  }
  const rem = st ? Number(st.remaining) || 0 : 0;
  box.hidden = !(rem > 0);
  $('vRemTxt').textContent = `Remaining balance: ${fmtMoney(rem)}`;
}

function settleRemaining() {
  if (!current) return;
  const st = index.get(norm(current.id)) || current;
  const amount = Number(st.remaining) || 0;
  if (!(amount > 0)) return;
  if (!confirm(`Confirm: ${fmtMoney(amount)} was given back to ${st.name}?`)) return;

  records.push({ uid: uid(), type: 'settle', id: st.id, name: st.name, ts: Date.now(), amount, status: 'pending' });
  st.remaining = 0;
  saveRecords(); saveStudents(); updateCounts();
  renderRemaining(st);
  toast('Remaining cleared', 'ok');
  if (navigator.onLine && cfg.url) sync(true).then(() => refreshStudents(true));
}

function renderInfo(st) {
  let box = $('vInfo');
  if (!box) {
    box = document.createElement('div');
    box.id = 'vInfo';
    box.style.cssText = 'margin-top:12px';
    const stats = document.createElement('div');
    stats.id = 'vStats';
    stats.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    const sess = document.createElement('div');
    sess.id = 'vSess';
    sess.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px';
    box.append(stats, sess);
    $('vMeta').after(box);
  }
  box.hidden = !st;
  const stats = $('vStats'), sess = $('vSess');
  stats.textContent = ''; sess.textContent = '';
  if (!st) return;

  const addStat = (label, value) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.style.cssText = 'background:rgba(0,0,0,.28);color:#fff;border-color:transparent;font-size:13px';
    c.append(label + ' ');
    const b = document.createElement('b');
    b.textContent = fmtMoney(value);
    b.style.color = '#fff';
    c.appendChild(b);
    stats.appendChild(c);
  };
  if (typeof st.totalPaid === 'number') addStat('Total paid', st.totalPaid);
  addStat('Amount still owed', Number(st.owed) || 0);

  const att = Array.isArray(st.att) ? st.att : [];
  att.forEach((d, i) => {
    const c = document.createElement('span');
    c.className = 'chip';
    if (d) {
      c.style.cssText = 'background:#fff;color:#0E1F3D;font-weight:700;border-color:transparent';
      c.textContent = `S${i + 1} ✓ ${d}`;
    } else if (curSession() === i + 1) {
      c.style.cssText = 'background:transparent;color:#fff;font-weight:700;border:1.5px dashed #fff';
      c.textContent = `S${i + 1} · today`;
    } else {
      c.style.cssText = 'background:rgba(0,0,0,.2);color:rgba(255,255,255,.7);border-color:transparent';
      c.textContent = `S${i + 1}`;
    }
    sess.appendChild(c);
  });
  sess.hidden = att.length === 0;
}

function show(state, title, st, extra = {}) {
  const v = $('verdict');
  v.className = 'verdict ' + state;
  void v.offsetWidth;              
  v.classList.add('pop');

  $('vIdle').hidden = true;
  $('vBody').hidden = false;
  $('vTitle').textContent = title;
  $('vName').textContent  = st ? st.name : (extra.id || '');

  const m = $('vMeta');
  m.textContent = '';

  if (st) {
    const groupName = String(st.group ?? st.team ?? '').trim();
    const rawGroupNumber = String(st.num ?? st.numGroup ?? '').trim();
    const groupNumber = Number(rawGroupNumber);

    if (groupName) {
      const groupBadge = document.createElement('span');
      groupBadge.classList.add('group-badge');

      if (
        rawGroupNumber !== '' &&
        Number.isInteger(groupNumber) &&
        groupNumber >= 1 &&
        groupNumber <= 8
      ) {
        groupBadge.classList.add(`group-color-${groupNumber}`);
      }

      groupBadge.textContent = groupName;
      m.appendChild(groupBadge);
    }

    [st.university, st.phone, extra.id]
      .filter(Boolean)
      .forEach(value => {
        const span = document.createElement('span');
        span.textContent = value;
        m.appendChild(span);
      });
  } else if (extra.id) {
    const span = document.createElement('span');
    span.textContent = extra.id;
    m.appendChild(span);
  }

  const form = !!extra.form;        
  $('vOwed').hidden = true;         
  renderInfo(st);

  const noteEl = $('vNote');
  noteEl.textContent = '';
  const statusNote = extra.note || '';
  const desc = (st && st.note) || '';
  if (statusNote) {
    const d = document.createElement('div');
    d.textContent = statusNote;
    noteEl.appendChild(d);
  }
  if (desc) {
    const d = document.createElement('div');
    d.textContent = '📝 ' + desc;
    d.style.cssText = 'font-weight:700;white-space:pre-wrap;word-break:break-word' + (statusNote ? ';margin-top:8px' : '');
    noteEl.appendChild(d);
  }
  noteEl.hidden = !(statusNote || desc);

  $('vPay').hidden = !form;
  if (form) $('payBtn').textContent = 'Save & Check In';
  $('payIn').value = ''; $('balIn').value = '';
  current = st || null;
  renderRemaining(st);

  if (navigator.vibrate) navigator.vibrate(state === 'ok' ? 60 : [80, 60, 80]);
}

function extractId(text) {
  const t = String(text).trim();
  try {
    const u = new URL(t);
    return u.searchParams.get('id') || u.pathname.split('/').filter(Boolean).pop() || t;
  } catch { return t; }
}

function checkIn(raw) {
  const id = extractId(raw);
  if (!id) { toast('Enter an ID first', 'bad'); return; }
  if (!students.length) { toast('Download the student list first', 'bad'); go('set'); return; }
  if (!curSession()) { toast('Session unknown. Refresh the student list or pick a session', 'bad'); return; }

  const st = index.get(norm(id));
  if (!st) { show('bad', 'Not registered', null, { id }); return; }

  const prev = records.find(r => r.type === 'checkin' && r.status === 'pending' && (!r.session || r.session === curSession()) && norm(r.id) === norm(st.id));
  if (prev || isRegistered(st)) {
    show('dup', 'Already checked in', st, {
      id: st.id,
      note: prev ? `Session ${curSession()} · checked in at ${fmtTime(prev.ts)}` : `Already checked in for session ${curSession()}`
    });
    return;
  }

  show('warn', `Session ${curSession()}: enter payment, then press Save`, st, { id: st.id, form: true });
}

function savePayment() {
  if (!current) return;
  const st = index.get(norm(current.id)) || current;  
  if (isRegistered(st)) return;
  const session = curSession();

  const payRaw = $('payIn').value;
  const balRaw = $('balIn').value;
  const pay = payRaw === '' ? 0 : parseFloat(payRaw);
  if (isNaN(pay) || pay < 0) { toast('Check the amount paid', 'bad'); return; }

  const bal = balRaw === '' ? 0 : Math.max(parseFloat(balRaw) || 0, 0);
  const ts = Date.now();
  const group = uid();              

  records.push({ uid: uid(), type: 'checkin', id: st.id, name: st.name, ts, group, session, manual: isManual(), status: 'pending' });
  if (pay > 0 || balRaw !== '') {
    records.push({ uid: uid(), type: 'payment', id: st.id, name: st.name, ts, group, session, manual: isManual(), paid: pay, balance: bal, status: 'pending' });
  }

  st.checkedIn = true;
  if (pay > 0 || balRaw !== '') st.remaining = bal;
  markAttended(st, ts, session);
  if (typeof st.totalPaid === 'number') st.totalPaid += pay;
  saveRecords(); saveStudents(); updateCounts();

  show('ok', 'Registered', st, {
    id: st.id,
    note: `Paid ${fmtMoney(pay)} · Remaining ${fmtMoney(bal)}`
  });
  toast('Saved', 'ok');
  if (navigator.onLine && cfg.url) sync(true).then(() => refreshStudents(true));
}

async function startCamera() {
  if (scanning) return;
  if (typeof Html5Qrcode === 'undefined') { toast('Scanner library did not load', 'bad'); return; }
  try {
    scanner = scanner || new Html5Qrcode('reader');
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
      onScan,
      () => {}
    );
    scanning = true;
    $('camBtn').textContent = 'Stop Camera';
    $('camBtn').classList.remove('blue');
    $('camBtn').classList.add('ghost');
  } catch (e) {
    toast('Cannot open the camera. Allow camera access and try again.', 'bad');
  }
}

async function stopCamera() {
  if (!scanner || !scanning) return;
  scanning = false;
  try { await scanner.stop(); } catch {}
  $('camBtn').textContent = 'Start Camera';
  $('camBtn').classList.add('blue');
  $('camBtn').classList.remove('ghost');
}

function onScan(text) {
  const now = Date.now();
  if (text === lastText && now - lastAt < SCAN_COOLDOWN) return;
  lastText = text; lastAt = now;
  checkIn(text);
}

function needCfg() {
  if (!cfg.url || !cfg.code) { toast('Enter the Web App URL and secret code in Settings', 'bad'); return true; }
  return false;
}

async function request(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('Server error ' + res.status);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch {
      throw new Error('The URL returned a web page, not data. Redeploy the Apps Script as a New version, set access to Anyone, and use the /exec link.');
    }
  } finally { clearTimeout(timer); }
}

async function refreshStudents(silent = false) {
  if (silent === true) {
    if (!cfg.url || !cfg.code || !navigator.onLine) return;
    if (!$('vPay').hidden) return;               // don't swap the list while a payment is being typed
  } else {
    if (needCfg()) return;
    if (!navigator.onLine) { toast('You are offline', 'bad'); return; }
  }
  const btn = $('refreshBtn');
  if (!silent) { btn.disabled = true; btn.textContent = 'Downloading…'; }
  try {
    const q = new URLSearchParams({ action: 'students', code: cfg.code });
    const data = await request(cfg.url + (cfg.url.includes('?') ? '&' : '?') + q);
    if (!data.ok) throw new Error(data.error || 'Request rejected');
    students = data.students || [];
    if (data.session) meta.serverSession = data.session;
    if (Array.isArray(data.totals)) meta.totals = data.totals;

    
    const byId = new Map(students.map(x => [norm(x.id), x]));
    records.filter(r => r.status === 'pending').forEach(r => {
      const st = byId.get(norm(r.id));
      if (!st) return;
      if (r.type === 'checkin') {
        st.checkedIn = true;
        markAttended(st, r.ts, r.session);
      }
      if (r.type === 'payment') {
        st.remaining = r.balance;
        if (typeof st.totalPaid === 'number') st.totalPaid += Number(r.paid) || 0;
      }
      if (r.type === 'settle') st.remaining = 0;
    });

    meta.studentsAt = Date.now();
    saveStudents(); store.set('icpc.meta', meta);
    rebuildIndex(); updateCounts();
    if (current && $('vPay').hidden && !$('vBody').hidden) {
      const live = index.get(norm(current.id));
      if (live) { current = live; renderInfo(live); renderRemaining(live); }
    }
    if (!silent) toast(`${students.length} students downloaded`, 'ok');
  } catch (e) {
    if (!silent) toast(e.name === 'AbortError' ? 'Request timed out' : e.message, 'bad');
  } finally {
    if (!silent) { btn.disabled = false; btn.textContent = 'Refresh Student List'; }
  }
}

async function sync(silent = false) {
  if (syncing) return;
  if (!cfg.url || !cfg.code) { if (!silent) needCfg(); return; }
  if (!navigator.onLine) { if (!silent) toast('You are offline', 'bad'); return; }

  const todo = records.filter(r => r.status !== 'synced');
  if (!todo.length) { if (!silent) toast('Everything is already synced'); return; }

  syncing = true;
  const btn = $('syncBtn');
  btn.disabled = true; btn.textContent = 'Syncing…';
  let done = 0, failed = 0, networkError = '';

  try {
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
      const batch = todo.slice(i, i + BATCH_SIZE);
      const payload = {
        action: 'sync', code: cfg.code,
        records: batch.map(({ uid, type, id, ts, paid, balance, group, session, manual }) => ({ uid, type, id, ts, paid, balance, group, session, manual }))
      };
      let data;
      try {
        data = await request(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        });
      } catch (e) {
        networkError = e.name === 'AbortError' ? 'Request timed out' : 'Network error';
        break;                                  // keep these as pending, try later
      }
      if (!data.ok) { networkError = data.error || 'Request rejected'; break; }

      const results = new Map((data.results || []).map(r => [r.uid, r]));
      batch.forEach(rec => {
        const r = results.get(rec.uid);
        if (!r || r.ok) { rec.status = 'synced'; rec.syncedAt = Date.now(); delete rec.error; done++; }
        else { rec.status = 'failed'; rec.error = r.error || 'Rejected'; failed++; }
      });
      saveRecords();
    }
    if (done) { meta.syncAt = Date.now(); store.set('icpc.meta', meta); }
  } finally {
    syncing = false;
    btn.disabled = false; btn.textContent = 'Sync Now';
    updateCounts();
    if ($('view-log').hidden === false) renderLog();
  }

  if (networkError) { if (!silent) toast(networkError, 'bad'); }
  else if (!silent || failed) {
    toast(failed ? `${done} synced, ${failed} failed` : `${done} records synced`, failed ? 'bad' : 'ok');
  }
}

async function copyUnsynced() {
  const list = records.filter(r => r.status !== 'synced');
  if (!list.length) { toast('No unsynced records'); return; }
  const text = JSON.stringify(list, null, 2);
  try { await navigator.clipboard.writeText(text); toast(`${list.length} records copied`, 'ok'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(`${list.length} records copied`, 'ok'); }
    catch { toast('Copy failed', 'bad'); }
    ta.remove();
  }
}

function clearSynced() {
  const n = records.filter(r => r.status === 'synced').length;
  if (!n) { toast('No synced records to clear'); return; }
  if (!confirm(`Remove ${n} synced records from this device?\nUnsynced records will be kept.`)) return;
  records = records.filter(r => r.status !== 'synced');
  saveRecords(); updateCounts(); renderLog();
  toast('Synced records cleared', 'ok');
}

function clearFailed() {
  const n = records.filter(r => r.status === 'failed').length;
  if (!n) { toast('No failed records'); return; }
  if (!confirm(`Remove ${n} failed records from this device?\nCheck them in the sheet first.`)) return;
  records = records.filter(r => r.status !== 'failed');
  saveRecords(); updateCounts(); renderLog();
  toast('Failed records cleared', 'ok');
}

function init() {
  const sc = document.createElement('span');
  sc.className = 'chip';
  sc.append('Session ');
  const sb = document.createElement('select');
  sb.id = 'sessSel';
  sb.setAttribute('aria-label', 'Session');
  sb.style.cssText = 'background:transparent;color:inherit;border:0;font:inherit;font-weight:700;padding:0;margin:0;cursor:pointer';
  sb.addEventListener('change', () => {
    meta.pick = sb.value;
    store.set('icpc.meta', meta);
    updateCounts();
    resetVerdict();
    toast(isManual() ? `Registering for session ${meta.pick}` : 'Following the sheet\'s session', 'ok');
  });
  sc.appendChild(sb);
  document.querySelector('.chips').prepend(sc);

  const pc = document.createElement('span');
  pc.className = 'chip';
  pc.append('Present ');
  const pb = document.createElement('b');
  pb.id = 'cPresent';
  pb.textContent = '0';
  pc.appendChild(pb);
  sc.after(pc);

  const fb = document.createElement('button');
  fb.id = 'clearFailBtn'; fb.type = 'button'; fb.className = 'btn ghost';
  fb.textContent = 'Clear Failed Records';
  fb.addEventListener('click', clearFailed);
  $('logList').before(fb);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  rebuildIndex();
  $('urlIn').value  = cfg.url;
  $('codeIn').value = cfg.code;
  $('urlIn').addEventListener('change',  e => { cfg.url  = e.target.value.trim(); store.set('icpc.cfg', cfg); });
  $('codeIn').addEventListener('change', e => { cfg.code = e.target.value.trim(); store.set('icpc.cfg', cfg); });

  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

  $('camBtn').addEventListener('click', () => scanning ? stopCamera() : startCamera());
  $('manualBtn').addEventListener('click', () => { checkIn($('manualId').value); $('manualId').value = ''; });
  $('manualId').addEventListener('keydown', e => { if (e.key === 'Enter') $('manualBtn').click(); });

  $('payBtn').addEventListener('click', savePayment);

  $('refreshBtn').addEventListener('click', () => refreshStudents(false));
  $('syncBtn').addEventListener('click', () => sync(false));
  $('copyBtn').addEventListener('click', copyUnsynced);
  $('clearBtn').addEventListener('click', clearSynced);

  window.addEventListener('online',  () => { updateNet(); sync(true).then(() => refreshStudents(true)); });
  window.addEventListener('offline', updateNet);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });

  updateNet();
  updateCounts();
  go('scan');
  if (navigator.onLine && cfg.url && cfg.code) sync(true).then(() => refreshStudents(true));
}

init();
})();