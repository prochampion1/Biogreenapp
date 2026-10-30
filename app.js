'use strict';

// Biogreen Kho – app quét mã + nhập liệu kho. Dữ liệu nằm ở Google Sheets Quan_Ly_Kho,
// đọc/ghi qua Apps Script (link trong config.js).

const CFG = window.KHO_CONFIG || {};
const KHO = ['Kho trên', 'Kho dưới', 'Kho trung tâm', 'Kho mẫu', 'Khu sản xuất'];
const KHO_SHORT = { 'Kho trên': 'Trên', 'Kho dưới': 'Dưới', 'Kho trung tâm': 'Trung tâm', 'Kho mẫu': 'Mẫu', 'Khu sản xuất': 'SX' };
const KHO_MAU = 'Kho mẫu';
const KHO_SX = 'Khu sản xuất';
const ADMIN = 'Quản lý';
const STAFF = 'Nhân viên kho';
const MODE = {
  nhap: { title: 'Nhập kho', verb: 'Đã nhập', save: 'Lưu phiếu nhập' },
  xuat: { title: 'Xuất kho', verb: 'Đã xuất', save: 'Lưu phiếu xuất' },
  chuyen: { title: 'Chuyển kho', verb: 'Đã chuyển', save: 'Lưu phiếu chuyển' },
};
const SCAN_TITLE = { '': 'Quét mã vạch', nhap: 'Quét để nhập kho', xuat: 'Quét để xuất kho', chuyen: 'Quét để chuyển kho', kiemke: 'Quét để kiểm đếm' };
const SCREENS = ['login', 'password', 'home', 'scan', 'form', 'stock', 'kiemke', 'sanxuat', 'baocao', 'account'];
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
  boms: [],
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
  sanxuat: () => renderSanxuat(),
  baocao: () => renderBaocao(),
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
  state.boms = d.boms || [];
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
  $('tile-bc').hidden = !isAdmin();
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
          <span class="stock-bottom"><span>Trên ${fmt(p.stock['Kho trên'])} · Dưới ${fmt(p.stock['Kho dưới'])} · TT ${fmt(p.stock['Kho trung tâm'])} · Mẫu ${fmt(p.stock['Kho mẫu'])} · SX ${fmt(p.stock[KHO_SX])}</span><span><b>${fmt(p.sellable)}</b> ${esc(p.unit)}</span></span>
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

// Khu sản xuất không có khối trong tab Kiểm kê.
const kiemkeKhos = () => allowedKhos().filter((k) => k !== KHO_SX);

async function loadKiemke(kho) {
  const khos = kiemkeKhos();
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
  $('kk-khos').innerHTML = kiemkeKhos().map((k) => `<button role="tab" aria-selected="${k === state.kk.kho}" data-kk="${esc(k)}">${KHO_SHORT[k]}</button>`).join('');
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

// ───────────────────────── Sản xuất (định mức BOM) ─────────────────────────

const bomOf = (code) => state.boms.find((b) => b.code.toLowerCase() === String(code).toLowerCase());
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function renderSanxuat() {
  $('sx-add').hidden = !isAdmin();
  renderSanxuatList();
}

function renderSanxuatList() {
  const withBom = state.boms.map((b) => state.byCode.get(b.code.toLowerCase())).filter(Boolean);
  const list = searchProducts($('sx-q').value, withBom);
  $('sx-list').innerHTML = list.length
    ? list.map((p) => {
      const b = bomOf(p.code);
      return `<button class="card product" data-code="${esc(p.code)}">${productCard(p)}<span class="small muted">${b.lines.length} nguyên liệu</span></button>`;
    }).join('')
    : `<p class="more">${state.boms.length ? 'Không có thành phẩm nào khớp.' : 'Chưa có định mức nào.' + (isAdmin() ? ' Bấm "+ Định mức" để tạo.' : ' Nhờ quản lý tạo định mức.')}</p>`;
}

$('sx-q').addEventListener('input', renderSanxuatList);
$('sx-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-code]');
  const p = b && state.byCode.get(b.dataset.code.toLowerCase());
  if (p) produceSheet(p);
});
$('sx-add').addEventListener('click', () => {
  pickSheet('Chọn thành phẩm cần lập định mức', () => true, (p) => {
    const old = bomOf(p.code);
    bomEditSheet(p, old ? old.lines : []);
  });
});

// Bảng chọn một sản phẩm bằng cách gõ tìm.
function pickSheet(title, filter, onPick, onBack) {
  openSheet(`<h2 id="sheet-title">${esc(title)}</h2>
    <div class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
    <input id="pk-q" placeholder="Gõ mã hoặc tên" autocomplete="off" spellcheck="false" autofocus></div>
    <div class="stack-sm" id="pk-list"></div>
    ${onBack ? '<button class="btn btn-ghost" data-act="back">Quay lại</button>' : ''}`, {
    actions: {
      pick: (btn) => { const p = state.byCode.get(btn.dataset.code.toLowerCase()); if (p) onPick(p); },
      back: () => onBack && onBack(),
    },
  });
  const draw = () => {
    const q = $('pk-q').value;
    const res = searchProducts(q, state.products.filter(filter)).slice(0, 30);
    $('pk-list').innerHTML = !q.trim() ? '<p class="more">Gõ để tìm.</p>'
      : res.length ? res.map((p) => `<button class="card product" data-act="pick" data-code="${esc(p.code)}">${productCard(p)}</button>`).join('')
        : '<p class="more">Không thấy mã nào.</p>';
  };
  $('pk-q').addEventListener('input', draw);
  draw();
}

// Báo đã làm ra N thành phẩm: trừ nguyên liệu theo định mức khỏi Khu sản xuất.
function produceSheet(p) {
  const b = bomOf(p.code);
  const khos = allowedKhos();
  if (!b) return;
  if (!khos.includes(KHO_SX)) { toast('Tài khoản của bạn chưa được làm ở Khu sản xuất.', true); return; }
  const last = store.get('kho.last.sx');
  const s = { qty: 0, out: khos.includes(last) ? last : khos.includes('Kho trung tâm') ? 'Kho trung tâm' : khos[0], note: '', clientId: uuid() };
  const need = () => b.lines.map((l) => {
    const m = state.byCode.get(l.code.toLowerCase());
    const q = round6(l.qty * (s.qty > 0 ? s.qty : 0));
    const have = m ? m.stock[KHO_SX] : 0;
    return { l, m, q, have, short: !m || have < q };
  });
  const body = () => {
    const n = need();
    const bad = s.qty > 0 && n.some((x) => x.short);
    $('sx-lines').innerHTML = n.map((x) => `<div class="bom-line${s.qty > 0 && x.short ? ' short' : ''}">
        <span class="grow">${esc(x.m ? nice(x.m.name) : x.l.code)}<br><span class="mono">${esc(x.l.code)}</span></span>
        <span class="num"><b>${s.qty > 0 ? fmt(x.q) : fmt(x.l.qty) + ' / cái'}</b> ${esc(x.m ? x.m.unit : '')}<br><small>Khu SX còn ${fmt(x.have)}</small></span>
      </div>`).join('');
    showError('sx-over', bad ? 'Khu sản xuất chưa đủ nguyên liệu (dòng đỏ). Chuyển thêm nguyên liệu vào Khu sản xuất trước.' : '');
    $('sx-go').disabled = !(s.qty > 0) || bad;
    $('sx-after').innerHTML = s.qty > 0 && !bad ? `${esc(s.out)} sau khi nhập: <b>${fmt((state.byCode.get(p.code.toLowerCase()) || p).stock[s.out] + s.qty)}</b> ${esc(p.unit)}` : '';
  };
  const outs = () => khos.map((k) => `<button type="button" class="chip" role="radio" aria-checked="${s.out === k}" data-act="out" data-kho="${esc(k)}">${esc(k)}<small>có ${fmt(p.stock[k])}</small></button>`).join('');
  openSheet(`<div class="sx">
    <h2 id="sheet-title">Báo sản xuất</h2>
    <div class="card product">${productCard(p)}</div>
    <div class="field"><label for="sx-qty">Số lượng làm ra (${esc(p.unit)})</label><input id="sx-qty" inputmode="decimal" autocomplete="off" autofocus></div>
    <span class="label">Thành phẩm nhập vào kho</span>
    <div class="chips" id="sx-out" role="radiogroup">${outs()}</div>
    <span class="label">Nguyên liệu sẽ trừ khỏi Khu sản xuất</span>
    <div class="card list" id="sx-lines"></div>
    <p class="alert" id="sx-over" role="alert" hidden></p>
    <div class="field"><label for="sx-note">Ghi chú</label><input id="sx-note" placeholder="Không bắt buộc" autocomplete="off"></div>
    <p class="alert" id="sx-err" role="alert" hidden></p>
    <span class="muted small center" id="sx-after"></span>
    <button class="btn btn-primary btn-lg" id="sx-go" data-act="go" disabled>Ghi sản xuất</button>
    ${isAdmin() ? '<button class="btn btn-ghost" data-act="edit">Sửa định mức</button>' : ''}
  </div>`, {
    actions: {
      out: (btn) => { s.out = btn.dataset.kho; $('sx-out').innerHTML = outs(); body(); },
      edit: () => bomEditSheet(p, b.lines),
      go: async () => {
        showError('sx-err', '');
        try {
          const r = await api('sanxuat', { code: p.code, qty: s.qty, out: s.out, note: s.note, clientId: s.clientId });
          updateProduct(r.product);
          r.used.forEach((u) => updateProduct(u.product));
          store.set('kho.last.sx', s.out);
          refreshHistory();
          openSheet(`<span class="done-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
            <h2 id="sheet-title" class="center">Đã làm ra ${fmt(r.qty)} ${esc(p.unit)}</h2>
            <p class="center muted" style="margin:0">${esc(nice(p.name))}<br>Nhập vào ${esc(r.out)} · lệnh ${esc(r.so)}</p>
            <div class="card list">${r.used.map((u) => `<div class="bom-line"><span class="grow">${esc(nice(u.name))}</span><span class="num">−${fmt(u.qty)} ${esc(u.unit)}</span></div>`).join('')}</div>
            <button class="btn btn-primary" data-act="close">Xong</button>`, { actions: { close: () => closeSheet() } });
        } catch (err) {
          showError('sx-err', err.message);
        }
      },
    },
  });
  $('sx-qty').addEventListener('input', () => { s.qty = parseQty($('sx-qty').value); if (Number.isNaN(s.qty)) s.qty = 0; body(); });
  $('sx-note').addEventListener('input', () => { s.note = $('sx-note').value; });
  body();
}

// Quản lý sửa định mức: mỗi dòng = 1 nguyên liệu và số lượng cho 1 thành phẩm.
function bomEditSheet(p, lines) {
  const ed = lines.map((l) => ({ code: l.code, qty: l.qty }));
  const render = () => {
    openSheet(`<div class="sx">
      <h2 id="sheet-title">Định mức</h2>
      <div class="card product">${productCard(p)}</div>
      <span class="label">Để làm 1 ${esc(p.unit)} cần</span>
      <div class="stack-sm">${ed.length ? ed.map((l, i) => {
        const m = state.byCode.get(l.code.toLowerCase());
        return `<div class="card bom-edit"><span class="grow">${esc(m ? nice(m.name) : l.code)}<br><span class="mono">${esc(l.code)}</span></span>
          <input data-i="${i}" inputmode="decimal" value="${l.qty ? esc(String(l.qty).replace('.', ',')) : ''}" aria-label="Số lượng ${esc(l.code)}"><span class="small muted">${esc(m ? m.unit : '')}</span>
          <button class="icon-btn" data-act="del" data-i="${i}" aria-label="Xoá dòng"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
      }).join('') : '<p class="more">Chưa có nguyên liệu nào.</p>'}</div>
      <button class="btn btn-ghost" data-act="add">+ Thêm nguyên liệu</button>
      <p class="alert" id="be-err" role="alert" hidden></p>
      <button class="btn btn-primary btn-lg" data-act="save">${ed.length ? 'Lưu định mức' : 'Xoá định mức'}</button>
    </div>`, {
      actions: {
        del: (btn) => { ed.splice(Number(btn.dataset.i), 1); render(); },
        add: () => pickSheet('Chọn nguyên liệu', (x) => x.code.toLowerCase() !== p.code.toLowerCase() && !ed.some((l) => l.code.toLowerCase() === x.code.toLowerCase()),
          (x) => { ed.push({ code: x.code, qty: 0 }); render(); }, render),
        save: async () => {
          showError('be-err', '');
          const bad = ed.find((l) => !(l.qty > 0));
          if (bad) { showError('be-err', `Nhập số lượng cho ${bad.code}.`); return; }
          try {
            const r = await api('bomSave', { code: p.code, lines: ed });
            state.boms = state.boms.filter((b) => b.code.toLowerCase() !== p.code.toLowerCase());
            if (r.lines.length) state.boms.push({ code: p.code, lines: r.lines });
            closeSheet();
            renderSanxuatList();
            toast(r.lines.length ? 'Đã lưu định mức.' : 'Đã xoá định mức.');
          } catch (err) {
            showError('be-err', err.message);
          }
        },
      },
    });
    $('sheet-body').querySelectorAll('input[data-i]').forEach((inp) => inp.addEventListener('input', () => {
      const v = parseQty(inp.value);
      ed[Number(inp.dataset.i)].qty = Number.isNaN(v) ? 0 : v;
    }));
  };
  render();
}

// ───────────────────────── Báo cáo doanh thu (chỉ quản lý) ─────────────────────────
// Dữ liệu: tab "Doanh thu" trong Google Sheet (nhập từ Ecount). Doanh thu tính theo ngày chứng từ.
// Mỗi dòng: [ngày yyyy-mm-dd, số CT, khách, mã, tên, SL, đơn giá, thành tiền, VAT].

const BC = { rows: null, gran: 'month', sel: null, shift: 0, rank: 'sp', sort: 'rev', all: false };
const GRAN = {
  day: { name: 'Ngày', n: 30 },
  week: { name: 'Tuần', n: 12 },
  month: { name: 'Tháng', n: 12 },
  quarter: { name: 'Quý', n: 8 },
  year: { name: 'Năm', n: 5 },
};
const RANK_TOP = 10;
const pad2 = (n) => ('0' + n).slice(-2);
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dm = (d) => pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1);

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function bucketKey(g, s) {
  if (g === 'day') return s;
  if (g === 'week') return ymd(mondayOf(parseYmd(s)));
  if (g === 'month') return s.slice(0, 7);
  if (g === 'quarter') return s.slice(0, 4) + '-Q' + (Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1);
  return s.slice(0, 4);
}

function bucketStart(g, k) {
  if (g === 'day' || g === 'week') return parseYmd(k);
  if (g === 'month') return parseYmd(k + '-01');
  if (g === 'quarter') return new Date(Number(k.slice(0, 4)), (Number(k.slice(6)) - 1) * 3, 1);
  return new Date(Number(k), 0, 1);
}

// Dịch mốc d lùi k kỳ (k âm là tiến).
function shiftBucket(g, d, k) {
  if (g === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - k);
  if (g === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7 * k);
  if (g === 'month') return new Date(d.getFullYear(), d.getMonth() - k, 1);
  if (g === 'quarter') return new Date(d.getFullYear(), d.getMonth() - 3 * k, 1);
  return new Date(d.getFullYear() - k, 0, 1);
}

function bucketsEnding(g, n, shift) {
  const now = new Date();
  const anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(bucketKey(g, ymd(shiftBucket(g, anchor, i + shift * n))));
  return keys;
}

function bucketShort(g, k) {
  if (g === 'day' || g === 'week') return dm(parseYmd(k));
  if (g === 'month') return 'T' + Number(k.slice(5));
  if (g === 'quarter') return 'Q' + k.slice(6);
  return k;
}

function bucketFull(g, k) {
  if (g === 'day') return dm(parseYmd(k)) + '/' + k.slice(0, 4);
  if (g === 'week') { const s = parseYmd(k); return 'Tuần ' + dm(s) + ' – ' + dm(shiftBucket('day', s, -6)) + '/' + shiftBucket('day', s, -6).getFullYear(); }
  if (g === 'month') return 'Tháng ' + Number(k.slice(5)) + '/' + k.slice(0, 4);
  if (g === 'quarter') return 'Quý ' + k.slice(6) + '/' + k.slice(0, 4);
  return 'Năm ' + k;
}

const money = (n) => {
  const a = Math.abs(n);
  const f = (x, u) => x.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' ' + u;
  if (a >= 1e9) return f(n / 1e9, 'tỷ');
  if (a >= 1e6) return f(n / 1e6, 'tr');
  if (a >= 1e3) return Math.round(n / 1e3).toLocaleString('vi-VN') + ' k';
  return fmt(n);
};
const vnd = (n) => fmt(Math.round(n)) + ' đ';

async function renderBaocao() {
  if (!isAdmin()) { show('home', { push: false }); return; }
  drawGran();
  const had = !!BC.rows;
  if (!had) $('bc-body').innerHTML = '<p class="more">Đang tải…</p>';
  try {
    BC.rows = (await api('dtList', {}, { quiet: had })).rows;
  } catch (err) {
    toast(err.message, true);
    if (!had) { $('bc-body').innerHTML = `<p class="more">${esc(err.message)}</p>`; return; }
  }
  if (state.current === 'baocao') drawBaocao();
}

function drawGran() {
  $('bc-gran').innerHTML = Object.keys(GRAN).map((g) =>
    `<button type="button" role="radio" aria-checked="${BC.gran === g}" data-g="${g}">${GRAN[g].name}</button>`).join('');
}

function chartSvg(keys, vals) {
  const W = 360, H = 176, top = 16, bot = 22, n = keys.length;
  const max = Math.max(...vals, 1);
  const slot = W / n;
  const bw = Math.max(4, slot * 0.62);
  const bars = keys.map((k, i) => {
    const h = vals[i] > 0 ? Math.max(2, (vals[i] / max) * (H - top - bot)) : 0;
    const x = i * slot + (slot - bw) / 2;
    const showLab = n <= 12 || (n - 1 - i) % 5 === 0;
    return `<g data-k="${esc(k)}" role="button" aria-label="${esc(bucketFull(BC.gran, k) + ': ' + vnd(vals[i]))}">
      <rect x="${i * slot}" y="0" width="${slot}" height="${H - bot}" fill="transparent"/>
      <rect class="bar${k === BC.sel ? ' on' : ''}" x="${x.toFixed(1)}" y="${(H - bot - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"/>
      ${showLab ? `<text class="ax${k === BC.sel ? ' on' : ''}" x="${(i === n - 1 && n > 12 ? W : x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="${i === n - 1 && n > 12 ? 'end' : 'middle'}">${esc(bucketShort(BC.gran, k))}</text>` : ''}
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="bc-chart" role="group" aria-label="Biểu đồ doanh thu theo ${GRAN[BC.gran].name.toLowerCase()}">
    <line class="grid" x1="0" y1="${H - bot}" x2="${W}" y2="${H - bot}"/>
    <text class="ax" x="0" y="10">${esc(money(max))}</text>${bars}</svg>`;
}

function rankRows(rows) {
  const sp = BC.rank === 'sp';
  const m = new Map();
  rows.forEach((r) => {
    const id = sp ? (r[3] || r[4] || '(không mã)') : (r[2] || '(không tên)');
    let o = m.get(id);
    if (!o) m.set(id, o = { id, name: sp ? r[4] : r[2], rev: 0, qty: 0, docs: new Set() });
    o.rev += r[7];
    o.qty += r[5];
    o.docs.add(r[1]);
  });
  const val = (o) => (BC.sort === 'rev' ? o.rev : sp ? o.qty : o.docs.size);
  return [...m.values()].sort((a, b) => val(b) - val(a)).map((o) => Object.assign(o, { v: val(o) }));
}

function drawBaocao() {
  const rows = BC.rows || [];
  if (!rows.length) {
    $('bc-body').innerHTML = `<div class="card bc-empty"><strong>Chưa có dữ liệu doanh thu</strong>
      <span class="muted small">Bấm "Nhập Ecount" ở góc trên để đưa chứng từ bán hàng vào. Doanh thu tính theo ngày chứng từ.</span></div>`;
    return;
  }
  const g = BC.gran;
  const keys = bucketsEnding(g, GRAN[g].n, BC.shift);
  const tot = new Map(keys.map((k) => [k, 0]));
  rows.forEach((r) => {
    const k = bucketKey(g, r[0]);
    if (tot.has(k)) tot.set(k, tot.get(k) + r[7]);
  });
  if (!keys.includes(BC.sel)) {
    // Kỳ hiện tại chưa có số (vd hôm nay chưa xuất đơn): chọn kỳ gần nhất có doanh thu.
    const withData = keys.filter((k) => tot.get(k) !== 0);
    BC.sel = tot.get(keys[keys.length - 1]) === 0 && withData.length ? withData[withData.length - 1] : keys[keys.length - 1];
  }
  const prevKey = bucketKey(g, ymd(shiftBucket(g, bucketStart(g, BC.sel), 1)));
  const cur = [];
  let prevRev = 0;
  rows.forEach((r) => {
    const k = bucketKey(g, r[0]);
    if (k === BC.sel) cur.push(r);
    else if (k === prevKey) prevRev += r[7];
  });
  const rev = cur.reduce((s, r) => s + r[7], 0);
  const docs = new Set(cur.map((r) => r[1])).size;
  const custs = new Set(cur.map((r) => r[2]).filter(Boolean)).size;
  let delta = '<span class="muted">Kỳ trước chưa có số liệu</span>';
  if (prevRev > 0) {
    const p = ((rev - prevRev) / prevRev) * 100;
    delta = `<span class="${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%</span> <span class="muted">so với ${esc(bucketFull(g, prevKey))} (${esc(money(prevRev))})</span>`;
  }
  const range = bucketFull(g, keys[0]) + ' → ' + bucketFull(g, keys[keys.length - 1]);

  const sp = BC.rank === 'sp';
  const ranked = rankRows(cur);
  const shown = BC.all ? ranked : ranked.slice(0, RANK_TOP);
  const top = ranked.length ? ranked[0].v : 1;
  const sub = (o) => (sp ? `${esc(o.id)} · SL ${fmt(o.qty)}` : `${o.docs.size} chứng từ · SL ${fmt(o.qty)}`);
  const list = shown.length ? shown.map((o, i) => `<div class="rk">
      <span class="rk-n">${i + 1}</span>
      <span class="grow"><strong>${esc(nice(o.name) || o.id)}</strong><span class="small muted">${sub(o)}</span>
        <span class="rk-bar"><i style="width:${Math.max(2, (o.v / top) * 100).toFixed(1)}%"></i></span></span>
      <span class="num"><b>${esc(money(o.rev))}</b></span></div>`).join('')
    : '<p class="more">Kỳ này chưa có chứng từ nào.</p>';

  $('bc-body').innerHTML = `
    <div class="row-between bc-nav">
      <button class="icon-btn" data-nav="1" aria-label="Lùi về trước"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <span class="small muted center grow">${esc(range)}</span>
      <button class="icon-btn" data-nav="-1" aria-label="Tiến lên" ${BC.shift === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
    </div>
    <div class="card bc-card">${chartSvg(keys, keys.map((k) => Math.max(0, tot.get(k))))}
      <p class="small muted center" style="margin:6px 0 0">Bấm vào cột để xem chi tiết kỳ đó</p></div>
    <div class="card bc-kpi">
      <span class="small muted">${esc(bucketFull(g, BC.sel))}</span>
      <strong class="bc-big">${esc(vnd(rev))}</strong>
      <span class="small">${delta}</span>
      <span class="small muted">${docs} chứng từ · ${custs} khách · ${cur.length} dòng hàng</span>
    </div>
    <section class="stack-sm">
      <div class="seg" role="radiogroup" aria-label="Xếp hạng theo">
        <button type="button" role="radio" aria-checked="${sp}" data-rank="sp">Mặt hàng bán chạy</button>
        <button type="button" role="radio" aria-checked="${!sp}" data-rank="kh">Khách mua nhiều</button>
      </div>
      <div class="seg seg-sm" role="radiogroup" aria-label="Sắp xếp theo">
        <button type="button" role="radio" aria-checked="${BC.sort === 'rev'}" data-sort="rev">Theo doanh thu</button>
        <button type="button" role="radio" aria-checked="${BC.sort === 'qty'}" data-sort="qty">${sp ? 'Theo số lượng' : 'Theo số chứng từ'}</button>
      </div>
      <div class="card list">${list}</div>
      ${ranked.length > RANK_TOP ? `<button class="btn btn-ghost" data-all="1">${BC.all ? 'Thu gọn' : 'Xem tất cả ' + ranked.length}</button>` : ''}
    </section>`;
}

$('s-baocao').addEventListener('click', (e) => {
  const t = (sel) => e.target.closest(sel);
  let b;
  if ((b = t('[data-g]'))) { BC.gran = b.dataset.g; BC.shift = 0; BC.sel = null; BC.all = false; drawGran(); drawBaocao(); return; }
  if ((b = t('[data-k]'))) { BC.sel = b.dataset.k; BC.all = false; drawBaocao(); return; }
  if ((b = t('[data-nav]'))) { BC.shift = Math.max(0, BC.shift + Number(b.dataset.nav)); BC.sel = null; drawBaocao(); return; }
  if ((b = t('[data-rank]'))) { BC.rank = b.dataset.rank; BC.all = false; drawBaocao(); return; }
  if ((b = t('[data-sort]'))) { BC.sort = b.dataset.sort; drawBaocao(); return; }
  if (t('[data-all]')) { BC.all = !BC.all; drawBaocao(); return; }
  if (t('#bc-import')) importSheet();
});

// ── Đọc bảng Ecount (dán từ Excel hoặc file CSV) ──

function parseDelimited(text) {
  const head = text.split(/\r?\n/, 1)[0] || '';
  const count = (c) => head.split(c).length - 1;
  const delim = count('\t') ? '\t' : count(';') > count(',') ? ';' : ',';
  const out = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"' && !cell) q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      out.push(row); row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((x) => String(x).trim()));
}

// Tên cột Ecount có thể khác nhau: so khớp theo từ khoá (đã bỏ dấu). EXACT: chỉ nhận khi tên cột trùng hẳn.
const FIELDS = [
  ['tt', 'Thành tiền', ['thanh tien', 'doanh thu', 'tien hang', 'tong tien', 'gia tri']],
  ['sl', 'Số lượng', ['so luong', 'sl']],
  ['dg', 'Đơn giá', ['don gia']],
  ['vat', 'VAT', ['tien thue', 'tien vat', 'thue gtgt', 'vat']],
  ['ma', 'Mã hàng', ['ma hang', 'ma san pham', 'ma sp', 'ma vat tu', 'ma hh', 'ma item']],
  ['ten', 'Tên hàng', ['ten hang', 'ten san pham', 'ten sp', 'ten vat tu', 'ten hh', 'dien giai']],
  ['so', 'Số chứng từ', ['so chung tu', 'so ct', 'so hoa don', 'so hd', 'so phieu', 'so don', 'chung tu']],
  ['kh', 'Khách hàng', ['ten khach hang', 'khach hang', 'ten kh', 'ten doi tuong', 'doi tuong', 'khach']],
  ['date', 'Ngày', ['ngay chung tu', 'ngay ct', 'ngay hach toan', 'ngay ban', 'ngay xuat', 'ngay']],
];
const EXACT = new Set(['sl', 'vat', 'khach', 'ngay', 'chung tu']);

function mapColumns(row) {
  const heads = row.map((c) => norm(c).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
  const map = {};
  const used = new Set();
  FIELDS.forEach(([f, , syns]) => {
    let best = -1, bestScore = 0;
    heads.forEach((h, i) => {
      if (!h || used.has(i)) return;
      syns.forEach((s, si) => {
        const exact = h === s;
        const ok = exact || (!EXACT.has(s) && (h.startsWith(s) || h.includes(s)));
        if (!ok) return;
        const score = (exact ? 100 : h.startsWith(s) ? 50 : 20) - si;
        if (score > bestScore) { bestScore = score; best = i; }
      });
    });
    if (best >= 0) { map[f] = best; used.add(best); }
  });
  return map;
}

function parseNum(s) {
  let t = String(s == null ? '' : s).trim().replace(/[^\d.,\-()]/g, '');
  if (!t) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.startsWith('-')) { neg = true; t = t.slice(1); }
  const dots = (t.match(/\./g) || []).length;
  const commas = (t.match(/,/g) || []).length;
  if (dots && commas) {
    const dec = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.';
    t = t.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
  } else if (dots > 1 || commas > 1) {
    t = t.replace(/[.,]/g, '');
  } else if (dots === 1 || commas === 1) {
    const sep = dots ? '.' : ',';
    const tail = t.length - t.indexOf(sep) - 1;
    t = tail === 3 && !/^0[.,]/.test(t) ? t.replace(sep, '') : t.replace(sep, '.');
  }
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

function parseDateCell(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 30000 && Number(s) < 70000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 864e5);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  let m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/.exec(s);
  if (m) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) return m[3] + '-' + pad2(m[2]) + '-' + pad2(m[1]);
  return '';
}

function parseEcount(text) {
  const table = parseDelimited(String(text || '').replace(/^﻿/, ''));
  if (table.length < 2) throw new Error('Chưa thấy dữ liệu. Dán cả hàng tiêu đề và các dòng bên dưới.');
  let hi = -1, map = null;
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const m = mapColumns(table[i]);
    if (m.date !== undefined && (m.tt !== undefined || (m.sl !== undefined && m.dg !== undefined))) { hi = i; map = m; break; }
  }
  if (!map) throw new Error('Không tìm thấy hàng tiêu đề. Cần ít nhất cột Ngày và cột Thành tiền (hoặc Số lượng + Đơn giá).');
  const get = (r, f) => (map[f] === undefined ? '' : String(r[map[f]] == null ? '' : r[map[f]]).trim());
  const rows = [];
  const seq = new Map();
  let skipped = 0, filled = 0, date = '', so = '', kh = '';
  for (let i = hi + 1; i < table.length; i++) {
    const r = table[i];
    const ma = get(r, 'ma'), ten = get(r, 'ten');
    const d = parseDateCell(get(r, 'date'));
    if (!d && !(ma || ten)) { skipped++; continue; }
    let sl = map.sl === undefined ? 1 : parseNum(get(r, 'sl'));
    const dg = map.dg === undefined ? 0 : parseNum(get(r, 'dg'));
    let tt = map.tt === undefined ? NaN : parseNum(get(r, 'tt'));
    if (Number.isNaN(tt) && map.tt === undefined) tt = sl * dg;
    if (Number.isNaN(sl) || Number.isNaN(tt) || Number.isNaN(dg)) { skipped++; continue; }
    if (d) { date = d; so = get(r, 'so'); kh = get(r, 'kh'); } else { filled++; }
    if (!date) { skipped++; continue; }
    const row = { date, so: get(r, 'so') || so, kh: get(r, 'kh') || kh, ma, ten, sl, dg, tt, vat: map.vat === undefined ? 0 : (parseNum(get(r, 'vat')) || 0) };
    const base = [row.date, row.so, row.ma, row.sl, row.tt].join('|');
    row.seq = (seq.get(base) || 0) + 1;
    seq.set(base, row.seq);
    rows.push(row);
  }
  if (!rows.length) throw new Error('Không đọc được dòng nào có ngày và thành tiền hợp lệ.');
  const dates = rows.map((r) => r.date).sort();
  return {
    rows, map, skipped, filled, head: table[hi],
    from: dates[0], to: dates[dates.length - 1],
    total: rows.reduce((s, r) => s + r.tt, 0),
    docs: new Set(rows.map((r) => r.so)).size,
  };
}

const viDate = (s) => s.slice(8) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4);

function importSheet() {
  let parsed = null;
  const check = () => {
    showError('im-err', '');
    $('im-go').disabled = true;
    parsed = null;
    try {
      parsed = parseEcount($('im-text').value);
    } catch (err) {
      $('im-prev').innerHTML = '';
      showError('im-err', err.message);
      return;
    }
    const p = parsed;
    $('im-prev').innerHTML = `<div class="card bc-kpi">
      <strong>${p.rows.length} dòng · ${p.docs} chứng từ</strong>
      <span class="small">Từ ${viDate(p.from)} đến ${viDate(p.to)}</span>
      <strong class="bc-big">${esc(vnd(p.total))}</strong>
      <span class="small muted">Tổng thành tiền. So với tổng trên Ecount, nếu lệch thì đừng nhập.</span>
      ${p.skipped ? `<span class="small muted">Bỏ qua ${p.skipped} dòng (dòng tổng cộng hoặc thiếu số).</span>` : ''}
      ${p.filled ? `<span class="small muted">${p.filled} dòng bỏ trống ngày: lấy theo dòng trên.</span>` : ''}
      <span class="small muted">Cột nhận được: ${FIELDS.filter(([f]) => p.map[f] !== undefined).map(([f, n]) => esc(n) + ' ← "' + esc(p.head[p.map[f]]) + '"').join('; ')}.</span>
    </div>`;
    $('im-go').disabled = false;
  };
  openSheet(`<div class="sx">
    <h2 id="sheet-title">Nhập doanh thu từ Ecount</h2>
    <p class="muted small" style="margin:0">Xuất báo cáo bán hàng từ Ecount ra Excel, mở file, bôi đen cả bảng (gồm hàng tiêu đề), Copy rồi dán vào ô dưới. Nhập lại file cũ cũng không bị trùng.</p>
    <div class="field"><label for="im-text">Dán dữ liệu</label><textarea id="im-text" rows="5" spellcheck="false" autofocus></textarea></div>
    <div class="field"><label for="im-file">Hoặc chọn file CSV</label><input id="im-file" type="file" accept=".csv,.tsv,.txt"></div>
    <div id="im-prev"></div>
    <p class="alert" id="im-err" role="alert" hidden></p>
    <button class="btn btn-ghost" data-act="check">Kiểm tra dữ liệu</button>
    <button class="btn btn-primary btn-lg" id="im-go" data-act="go" disabled>Nhập vào sổ doanh thu</button>
  </div>`, {
    actions: {
      check,
      go: async () => {
        if (!parsed) return;
        showError('im-err', '');
        let added = 0, skipped = 0;
        try {
          for (let i = 0; i < parsed.rows.length; i += 1000) {
            const r = await api('dtImport', { rows: parsed.rows.slice(i, i + 1000), clientId: uuid() });
            added += r.added;
            skipped += r.skipped;
          }
        } catch (err) {
          showError('im-err', err.message + (added ? ` (đã nhập ${added} dòng trước đó, bấm nhập lại sẽ bỏ qua các dòng này)` : ''));
          return;
        }
        closeSheet();
        toast(`Đã nhập ${added} dòng${skipped ? `, bỏ qua ${skipped} dòng đã có` : ''}.`);
        BC.rows = null;
        renderBaocao();
      },
    },
  });
  $('im-file').addEventListener('change', async () => {
    const f = $('im-file').files[0];
    if (!f) return;
    $('im-text').value = await f.text();
    check();
  });
  $('im-text').addEventListener('paste', () => setTimeout(check, 50));
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
