'use strict';

// Biogreen Kho – app quét mã + nhập liệu kho. Dữ liệu nằm ở Google Sheets Quan_Ly_Kho,
// đọc/ghi qua Apps Script (link trong config.js).

const CFG = window.KHO_CONFIG || {};
const KHO = ['Kho trên', 'Kho dưới', 'Kho trung tâm', 'Kho mẫu'];
const KHO_SHORT = { 'Kho trên': 'Trên', 'Kho dưới': 'Dưới', 'Kho trung tâm': 'Trung tâm', 'Kho mẫu': 'Mẫu' };
const KHO_MAU = 'Kho mẫu';
const ADMIN = 'Quản lý';
const STAFF = 'Nhân viên kho';
const MODE = {
  nhap: { title: 'Nhập kho', verb: 'Đã nhập', save: 'Lưu phiếu nhập' },
  xuat: { title: 'Xuất kho', verb: 'Đã xuất', save: 'Lưu phiếu xuất' },
  chuyen: { title: 'Chuyển kho', verb: 'Đã chuyển', save: 'Lưu phiếu chuyển' },
};
const SCAN_TITLE = { '': 'Quét mã vạch', nhap: 'Quét để nhập kho', xuat: 'Quét để xuất kho', chuyen: 'Quét để chuyển kho', kiemke: 'Quét để kiểm đếm' };
const SCREENS = ['login', 'password', 'home', 'scan', 'form', 'stock', 'kiemke', 'account'];
const LIST_LIMIT = 60;

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('vi-VN', { maximumFractionDigits: 3 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isAdmin = () => state.user && state.user.role === ADMIN;
// Tên trong tab Sản phẩm có các phần "None" (vd "phi 6 -197mm - nâu - None -None - None"): bỏ cho gọn.
const nice = (name) => String(name || '').replace(/\s*-\s*None\b/gi, '').replace(/\s+/g, ' ').trim();

const state = {
  token: null,
  user: null,
  products: [],
  byCode: new Map(),
  history: [],
  current: null,
  stack: [],
  scanMode: '',
  product: null,
  form: null,
  stockTab: 'low',
  kk: { kho: null, data: null },
};

// ───────────────────────── Lưu phiên ─────────────────────────

const SESSION_KEY = 'kho.session';
const store = {
  load() {
    try {
      const s = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
      return s ? JSON.parse(s) : null;
    } catch (e) {
      return null;
    }
  },
  save(sess, remember) {
    try {
      const keep = remember ? localStorage : sessionStorage;
      const drop = remember ? sessionStorage : localStorage;
      keep.setItem(SESSION_KEY, JSON.stringify(sess));
      drop.removeItem(SESSION_KEY);
    } catch (e) { /* trình duyệt chặn lưu: vẫn dùng được trong phiên này */ }
  },
  remembered() {
    try { return !!localStorage.getItem(SESSION_KEY); } catch (e) { return false; }
  },
  clear() {
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* bỏ qua */ }
  },
  get(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  },
  set(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* bỏ qua */ }
  },
};

// ───────────────────────── Gọi máy chủ ─────────────────────────

async function api(action, data = {}, { quiet = false } = {}) {
  if (!CFG.API_URL || !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(CFG.API_URL)) {
    throw new Error('Chưa cấu hình link máy chủ trong config.js.');
  }
  if (!quiet) busy(true);
  try {
    let res;
    try {
      res = await fetch(CFG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: state.token, data }),
      });
    } catch (e) {
      throw new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
    }
    let j;
    try {
      j = await res.json();
    } catch (e) {
      throw new Error('Máy chủ trả lời không hợp lệ. Kiểm tra lại link Apps Script.');
    }
    if (!j.ok) {
      if (j.code === 'AUTH' && action !== 'login') logout(true);
      throw new Error(j.error || 'Có lỗi xảy ra.');
    }
    return j.data;
  } finally {
    if (!quiet) busy(false);
  }
}

function setProducts(list) {
  state.products = list;
  state.byCode = new Map(list.map((p) => [p.code.toLowerCase(), p]));
}

function updateProduct(p) {
  if (!p) return;
  const old = state.byCode.get(p.code.toLowerCase());
  if (old) Object.assign(old, p);
  else {
    state.products.push(p);
    state.byCode.set(p.code.toLowerCase(), p);
  }
}

function refreshHistory() {
  api('history', {}, { quiet: true }).then((h) => {
    state.history = h;
    if (state.current === 'home') renderHome();
  }).catch(() => {});
}

// ───────────────────────── Điều hướng ─────────────────────────

function show(name, { push = true } = {}) {
  if (state.current === 'scan' && name !== 'scan') stopCamera();
  closeSheet({ silent: true });
  SCREENS.forEach((s) => { $('s-' + s).hidden = s !== name; });
  if (push && state.current && state.current !== name) {
    state.stack.push(state.current);
    history.pushState({ s: name }, '');
  }
  state.current = name;
  window.scrollTo(0, 0);
  const render = RENDER[name];
  if (render) render();
  if (name === 'scan') startCamera();
}

function goBack() {
  if (state.stack.length) history.back();
  else show('home', { push: false });
}

window.addEventListener('popstate', () => {
  if (!$('sheet').hidden) {
    closeSheet();
    history.pushState({ s: state.current }, '');
    return;
  }
  if (state.current === 'password' && state.user && state.user.mustChange) {
    history.pushState({ s: state.current }, '');
    return;
  }
  const prev = state.stack.pop();
  if (prev) show(prev, { push: false });
});

const RENDER = {
  password: renderPassword,
  home: renderHome,
  form: renderForm,
  stock: renderStock,
  kiemke: () => loadKiemke(),
  account: renderAccount,
};

// ───────────────────────── Tiện ích giao diện ─────────────────────────

let busyCount = 0;
function busy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  $('busy').hidden = busyCount === 0;
}

let toastTimer = null;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 4500 : 2500);
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg || '';
  el.hidden = !msg;
}

let sheetActions = {};
let sheetOnClose = null;

function openSheet(html, { actions = {}, onClose = null } = {}) {
  $('sheet-body').innerHTML = html;
  $('sheet').hidden = false;
  sheetActions = actions;
  sheetOnClose = onClose;
  const f = $('sheet-body').querySelector('[autofocus]');
  if (f) setTimeout(() => { f.focus(); if (f.select) f.select(); }, 60);
}

function closeSheet({ silent = false } = {}) {
  if ($('sheet').hidden) return;
  $('sheet').hidden = true;
  $('sheet-body').innerHTML = '';
  const cb = sheetOnClose;
  sheetActions = {};
  sheetOnClose = null;
  if (silent) return;
  if (cb) cb();
  // Đóng bảng ở màn quét thì quét tiếp, bỏ qua mã vừa quét thêm vài giây.
  if (state.current === 'scan') {
    cam.ignoreUntil = Date.now() + 3000;
    startCamera();
  }
}

$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) { closeSheet(); return; }
  const btn = e.target.closest('[data-act]');
  if (btn && sheetActions[btn.dataset.act]) sheetActions[btn.dataset.act](btn);
});
$('sheet').addEventListener('submit', (e) => {
  e.preventDefault();
  if (sheetActions.submit) sheetActions.submit(e.target);
});

function statusClass(s) {
  return { 'ĐỦ HÀNG': 'b-ok', 'SẮP HẾT': 'b-low', 'HẾT HÀNG': 'b-out', 'KIỂM TRA LẠI': 'b-check' }[s] || 'b-ok';
}

function searchProducts(q, list = state.products) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((p) => {
    const hay = p._hay || (p._hay = norm(p.name + ' ' + p.code));
    return words.every((w) => hay.includes(w));
  });
}

function parseQty(s) {
  const t = String(s || '').trim().replace(/\s/g, '');
  if (!t) return 0;
  // "20.000" hoặc "20,000" = hai mươi nghìn; "12,5" = mười hai phẩy năm.
  const n = /^\d{1,3}([.,]\d{3})+$/.test(t) ? Number(t.replace(/[.,]/g, '')) : Number(t.replace(',', '.'));
  return isFinite(n) ? n : NaN;
}

function stepFor(unit) {
  return /^(cái|chiếc|đôi)$/i.test(String(unit).trim()) ? 100 : 1;
}

function quickFor(unit) {
  return stepFor(unit) === 100 ? [100, 1000, 5000, 10000] : [1, 5, 10, 50];
}

function productCard(p) {
  return `<span class="product-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7l8-4 8 4v10l-8 4-8-4z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg></span>
    <span class="grow"><strong>${esc(nice(p.name))}</strong><span class="mono">${esc(p.code)} · ${esc(p.unit)}</span></span>`;
}

function stocksGrid(p) {
  return `<div class="stocks">${KHO.map((k) => `<div><span>${KHO_SHORT[k]}</span><b>${fmt(p.stock[k])}</b></div>`).join('')}</div>`;
}

// ───────────────────────── Đăng nhập ─────────────────────────

function setSession(r, remember) {
  state.token = r.token;
  state.user = r.user;
  store.save({ token: r.token, user: r.user }, remember);
}

async function afterLogin() {
  state.stack = [];
  if (state.user.mustChange) {
    show('password', { push: false });
    return;
  }
  await loadAll();
  show('home', { push: false });
}

async function loadAll({ quiet = false } = {}) {
  const d = await api('bootstrap', {}, { quiet });
  state.user = d.user;
  store.save({ token: state.token, user: d.user }, store.remembered());
  setProducts(d.products);
  state.history = d.history;
}

function logout(expired = false) {
  stopCamera();
  store.clear();
  state.token = null;
  state.user = null;
  state.stack = [];
  state.kk = { kho: null, data: null };
  show('login', { push: false });
  if (expired) toast('Phiên đăng nhập đã hết, vui lòng đăng nhập lại.', true);
}

$('f-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('l-err', '');
  try {
    const r = await api('login', { username: $('l-user').value, password: $('l-pass').value });
    setSession(r, $('l-remember').checked);
    $('l-pass').value = '';
    await afterLogin();
  } catch (err) {
    showError('l-err', err.message);
  }
});

function renderPassword() {
  const first = !!(state.user && state.user.mustChange);
  $('pw-first').hidden = !first;
  $('pw-back').hidden = first;
  ['pw-old', 'pw-new', 'pw-new2'].forEach((id) => { $(id).value = ''; });
  showError('pw-err', '');
}

$('f-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('pw-new').value;
  if (pw.length < 6) return showError('pw-err', 'Mật khẩu mới phải có ít nhất 6 ký tự.');
  if (pw !== $('pw-new2').value) return showError('pw-err', 'Hai lần nhập mật khẩu mới không giống nhau.');
  showError('pw-err', '');
  try {
    const wasFirst = state.user.mustChange;
    const r = await api('changePassword', { oldPassword: $('pw-old').value, newPassword: pw });
    setSession(r, store.remembered() || wasFirst);
    toast('Đã đổi mật khẩu.');
    if (wasFirst) await afterLogin();
    else goBack();
  } catch (err) {
    showError('pw-err', err.message);
  }
});

// ───────────────────────── Trang chủ ─────────────────────────

function needsAttention(p) {
  if (p.status === 'KIỂM TRA LẠI') return true;
  return p.min != null && p.min > 0 && (p.status === 'SẮP HẾT' || p.status === 'HẾT HÀNG');
}

function renderHome() {
  const u = state.user;
  const name = u.name || u.username;
  $('h-hello').textContent = 'Chào ' + name;
  $('h-avatar').textContent = name.slice(0, 1).toUpperCase();
  const d = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit' });
  $('h-date').textContent = d.charAt(0).toUpperCase() + d.slice(1) + ' · Kho Biogreen';

  const low = state.products.filter(needsAttention)
    .sort((a, b) => (a.sellable / (a.min || 1)) - (b.sellable / (b.min || 1)))
    .slice(0, 5);
  $('h-low').innerHTML = low.length
    ? low.map((p) => {
      const pct = p.min ? Math.max(0, Math.min(100, Math.round((p.sellable / p.min) * 100))) : 0;
      const color = p.status === 'KIỂM TRA LẠI' ? 'var(--purple)' : p.sellable <= 0 ? 'var(--red)' : 'var(--orange)';
      return `<button class="low-item" data-code="${esc(p.code)}">
        <span class="low-top"><span>${esc(nice(p.name))}</span><b style="color:${color}">${p.status === 'KIỂM TRA LẠI' ? 'kiểm tra lại' : 'còn ' + fmt(p.sellable)}</b></span>
        <span class="meter"><i style="width:${pct}%;background:${color}"></i></span>
        <span class="small muted">${p.min ? 'Tối thiểu ' + fmt(p.min) + ' · ' : ''}${esc(p.unit)}</span>
      </button>`;
    }).join('')
    : '<p class="empty">Chưa có mã nào dưới mức tối thiểu. Điền cột "Tồn tối thiểu" ở tab Sản phẩm để app cảnh báo.</p>';

  $('h-recent').innerHTML = state.history.length
    ? state.history.slice(0, 6).map((h) => `<div class="recent">
        <span class="q q-${h.type}">${h.type === 'nhap' ? '+' : '−'}${fmt(h.qty)}</span>
        <span class="grow">${esc(nice(h.name) || h.code)}<br><span class="muted">${h.type === 'nhap' ? 'Nhập' : 'Xuất'} · ${esc(h.kho)} · ${esc(h.time)}${h.who ? ' · ' + esc(h.who) : ''}</span></span>
      </div>`).join('')
    : '<p class="empty">Chưa có phiếu nào ghi từ app.</p>';
}

$('h-low').addEventListener('click', (e) => {
  const b = e.target.closest('[data-code]');
  if (!b) return;
  const p = state.byCode.get(b.dataset.code.toLowerCase());
  if (p) productSheet(p);
});

// ───────────────────────── Quét mã ─────────────────────────

const cam = { stream: null, timer: null, detector: null, ignore: '', ignoreUntil: 0 };

async function startScan(mode) {
  state.scanMode = mode;
  $('sc-title').textContent = SCAN_TITLE[mode] || SCAN_TITLE[''];
  $('sc-search').value = '';
  $('sc-results').innerHTML = '';
  if (state.current === 'scan') startCamera();
  else show('scan');
}

async function startCamera() {
  const hint = $('sc-hint');
  if (cam.stream) return;
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices) {
    $('s-scan').classList.add('no-cam');
    hint.textContent = 'Máy này chưa hỗ trợ quét bằng camera. Gõ mã hoặc tên sản phẩm ở ô dưới.';
    return;
  }
  try {
    if (!cam.detector) {
      const wanted = ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'qr_code', 'data_matrix'];
      const supported = await BarcodeDetector.getSupportedFormats();
      cam.detector = new BarcodeDetector({ formats: supported.filter((f) => wanted.includes(f)) });
    }
    cam.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (state.current !== 'scan') { stopCamera(); return; }
    const v = $('sc-video');
    v.srcObject = cam.stream;
    await v.play();
    hint.textContent = 'Đưa mã vạch vào khung';
    const track = cam.stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    $('sc-torch').hidden = !caps.torch;
    tick();
  } catch (e) {
    cam.stream = null;
    hint.textContent = e && e.name === 'NotAllowedError'
      ? 'Chưa cho phép dùng camera. Vào Cài đặt → Ứng dụng → Biogreen Kho → Quyền → Camera.'
      : 'Không mở được camera. Gõ mã hoặc tên ở ô dưới.';
  }
}

function tick() {
  clearTimeout(cam.timer);
  cam.timer = setTimeout(async () => {
    if (!cam.stream) return;
    try {
      const v = $('sc-video');
      if (v.readyState >= 2 && $('sheet').hidden) {
        const codes = await cam.detector.detect(v);
        const raw = codes.length ? String(codes[0].rawValue || '').trim() : '';
        if (raw && !(raw === cam.ignore && Date.now() < cam.ignoreUntil)) {
          onScanned(raw);
        }
      }
    } catch (e) { /* khung hình lỗi: thử khung sau */ }
    tick();
  }, 180);
}

function stopCamera() {
  clearTimeout(cam.timer);
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  $('sc-video').srcObject = null;
  $('sc-torch').setAttribute('aria-pressed', 'false');
}

function onScanned(raw) {
  if (navigator.vibrate) navigator.vibrate(60);
  const p = state.byCode.get(raw.toLowerCase());
  if (!p) {
    cam.ignore = raw;
    cam.ignoreUntil = Date.now() + 3000;
    toast(`Mã "${raw}" chưa có trong tab Sản phẩm.`, true);
    return;
  }
  cam.ignore = raw;
  cam.ignoreUntil = Date.now() + 2500;
  pickProduct(p);
}

function pickProduct(p) {
  state.product = p;
  const mode = state.scanMode;
  if (mode === 'nhap' || mode === 'xuat' || mode === 'chuyen') openForm(mode);
  else if (mode === 'kiemke') countSheet(p, { fromScan: true });
  else productSheet(p);
}

$('sc-torch').addEventListener('click', async () => {
  if (!cam.stream) return;
  const btn = $('sc-torch');
  const on = btn.getAttribute('aria-pressed') !== 'true';
  try {
    await cam.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] });
    btn.setAttribute('aria-pressed', String(on));
  } catch (e) {
    toast('Máy không bật được đèn.', true);
  }
});

$('sc-search').addEventListener('input', () => {
  const q = $('sc-search').value.trim();
  const box = $('sc-results');
  if (!q) { box.innerHTML = ''; return; }
  const exact = state.byCode.get(q.toLowerCase());
  const list = (exact ? [exact] : []).concat(searchProducts(q).filter((p) => p !== exact)).slice(0, 8);
  box.innerHTML = list.length
    ? list.map((p) => `<button data-code="${esc(p.code)}"><strong>${esc(nice(p.name))}</strong><span class="mono">${esc(p.code)}</span></button>`).join('')
    : '<p class="small" style="color:#C9D3CC;margin:4px 0">Không thấy sản phẩm nào khớp.</p>';
});

$('sc-results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-code]');
  if (!b) return;
  const p = state.byCode.get(b.dataset.code.toLowerCase());
  if (p) {
    $('sc-search').blur();
    pickProduct(p);
  }
});

// Bảng sản phẩm sau khi quét (hoặc bấm vào một dòng tồn kho).
function productSheet(p) {
  state.product = p;
  const fromScan = state.current === 'scan';
  openSheet(`
    <div class="product" style="padding:0">${productCard(p)}</div>
    ${stocksGrid(p)}
    <div class="row-between small"><span class="muted">Có thể bán (trừ Kho mẫu)</span><span><b>${fmt(p.sellable)}</b> ${esc(p.unit)} · <span class="badge ${statusClass(p.status)}">${esc(p.status || '—')}</span></span></div>
    <div class="actions3">
      <button class="btn a-nhap" data-act="nhap">Nhập</button>
      <button class="btn a-xuat" data-act="xuat">Xuất</button>
      <button class="btn a-chuyen" data-act="chuyen">Chuyển</button>
    </div>
    ${fromScan ? '<button class="btn btn-ghost" data-act="close">Quét mã khác</button>' : ''}
  `, {
    actions: {
      nhap: () => openForm('nhap'),
      xuat: () => openForm('xuat'),
      chuyen: () => openForm('chuyen'),
      close: () => closeSheet(),
    },
  });
}

// ───────────────────────── Phiếu nhập / xuất / chuyển ─────────────────────────

function allowedKhos() {
  return KHO.filter((k) => state.user.khos.includes(k));
}

function openForm(mode) {
  const p = state.product;
  const khos = allowedKhos();
  const last = store.get('kho.last.' + mode);
  const best = (list) => list.slice().sort((a, b) => p.stock[b] - p.stock[a])[0] || null;
  const fromList = khos.filter((k) => k !== KHO_MAU || (mode === 'chuyen' && isAdmin()));
  const f = { mode, qty: 0, from: null, to: null, clientId: uuid(), extra: {} };
  if (mode === 'nhap') f.to = khos.includes(last) ? last : khos[0] || null;
  if (mode === 'xuat') f.from = fromList.includes(last) && p.stock[last] > 0 ? last : best(fromList);
  if (mode === 'chuyen') f.from = best(fromList);
  state.form = f;
  if (state.current === 'form') renderForm();
  else show('form');
}

function chipHtml(kind, k, f, p) {
  const sel = f[kind] === k;
  const disabled = kind === 'to' && f.mode === 'chuyen' && f.from === k;
  return `<button type="button" class="chip" role="radio" aria-checked="${sel}" data-kho="${esc(k)}" data-kind="${kind}" ${disabled ? 'disabled' : ''}>
    ${esc(k)}<small>còn ${fmt(p.stock[k])}</small></button>`;
}

function renderForm() {
  const f = state.form;
  const p = state.product;
  if (!f || !p) { show('home', { push: false }); return; }
  const m = MODE[f.mode];
  $('s-form').className = 'screen mode-' + f.mode;
  $('fm-title').textContent = m.title;
  $('fm-date').textContent = new Date().toLocaleDateString('vi-VN');
  $('fm-product').innerHTML = productCard(p);
  $('fm-unit').textContent = '(' + p.unit + ')';
  $('fm-save').textContent = m.save;

  $('fm-from-wrap').hidden = f.mode === 'nhap';
  $('fm-to-wrap').hidden = f.mode === 'xuat';
  $('fm-from-label').textContent = f.mode === 'chuyen' ? 'Kho đi' : 'Xuất từ kho';
  $('fm-to-label').textContent = f.mode === 'chuyen' ? 'Kho đến' : 'Kho nhận';

  $('fm-qty').value = f.qty ? fmt(f.qty) : '';
  $('fm-quick').innerHTML = quickFor(p.unit).map((n) => `<button type="button" data-add="${n}">+${fmt(n)}</button>`).join('');

  const field = (id, label, ph, span) => `<div class="field${span ? ' span2' : ''}"><label for="fx-${id}">${label}</label><input id="fx-${id}" data-extra="${id}" placeholder="${esc(ph)}" value="${esc(f.extra[id] || '')}" autocomplete="off"></div>`;
  $('fm-extra').innerHTML = f.mode === 'nhap'
    ? field('ncc', 'Nhà cung cấp', 'Tên NCC') + field('po', 'Số PO / chứng từ', 'Không bắt buộc') + field('note', 'Ghi chú', 'vd: hàng kiểm kê dư', true)
    : f.mode === 'xuat'
      ? field('khach', 'Khách hàng / nơi nhận', 'Tên khách hoặc "Hàng hỏng"', true) + field('so', 'Số đơn', 'Không bắt buộc') + field('note', 'Ghi chú', 'Lý do')
      : field('note', 'Ghi chú', 'Không bắt buộc', true);
  showError('fm-err', '');
  renderChips();
  if (!f.qty) setTimeout(() => $('fm-qty').focus(), 80);
}

function updateFormHints() {
  const f = state.form;
  const p = state.product;
  let over = '';
  let after = '';
  if (f.mode === 'nhap' && f.to) after = `${f.to} sau khi nhập: <b>${fmt(p.stock[f.to] + f.qty)}</b> ${esc(p.unit)}`;
  if (f.mode !== 'nhap' && f.from) {
    const left = p.stock[f.from] - f.qty;
    if (f.qty > p.stock[f.from]) over = `${f.from} chỉ còn ${fmt(p.stock[f.from])} ${p.unit}. Chọn kho khác hoặc giảm số lượng.`;
    else after = `${f.from} sau khi ${f.mode === 'xuat' ? 'xuất' : 'chuyển'}: <b>${fmt(left)}</b> ${esc(p.unit)}`;
    if (f.mode === 'chuyen' && f.to && !over) after += ` · ${f.to}: <b>${fmt(p.stock[f.to] + f.qty)}</b>`;
  }
  showError('fm-over', over);
  $('fm-qty').classList.toggle('bad', !!over || Number.isNaN(f.qty));
  $('fm-after').innerHTML = after;
  const ready = f.qty > 0 && !over
    && (f.mode === 'nhap' ? !!f.to : f.mode === 'xuat' ? !!f.from : !!(f.from && f.to && f.from !== f.to));
  $('fm-save').disabled = !ready;
}

$('s-form').addEventListener('click', (e) => {
  const f = state.form;
  if (!f) return;
  const chip = e.target.closest('[data-kho]');
  if (chip && !chip.disabled) {
    f[chip.dataset.kind] = chip.dataset.kho;
    if (f.mode === 'chuyen' && f.from === f.to) f.to = null;
    renderChips();
    return;
  }
  const add = e.target.closest('[data-add]');
  if (add) {
    f.qty = (Number.isNaN(f.qty) ? 0 : f.qty) + Number(add.dataset.add);
    $('fm-qty').value = fmt(f.qty);
    updateFormHints();
    return;
  }
  const step = e.target.closest('[data-step]');
  if (step) {
    const s = stepFor(state.product.unit) * Number(step.dataset.step);
    f.qty = Math.max(0, (Number.isNaN(f.qty) ? 0 : f.qty) + s);
    $('fm-qty').value = f.qty ? fmt(f.qty) : '';
    updateFormHints();
  }
});

function renderChips() {
  const f = state.form;
  const p = state.product;
  const khos = allowedKhos();
  if (!$('fm-from-wrap').hidden) {
    $('fm-from').innerHTML = khos.filter((k) => k !== KHO_MAU || (f.mode === 'chuyen' && isAdmin()))
      .map((k) => chipHtml('from', k, f, p)).join('');
  }
  if (!$('fm-to-wrap').hidden) $('fm-to').innerHTML = khos.map((k) => chipHtml('to', k, f, p)).join('');
  updateFormHints();
}

$('fm-qty').addEventListener('input', () => {
  state.form.qty = parseQty($('fm-qty').value);
  updateFormHints();
});
$('fm-qty').addEventListener('blur', () => {
  const q = state.form && state.form.qty;
  if (q > 0) $('fm-qty').value = fmt(q);
});
$('fm-extra').addEventListener('input', (e) => {
  const k = e.target.dataset.extra;
  if (k) state.form.extra[k] = e.target.value;
});

$('f-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = state.form;
  const p = state.product;
  if ($('fm-save').disabled) return;
  showError('fm-err', '');
  const data = { code: p.code, qty: f.qty, clientId: f.clientId, note: f.extra.note || '' };
  if (f.mode === 'nhap') Object.assign(data, { kho: f.to, ncc: f.extra.ncc || '', po: f.extra.po || '' });
  if (f.mode === 'xuat') Object.assign(data, { kho: f.from, khach: f.extra.khach || '', so: f.extra.so || '' });
  if (f.mode === 'chuyen') Object.assign(data, { from: f.from, to: f.to });
  try {
    const r = await api(f.mode, data);
    updateProduct(r.product);
    store.set('kho.last.' + f.mode, f.mode === 'nhap' ? f.to : f.from);
    refreshHistory();
    doneSheet(f, r);
  } catch (err) {
    showError('fm-err', err.message);
  }
});

function doneSheet(f, r) {
  const p = state.product;
  const where = f.mode === 'nhap' ? `vào ${f.to}` : f.mode === 'xuat' ? `từ ${f.from}` : `${f.from} → ${f.to}${r.so ? ' · ' + r.so : ''}`;
  const tab = f.mode === 'nhap' ? '"Nhập kho"' : f.mode === 'xuat' ? '"Xuất kho"' : '"Chuyển kho", "Xuất kho" và "Nhập kho"';
  openSheet(`
    <span class="done-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
    <h2 id="sheet-title" class="center">${MODE[f.mode].verb} ${fmt(f.qty)} ${esc(p.unit)}</h2>
    <p class="center muted" style="margin:0">${esc(nice(p.name))}<br>${esc(where)} · đã ghi vào tab ${tab}</p>
    ${stocksGrid(r.product)}
    <div class="grid2">
      <button class="btn btn-ghost" data-act="home">Về trang chủ</button>
      <button class="btn btn-primary" data-act="again">Quét tiếp</button>
    </div>
  `, {
    actions: {
      home: () => { state.stack = []; show('home', { push: false }); },
      again: () => { closeSheet({ silent: true }); state.stack = state.stack.filter((s) => s === 'home'); startScan(f.mode); },
    },
    onClose: () => { state.stack = state.stack.filter((s) => s === 'home'); show('home', { push: false }); },
  });
}

// ───────────────────────── Tồn kho ─────────────────────────

const STOCK_TABS = [
  { id: 'low', label: 'Cần chú ý', test: needsAttention },
  { id: 'all', label: 'Tất cả', test: () => true },
  { id: 'straw', label: 'Ống hút', test: (p) => norm(p.name).includes('ong hut') },
  { id: 'cup', label: 'Ly giấy', test: (p) => norm(p.name).includes('ly giay') },
];

function renderStock() {
  $('st-tabs').innerHTML = STOCK_TABS.map((t) => `<button aria-pressed="${t.id === state.stockTab}" data-tab="${t.id}">${t.label}</button>`).join('');
  renderStockList();
}

function renderStockList() {
  const tab = STOCK_TABS.find((t) => t.id === state.stockTab);
  const list = searchProducts($('st-q').value, state.products.filter(tab.test));
  const shown = list.slice(0, LIST_LIMIT);
  $('st-list').innerHTML = (list.length
    ? `<span class="small muted">${list.length} sản phẩm · có thể bán = Trên + Dưới + Trung tâm</span>`
      + shown.map((p) => `<button class="card stock-item" data-code="${esc(p.code)}">
          <span class="stock-top"><span><strong>${esc(nice(p.name))}</strong><span class="mono">${esc(p.code)}</span></span><span class="badge ${statusClass(p.status)}">${esc(p.status || '—')}</span></span>
          <span class="stock-bottom"><span>Trên ${fmt(p.stock['Kho trên'])} · Dưới ${fmt(p.stock['Kho dưới'])} · TT ${fmt(p.stock['Kho trung tâm'])} · Mẫu ${fmt(p.stock['Kho mẫu'])}</span><span><b>${fmt(p.sellable)}</b> ${esc(p.unit)}</span></span>
        </button>`).join('')
      + (list.length > shown.length ? `<p class="more">Còn ${list.length - shown.length} mã nữa, gõ tên hoặc mã để tìm.</p>` : '')
    : state.stockTab === 'low' && !$('st-q').value
      ? '<p class="more">Chưa có mã nào dưới mức tối thiểu. Điền cột "Tồn tối thiểu" ở tab Sản phẩm để app cảnh báo.</p>'
      : '<p class="more">Không thấy sản phẩm nào khớp.</p>');
}

$('st-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  state.stockTab = b.dataset.tab;
  renderStock();
});
$('st-q').addEventListener('input', renderStockList);
$('st-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-code]');
  if (!b) return;
  const p = state.byCode.get(b.dataset.code.toLowerCase());
  if (p) { state.scanMode = ''; productSheet(p); }
});
$('st-refresh').addEventListener('click', async () => {
  try {
    await loadAll();
    renderStock();
    toast('Đã cập nhật tồn kho.');
  } catch (err) {
    toast(err.message, true);
  }
});

// ───────────────────────── Kiểm kê ─────────────────────────

async function loadKiemke(kho) {
  const khos = allowedKhos();
  state.kk.kho = kho || (khos.includes(state.kk.kho) ? state.kk.kho : khos[0]);
  renderKiemkeTabs();
  $('kk-new').hidden = !isAdmin();
  if (!state.kk.data || state.kk.data.kho !== state.kk.kho || kho) {
    $('kk-list').innerHTML = '<p class="more">Đang tải…</p>';
    $('kk-sum').innerHTML = '';
    try {
      state.kk.data = await api('kiemkeGet', { kho: state.kk.kho }, { quiet: true });
    } catch (err) {
      $('kk-list').innerHTML = `<p class="alert">${esc(err.message)}</p>`;
      return;
    }
  }
  renderKiemke();
}

function renderKiemkeTabs() {
  $('kk-khos').innerHTML = allowedKhos().map((k) => `<button role="tab" aria-selected="${k === state.kk.kho}" data-kk="${esc(k)}">${KHO_SHORT[k]}</button>`).join('');
}

function renderKiemke() {
  const d = state.kk.data;
  if (!d) return;
  const counted = d.items.filter((i) => i.counted != null);
  const lech = counted.filter((i) => i.diff != null && i.diff !== 0).length;
  const pct = d.items.length ? Math.round((counted.length / d.items.length) * 100) : 0;
  $('kk-date').textContent = d.date ? 'Kỳ ' + d.date.slice(0, 5) : '';
  $('kk-sum').innerHTML = `
    <div class="row-between"><span><b>${esc(d.kho)}</b>: đã đếm ${counted.length}/${d.items.length} mã</span><span class="small" style="color:var(--red);font-weight:600">${lech} mã lệch</span></div>
    <span class="meter" style="height:8px"><i style="width:${pct}%;background:var(--purple)"></i></span>
    <span class="small muted">${d.date ? 'Ngày kiểm kỳ này: ' + esc(d.date) : 'Kỳ này chưa bắt đầu (lần đếm đầu sẽ lấy ngày hôm nay)'}${d.prevDate ? ' · Kỳ trước: ' + esc(d.prevDate) : ''}</span>`;
  renderKiemkeList();
}

function renderKiemkeList() {
  const d = state.kk.data;
  if (!d) return;
  const q = $('kk-q').value;
  const pool = q ? searchProducts(q, d.items) : d.items.filter((i) => i.counted != null);
  const shown = pool.slice(0, LIST_LIMIT);
  const diffCell = (i) => {
    if (i.counted == null) return '<span class="d-none">chưa đếm</span>';
    if (i.diff == null || i.diff === 0) return '<b class="d-zero">0</b>';
    return `<b class="${i.diff < 0 ? 'd-minus' : 'd-plus'}">${i.diff > 0 ? '+' : '−'}${fmt(Math.abs(i.diff))}</b>`;
  };
  $('kk-list').innerHTML = shown.length
    ? `<div class="kk-row kk-head"><span>Sản phẩm</span><span class="num">Sổ sách</span><span class="num">Đếm</span><span class="num">Lệch</span></div>`
      + shown.map((i) => `<button class="card kk-row" data-code="${esc(i.code)}">
          <span><strong class="small" style="display:block;line-height:1.3">${esc(nice(i.name))}</strong><span class="mono">${esc(i.code)}</span></span>
          <span class="num muted">${fmt(i.counted != null && i.diff != null ? i.counted - i.diff : i.stock)}</span>
          <span class="num"><b>${i.counted != null ? fmt(i.counted) : '—'}</b></span>
          <span class="num">${diffCell(i)}</span>
        </button>`).join('')
      + (pool.length > shown.length ? `<p class="more">Còn ${pool.length - shown.length} mã, gõ để tìm.</p>` : '')
    : `<p class="more">${q ? 'Không thấy sản phẩm nào khớp.' : 'Chưa đếm mã nào. Bấm "Quét để đếm" hoặc gõ tên để tìm.'}</p>`;
}

$('kk-khos').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kk]');
  if (b && b.dataset.kk !== state.kk.kho) loadKiemke(b.dataset.kk);
});
$('kk-q').addEventListener('input', renderKiemkeList);
$('kk-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-code]');
  if (!b) return;
  const p = state.byCode.get(b.dataset.code.toLowerCase());
  if (p) countSheet(p, { fromScan: false });
});

function countSheet(p, { fromScan }) {
  const kho = state.kk.kho;
  if (!kho) { toast('Chọn kho kiểm kê trước.', true); return; }
  const item = state.kk.data && state.kk.data.items.find((i) => i.code === p.code);
  const prev = item && item.counted != null ? item.counted : '';
  openSheet(`
    <form class="stack-sm">
      <h2 id="sheet-title">${esc(nice(p.name))}</h2>
      <span class="mono">${esc(p.code)} · ${esc(kho)}</span>
      <div class="row-between small"><span class="muted">Tồn sổ sách ${esc(kho)}</span><b>${fmt(p.stock[kho])} ${esc(p.unit)}</b></div>
      <div class="field">
        <label for="kk-count">Số đếm thực tế (${esc(p.unit)})</label>
        <input id="kk-count" inputmode="decimal" autocomplete="off" value="${prev !== '' ? fmt(prev) : ''}" autofocus>
      </div>
      <p class="alert" id="kk-err" role="alert" hidden></p>
      <div class="grid2">
        <button type="button" class="btn btn-ghost" data-act="close">${fromScan ? 'Xong' : 'Huỷ'}</button>
        <button type="submit" class="btn btn-kk">${fromScan ? 'Lưu, quét tiếp' : 'Lưu số đếm'}</button>
      </div>
    </form>
  `, {
    actions: {
      close: () => { if (fromScan) { closeSheet({ silent: true }); goBack(); } else closeSheet(); },
      submit: async () => {
        const n = parseQty($('kk-count').value);
        if ($('kk-count').value.trim() === '' || Number.isNaN(n) || n < 0) {
          showError('kk-err', 'Nhập số đếm (ghi 0 nếu không còn).');
          return;
        }
        try {
          const r = await api('kiemkeCount', { kho, code: p.code, count: n, clientId: uuid() });
          if (item) Object.assign(item, { counted: r.counted, diff: r.diff });
          if (state.kk.data) state.kk.data.date = r.date;
          const d = r.diff;
          toast(`Đã lưu ${fmt(n)} · ${d == null || d === 0 ? 'khớp sổ sách' : (d > 0 ? 'thừa ' : 'thiếu ') + fmt(Math.abs(d))}`);
          closeSheet({ silent: true });
          api('products', {}, { quiet: true }).then(setProducts).catch(() => {});
          if (!fromScan) renderKiemke();
        } catch (err) {
          showError('kk-err', err.message);
        }
      },
    },
    onClose: () => { if (state.current === 'kiemke') renderKiemke(); },
  });
}

$('kk-new').addEventListener('click', () => {
  const kho = state.kk.kho;
  openSheet(`
    <h2 id="sheet-title">Bắt đầu kỳ kiểm kê mới?</h2>
    <p style="margin:0">${esc(kho)}: số đếm kỳ này sẽ chuyển sang cột "Kỳ trước", cột "Kỳ này" được xoá trắng và đặt ngày hôm nay. Lịch sử từng lần đếm vẫn còn ở tab "Lịch sử kiểm kê".</p>
    <div class="grid2">
      <button class="btn btn-ghost" data-act="close">Huỷ</button>
      <button class="btn btn-kk" data-act="ok">Bắt đầu</button>
    </div>
  `, {
    actions: {
      close: () => closeSheet(),
      ok: async () => {
        try {
          state.kk.data = await api('kiemkeNewPeriod', { kho });
          closeSheet({ silent: true });
          renderKiemke();
          toast('Đã sang kỳ kiểm kê mới.');
        } catch (err) {
          toast(err.message, true);
        }
      },
    },
  });
});

// ───────────────────────── Tài khoản ─────────────────────────

async function renderAccount() {
  const u = state.user;
  const name = u.name || u.username;
  $('ac-me').innerHTML = `<span class="avatar" style="display:flex;align-items:center;justify-content:center">${esc(name.slice(0, 1).toUpperCase())}</span>
    <span class="grow"><strong>${esc(name)}</strong> <span class="muted">· ${esc(u.username)}</span><br><span class="small muted">${esc(u.role)} · ${u.khos.length === KHO.length ? 'mọi kho' : esc(u.khos.join(', '))}</span></span>`;
  $('ac-add').hidden = !isAdmin();
  $('ac-admin').hidden = !isAdmin();
  if (isAdmin()) await loadUsers();
}

let users = [];
async function loadUsers() {
  try {
    users = await api('usersList', {}, { quiet: true });
  } catch (err) {
    $('ac-users').innerHTML = `<p class="alert">${esc(err.message)}</p>`;
    return;
  }
  $('ac-count').textContent = `TÀI KHOẢN (${users.length})`;
  $('ac-users').innerHTML = users.map((x) => `<div class="card user-row${x.active ? '' : ' off'}">
      <span class="avatar" style="display:flex;align-items:center;justify-content:center">${esc((x.name || x.username).slice(0, 1).toUpperCase())}</span>
      <span class="grow"><strong class="small">${esc(x.name)}</strong> <span class="small muted">· ${esc(x.username)}</span><br>
        <span class="small muted">${x.active ? esc(x.role) : 'Đã khoá'} · ${x.khos.length === KHO.length ? 'mọi kho' : esc(x.khos.join(', '))}</span></span>
      <button class="btn btn-ghost btn-sm" data-user="${esc(x.username)}">Sửa</button>
    </div>`).join('');
}

$('ac-users').addEventListener('click', (e) => {
  const b = e.target.closest('[data-user]');
  if (!b) return;
  const x = users.find((u) => u.username === b.dataset.user);
  if (x) userSheet(x);
});

$('ac-logout').addEventListener('click', () => logout(false));
$('ac-add').addEventListener('click', () => userSheet(null));

function userForm(x) {
  const khos = x ? x.khos : KHO;
  return `
    <div class="grid2">
      <div class="field"><label for="u-name">Họ tên</label><input id="u-name" value="${esc(x ? x.name : '')}" autocomplete="off" ${x ? '' : 'autofocus'}></div>
      <div class="field"><label for="u-login">Tên đăng nhập</label><input id="u-login" value="${esc(x ? x.username : '')}" autocapitalize="none" spellcheck="false" autocomplete="off" placeholder="vd: an.kho" ${x ? 'disabled' : ''}></div>
    </div>
    <div class="field"><label for="u-role">Quyền</label>
      <select id="u-role"><option${!x || x.role === STAFF ? ' selected' : ''}>${STAFF}</option><option${x && x.role === ADMIN ? ' selected' : ''}>${ADMIN}</option></select>
    </div>
    <fieldset style="border:0;padding:0;margin:0" class="stack-sm">
      <legend class="label" style="margin-bottom:6px">Được làm ở kho</legend>
      <div class="checks">${KHO.map((k) => `<label class="check"><input type="checkbox" name="u-kho" value="${esc(k)}"${khos.includes(k) ? ' checked' : ''}> ${esc(k)}</label>`).join('')}</div>
    </fieldset>
    <p class="alert" id="u-err" role="alert" hidden></p>`;
}

function readUserForm() {
  return {
    name: $('u-name').value.trim(),
    username: $('u-login').value.trim().toLowerCase(),
    role: $('u-role').value,
    khos: Array.from(document.querySelectorAll('input[name="u-kho"]:checked')).map((i) => i.value),
  };
}

function tempPasswordSheet(username, pw, title) {
  openSheet(`
    <h2 id="sheet-title">${esc(title)}</h2>
    <div class="temp-pw">Tên đăng nhập: <b style="font-size:18px">${esc(username)}</b><br>Mật khẩu tạm:<b>${esc(pw)}</b></div>
    <p class="small muted" style="margin:0">Đưa mật khẩu này cho nhân viên. Lần đăng nhập đầu, app sẽ bắt đổi mật khẩu riêng. Mật khẩu tạm không hiện lại lần nữa.</p>
    <button class="btn btn-primary btn-lg" data-act="close">Đã ghi lại</button>
  `, { actions: { close: () => closeSheet() }, onClose: loadUsers });
}

function userSheet(x) {
  const me = x && x.username === state.user.username;
  openSheet(`
    <form class="stack-sm">
      <h2 id="sheet-title">${x ? 'Sửa tài khoản' : 'Thêm nhân viên'}</h2>
      ${userForm(x)}
      ${x ? '' : '<p class="small muted" style="margin:0">App tự tạo mật khẩu tạm. Nhân viên đổi mật khẩu ở lần đăng nhập đầu.</p>'}
      <div class="grid2">
        <button type="button" class="btn btn-ghost" data-act="close">Huỷ</button>
        <button type="submit" class="btn btn-primary">${x ? 'Lưu' : 'Tạo tài khoản'}</button>
      </div>
      ${x ? `<div class="grid2">
        <button type="button" class="btn btn-ghost" data-act="reset">Đặt lại mật khẩu</button>
        ${me ? '' : `<button type="button" class="btn btn-ghost danger" data-act="toggle">${x.active ? 'Khoá tài khoản' : 'Mở khoá'}</button>`}
      </div>` : ''}
    </form>
  `, {
    actions: {
      close: () => closeSheet(),
      submit: async () => {
        const v = readUserForm();
        if (!v.khos.length) { showError('u-err', 'Chọn ít nhất một kho.'); return; }
        try {
          if (x) {
            await api('userUpdate', { username: x.username, name: v.name, role: v.role, khos: v.khos });
            closeSheet();
            toast('Đã lưu tài khoản.');
          } else {
            const r = await api('userCreate', v);
            tempPasswordSheet(r.username, r.tempPassword, 'Đã tạo tài khoản');
          }
        } catch (err) {
          showError('u-err', err.message);
        }
      },
      reset: async () => {
        try {
          const r = await api('userResetPassword', { username: x.username });
          tempPasswordSheet(r.username, r.tempPassword, 'Đã đặt lại mật khẩu');
        } catch (err) {
          showError('u-err', err.message);
        }
      },
      toggle: async () => {
        try {
          await api('userUpdate', { username: x.username, active: !x.active });
          closeSheet();
          toast(x.active ? 'Đã khoá tài khoản.' : 'Đã mở khoá tài khoản.');
        } catch (err) {
          showError('u-err', err.message);
        }
      },
    },
    onClose: loadUsers,
  });
}

// ───────────────────────── Sự kiện chung + khởi động ─────────────────────────

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { show(go.dataset.go); return; }
  const sc = e.target.closest('[data-scan]');
  if (sc) { startScan(sc.dataset.scan); return; }
  const bk = e.target.closest('[data-back]');
  if (bk) { goBack(); return; }
  const eye = e.target.closest('[data-eye]');
  if (eye) {
    const input = $(eye.dataset.eye);
    const showPw = input.type === 'password';
    input.type = showPw ? 'text' : 'password';
    eye.setAttribute('aria-label', showPw ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  }
});

// Quay lại app (từ nền) khi đang ở màn quét: mở lại camera.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if (state.current === 'scan' && $('sheet').hidden) startCamera();
});

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  history.replaceState({ s: 'start' }, '');
  const s = store.load();
  if (!s || !s.token) {
    show('login', { push: false });
    return;
  }
  state.token = s.token;
  state.user = s.user;
  try {
    await afterLogin();
  } catch (err) {
    if (!state.token) return;
    show('home', { push: false });
    toast(err.message, true);
  }
}

init();
