/* =====================================================================
   TENNECO IMPROVEMENT — app logic
   ข้อมูลทั้งหมดอยู่บนฐานข้อมูลกลาง Cloudflare D1 + R2 (worker.js)
   ทุกเครื่องเห็นข้อมูลชุดเดียวกัน — สิ่งที่ทำได้ขึ้นกับสิทธิ์ของคนที่ล็อกอิน
   ===================================================================== */
(function () {
'use strict';

/* ------------------------------------------------------------------ */
/* CONFIG                                                              */
/* ------------------------------------------------------------------ */
const APP_VERSION = '1.0';
const DEFAULT_API = 'https://improvement-api.wiphawas-sketchup.workers.dev';
const K_API  = 'tnc_imp_api';
const K_USER = 'tnc_imp_user';
const DKEY   = 'tnc_imp_draft';

let API = (localStorage.getItem(K_API) || DEFAULT_API).replace(/\/+$/, '');

/* color = สีสำหรับพื้น/กราฟ, ink = สีสำหรับตัวอักษร (ผ่านคอนทราสต์ 4.5:1) */
const ST = {
  submitted:   { label: 'รอตรวจสอบ',      full: 'ส่งข้อมูล · รอตรวจสอบ', color: '#E9930B', ink: '#8A5604', step: 1 },
  in_progress: { label: 'กำลังดำเนินการ',  full: 'กำลังดำเนินการ',        color: '#2A5BD7', ink: '#2A5BD7', step: 2 },
  done:        { label: 'จบงาน',           full: 'จบงาน · ปิดงานแล้ว',    color: '#0E9F6E', ink: '#07714E', step: 3 },
  rejected:    { label: 'ไม่อนุมัติ',      full: 'ไม่อนุมัติ',            color: '#DC3545', ink: '#B31B29', step: 0 }
};

/* สิทธิ์ 4 ระดับ — ต้องตรงกับ ROLES ใน worker.js (การเช็คจริงอยู่ที่ backend ตรงนี้คุมแค่ UI) */
const ROLE_LABEL = {
  user:          'พนักงาน',
  manager:       'หัวหน้า / Manager',
  improve_admin: 'Admin Improvement',
  admin:         'Super Admin'
};
const ROLE_HINT = {
  user:          'แจ้งงาน · เห็นทุกงาน · ตอบกลับงานของตัวเอง',
  manager:       'อนุมัติ / ตอบกลับ / ปิดงาน เฉพาะแผนกตัวเอง',
  improve_admin: 'จัดการได้ทุกงานทุกแผนก',
  admin:         'จัดการทุกงาน + เมนูตั้งค่าและกำหนดสิทธิ์'
};
const ROLES = Object.keys(ROLE_LABEL);

const PRESETS = ['รับเรื่องแล้ว กำลังตรวจสอบหน้างาน', 'รอสั่งอะไหล่ คาดว่าถึงภายใน 3 วัน',
  'ช่างเข้าดำเนินการแล้ว', 'รอหยุดไลน์เพื่อเข้าซ่อม', 'ดำเนินการเสร็จ รอตรวจรับ'];

/* ------------------------------------------------------------------ */
/* STATE                                                               */
/* ------------------------------------------------------------------ */
let ME = null;                        // { id, name, dept, role }
let S = { jobs: [], areas: [], machines: [], pending: 0, employees: [] };
let filters = { q: '', status: ['all'], mine: false, area: '', machine: '', from: '', to: '', sort: 'new' };
let draft = { photos: [] };
let currentJob = null;
let reportPeriod = 'all';
let loadError = '';                   // ข้อความเมื่อดึงข้อมูลจากเซิร์ฟเวอร์ไม่สำเร็จ
let notifTimer = null;

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const isSuper    = () => !!ME && ME.role === 'admin';
const managesAll = () => !!ME && (ME.role === 'admin' || ME.role === 'improve_admin');
const canManage  = j => !!ME && (managesAll() || (ME.role === 'manager' && !!ME.dept && (j.dept || '') === ME.dept));
const isOwner    = j => !!ME && String(j.reporterId) === String(ME.id);

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
async function api(path, opts) {
  const o = Object.assign({ method: 'GET' }, opts || {});
  o.headers = Object.assign({}, o.headers);
  if (ME) o.headers['X-Emp-Id'] = encodeURIComponent(ME.id);
  if (o.body !== undefined && !(o.body instanceof ArrayBuffer) && !(o.body instanceof Blob)) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(o.body);
  }
  let res;
  try { res = await fetch(API + path, o); }
  catch (e) { throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจอินเทอร์เน็ต หรือที่อยู่เซิร์ฟเวอร์ในหน้าตั้งค่า'); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* ไม่ใช่ JSON */ }
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || ('เซิร์ฟเวอร์ตอบกลับผิดพลาด (' + res.status + ')'));
  }
  return data;
}

const photoURL = key => (!key ? '' : /^(data:|https?:)/.test(key) ? key : API + '/photo/' + key.split('/').map(encodeURIComponent).join('/'));

/* API ส่งชื่อฟิลด์แบบ snake_case — แปลงเป็นรูปที่หน้าเว็บและตัว export ใช้ */
function normJob(j) {
  return {
    id: j.id,
    code: j.code,
    area: j.area,
    machine: j.machine || '',
    title: j.title || '',
    detail: j.detail || '',
    status: ST[j.status] ? j.status : 'submitted',
    reporter: j.reporter_name || j.reporter_id || '',
    reporterId: j.reporter_id || '',
    dept: j.dept || '',
    createdAt: j.created_at,
    closedAt: j.closed_at || null,
    beforeKeys: j.before || [],
    afterKeys: j.after || [],
    before: (j.before || []).map(photoURL),
    after: (j.after || []).map(photoURL),
    timeline: (j.events || []).map(e => ({
      at: e.at, by: e.by_name || e.by_id || '', role: e.by_role || 'user',
      type: e.type, status: e.status || '', text: e.text || ''
    }))
  };
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */
const pad = n => String(n).padStart(2, '0');
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });
}
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short' }) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function daysBetween(a, b) { return Math.max(0, (new Date(b) - new Date(a)) / 86400000); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function initials(n) { return (n || '?').replace(/^(นาย|นาง|น\.ส\.|นางสาว)\s*/, '').trim().charAt(0) || '?'; }

const TOAST_ICO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8.2v4.4m0 2.9v.2"/></svg>';
function toast(msg) {
  const t = $('#toast');
  t.innerHTML = TOAST_ICO + '<span></span>';
  t.querySelector('span').textContent = msg;      // ข้อความจากเซิร์ฟเวอร์ — ใส่แบบ text ไม่ใช่ HTML
  t.classList.add('on');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2800);
}
function notify(text, title) {
  const n = $('#notify');
  $('#notify-title').textContent = title || 'แจ้งเตือน';
  $('#notify-text').textContent = text;
  n.classList.add('on');
  clearTimeout(n._t); n._t = setTimeout(() => n.classList.remove('on'), 4200);
}
function busy(btn, txtEl, msg) {
  const old = txtEl.textContent;
  btn.disabled = true; txtEl.textContent = msg;
  return () => { btn.disabled = false; txtEl.textContent = old; };
}

/* ---------- image helpers ---------- */
function compress(file, max = 1400, q = 0.72) {
  return new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        const sc = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * sc); h = Math.round(h * sc);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        res(c.toDataURL('image/jpeg', q));
      };
      img.onerror = () => res(null);
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
function dataURLtoBlob(d) {
  const [head, b64] = String(d).split(',');
  const mime = (head.match(/:(.*?);/) || [, 'image/jpeg'])[1];
  const bin = atob(b64); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}
/* อัปโหลดรูปขึ้น R2 ผ่าน Worker แล้วคืน key ที่ใช้อ้างในฐานข้อมูล */
async function uploadPhoto(dataUrl) {
  const blob = dataURLtoBlob(dataUrl);
  const res = await api('/photo', { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } });
  return res.key;
}
/* ดึงรูปกลับมาเป็น data URL — ใช้ตอน export Excel (ExcelJS ฝังรูปจาก base64) */
const photoCache = {};
async function photoDataURL(url) {
  if (!url) return '';
  if (/^data:/.test(url)) return url;
  if (photoCache[url]) return photoCache[url];
  try {
    const r = await fetch(url);
    if (!r.ok) return '';
    const b = await r.blob();
    const d = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(''); fr.readAsDataURL(b); });
    photoCache[url] = d;
    return d;
  } catch (e) { return ''; }
}

/* ------------------------------------------------------------------ */
/* LOGIN                                                               */
/* ------------------------------------------------------------------ */
async function doLogin(e) {
  if (e) e.preventDefault();
  const code = $('#lock-input').value.trim();
  const errBox = $('#lock-err');
  errBox.hidden = true;
  if (!code) { showLockErr('กรุณากรอกรหัสพนักงาน'); return; }
  const done = busy($('#btn-login'), $('#btn-login-txt'), 'กำลังตรวจสอบ...');
  try {
    const r = await api('/login', { method: 'POST', body: { code } });
    ME = r.me;
    localStorage.setItem(K_USER, JSON.stringify(ME));
    await enterApp();
  } catch (err) {
    showLockErr(err.message);
  } finally { done(); }
}
function showLockErr(msg) { const e = $('#lock-err'); e.textContent = msg; e.hidden = false; }

async function enterApp() {
  $('#lock').classList.add('gone');
  $('#app').hidden = false;
  applyRole();
  go('new');
  showLoading();
  try { await refreshAll(); }
  catch (e) { clearLoading(e.message); toast(e.message); }
  loadNotifs().catch(() => {});
  clearInterval(notifTimer);
  notifTimer = setInterval(() => loadNotifs().catch(() => {}), 60000);
}

function logout() {
  localStorage.removeItem(K_USER);
  ME = null;
  clearInterval(notifTimer);
  location.reload();
}

/* ------------------------------------------------------------------ */
/* DATA                                                                */
/* ------------------------------------------------------------------ */
async function loadBootstrap() {
  const b = await api('/bootstrap');
  S.areas = b.areas && b.areas.length ? b.areas : [];
  S.machines = b.machines || [];
  S.pending = b.pending || 0;
  if (b.me) { ME = b.me; localStorage.setItem(K_USER, JSON.stringify(ME)); }
  fillSelects();
}
async function loadJobs() {
  const r = await api('/jobs');
  S.jobs = (r.jobs || []).map(normJob);
  S.pending = r.pending || 0;
  loadError = '';                     // ดึงสำเร็จแล้ว — ข้อความแจ้งเตือนเดิมไม่ต้องค้างไว้
}
async function refreshAll() {
  await loadBootstrap();
  await loadJobs();
  renderGallery(); renderReport(); updateBadges();
}

/* ------------------------------------------------------------------ */
/* SKELETON — โครงร่างระหว่างรอข้อมูลชุดแรก                              */
/* ------------------------------------------------------------------ */
/* จอว่าง ๆ ทำให้ดูเหมือนแอปค้าง — วางโครงหน้าที่กำลังจะมาแทนไว้ก่อน */
function skeletonGallery(n) {
  return Array.from({ length: n }, () =>
    '<div class="sk-tile"><div class="sk sk-img"></div>' +
    '<div class="sk-body"><div class="sk sk-line"></div><div class="sk sk-line w60"></div>' +
    '<div class="sk sk-line w40"></div></div></div>').join('');
}
function showLoading() {
  $('#gallery').innerHTML = skeletonGallery(6);
  $('#list-empty').hidden = true;
  $('#list-count').textContent = 'กำลังโหลด...';
  $('#kpi-grid').innerHTML =
    '<div class="sk sk-kpi hero"></div>' + '<div class="sk sk-kpi"></div>'.repeat(4);
  $('#overall-stack').innerHTML = '';
  $('#overall-legend').innerHTML = '';
  $('#area-list').innerHTML = '<div class="sk sk-row"></div>'.repeat(5);
  $('#trend-bars').innerHTML = '<div class="sk sk-block" style="flex:1"></div>';
}
/* โหลดไม่สำเร็จ — เก็บโครงร่างออก แล้วบอกสาเหตุแทน ไม่ปล่อยให้ shimmer ค้างทั้งหน้า */
function clearLoading(msg) {
  loadError = msg || 'ตรวจการเชื่อมต่อ แล้วลองเปิดแอปใหม่อีกครั้ง';
  $('#gallery').innerHTML = '';
  $('#list-count').textContent = 'โหลดข้อมูลไม่สำเร็จ';
  $('#list-empty').hidden = false;
  renderEmptyState(false);
  $('#kpi-grid').innerHTML = '';
  $('#area-list').innerHTML = '';
  $('#trend-bars').innerHTML = '';
}
function skeletonDetail() {
  return '<div class="sk sk-row" style="width:45%"></div>' +
         '<div class="sk sk-block" style="height:132px"></div>' +
         '<div class="sk sk-block" style="height:88px"></div>' +
         '<div class="sk sk-row" style="width:62%"></div>' +
         '<div class="sk sk-block" style="height:112px"></div>';
}

/* ------------------------------------------------------------------ */
/* NAV                                                                 */
/* ------------------------------------------------------------------ */
function go(name) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name));
  $$('.tab, .tab-fab').forEach(t => t.classList.toggle('active', t.dataset.go === name));
  const sc = $('#screen-' + name); if (sc) sc.scrollTop = 0;
  $('.appbar').classList.remove('scrolled');
  if (name === 'list') renderGallery();
  if (name === 'report') renderReport();
}

/* ---------- sheet: เปิด/ปิด + ปุ่ม Back ของเครื่อง + Esc + คืนโฟกัส ---------- */
let lastFocus = null;

function openSheet(id) {
  lastFocus = document.activeElement;
  const sh = $(id);
  sh.classList.add('on');
  sh.setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('on');
  $('#app').setAttribute('aria-hidden', 'true');
  // ให้ปุ่ม Back ของมือถือ/เบราว์เซอร์ปิด sheet แทนการออกจากหน้า
  if (!history.state || history.state.sheet !== id) history.pushState({ sheet: id }, '');
  setTimeout(() => {
    const f = sh.querySelector('[data-close],button,input,select,textarea');
    if (f) f.focus({ preventScroll: true });
  }, 260);
}

function closeSheets(fromPop) {
  const wasOpen = $$('.sheet.on').length > 0;
  $$('.sheet').forEach(s => { s.classList.remove('on'); s.setAttribute('aria-hidden', 'true'); });
  $('#scrim').classList.remove('on');
  $('#app').removeAttribute('aria-hidden');
  if (wasOpen && !fromPop && history.state && history.state.sheet) history.back();
  if (lastFocus && lastFocus.isConnected) { lastFocus.focus({ preventScroll: true }); lastFocus = null; }
}

/* ------------------------------------------------------------------ */
/* NEW JOB                                                             */
/* ------------------------------------------------------------------ */
function renderShots() {
  const shots = draft.photos.map((p, i) =>
    `<div class="shot" style="animation-delay:${i * 40}ms"><img src="${p}" alt="รูป Before ที่ ${i + 1}">
       <button type="button" class="x" data-rm="${i}" aria-label="ลบรูปที่ ${i + 1}">✕</button></div>`);
  // ช่องว่างที่เหลือ — บอกโควตา 4 รูปตั้งแต่ยังไม่ได้ถ่าย
  for (let i = draft.photos.length; i < 4; i++) shots.push(`<div class="slot" aria-hidden="true">${i + 1}</div>`);
  $('#shots').innerHTML = shots.join('');
}

/* ---------- เก็บร่างที่กรอกค้างไว้ กันข้อมูลหายถ้าปิดแอป ---------- */
let draftTimer;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      localStorage.setItem(DKEY, JSON.stringify({
        photos: draft.photos,
        area: $('#in-area').value, machine: $('#in-machine').value,
        title: $('#in-title').value, detail: $('#in-detail').value
      }));
    } catch (e) { /* พื้นที่เต็ม — ข้ามการเก็บร่าง */ }
  }, 500);
}
function clearDraft() { clearTimeout(draftTimer); try { localStorage.removeItem(DKEY); } catch (e) {} }
function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DKEY) || 'null');
    if (!d) return;
    if (!(d.photos && d.photos.length) && !d.machine && !d.title && !d.detail) return;
    draft.photos = d.photos || [];
    if (d.area) $('#in-area').value = d.area;
    $('#in-machine').value = d.machine || '';
    $('#in-title').value = d.title || '';
    $('#in-detail').value = d.detail || '';
    $('#detail-count').textContent = (d.detail || '').length;
    renderShots();
    setTimeout(() => toast('กู้คืนข้อมูลที่กรอกค้างไว้แล้ว'), 800);
  } catch (e) { /* ร่างเสียหาย — เริ่มใหม่ */ }
}

/* ---------- ทำเครื่องหมายช่องที่ยังไม่ถูกต้อง ---------- */
function setFieldValid(name, valid) {
  const wrap = $(`[data-field="${name}"]`);
  if (!valid) { void wrap.offsetWidth; }
  wrap.classList.toggle('invalid', !valid);
  const input = wrap.querySelector('.input');
  if (input) input.setAttribute('aria-invalid', valid ? 'false' : 'true');
}

async function addPhotos(files) {
  const list = Array.from(files).slice(0, 4 - draft.photos.length);
  if (!list.length) { toast('เพิ่มรูปได้สูงสุด 4 รูป'); return; }
  for (const f of list) {
    const d = await compress(f);
    if (d) draft.photos.push(d);
  }
  renderShots();
  setFieldValid('photos', true);
  saveDraft();
}

let submitting = false;
async function submitJob(e) {
  e.preventDefault();
  if (submitting) return;
  let ok = true;
  const need = [
    ['photos', draft.photos.length > 0],
    ['area', !!$('#in-area').value],
    ['machine', $('#in-machine').value.trim().length > 0],
    ['title', $('#in-title').value.trim().length > 0],
    ['detail', $('#in-detail').value.trim().length > 0]
  ];
  need.forEach(([f, valid]) => { if (!valid) ok = false; setFieldValid(f, valid); });
  if (!ok) {
    const first = $('.field.invalid');
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusable = first.querySelector('.input') || first.querySelector('label.shot-btn');
    if (focusable) setTimeout(() => focusable.focus({ preventScroll: true }), 320);
    toast('กรุณากรอกข้อมูลที่จำเป็นให้ครบ');
    return;
  }

  submitting = true;
  const done = busy($('#btn-submit'), $('#btn-submit-txt'), 'กำลังอัปโหลดรูป...');
  /* request_id กันบันทึกซ้ำ: กดส่งแล้วเน็ตหลุด กดใหม่ได้งานเดิม ไม่เกิดงานซ้ำ */
  const reqId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    const keys = [];
    for (let i = 0; i < draft.photos.length; i++) {
      $('#btn-submit-txt').textContent = `กำลังอัปโหลดรูป ${i + 1}/${draft.photos.length}...`;
      keys.push(await uploadPhoto(draft.photos[i]));
    }
    $('#btn-submit-txt').textContent = 'กำลังบันทึก...';
    const r = await api('/jobs', {
      method: 'POST',
      body: {
        area: $('#in-area').value,
        machine: $('#in-machine').value.trim(),
        title: $('#in-title').value.trim(),
        detail: $('#in-detail').value.trim(),
        before: keys,
        request_id: reqId
      }
    });
    const j = normJob(r.job);
    S.jobs.unshift(j);
    S.pending++;

    $('#success-code').textContent = j.code;
    $('#success').classList.add('on');
    $('#success').setAttribute('aria-hidden', 'false');

    draft = { photos: [] };
    clearDraft();
    $('#form-new').reset();
    $('#in-area').value = defaultArea();
    $('#detail-count').textContent = '0';
    renderShots(); renderGallery(); renderReport(); updateBadges();
    if (S.machines.indexOf(j.machine) < 0) { S.machines.push(j.machine); fillMachineList(); }
  } catch (err) {
    toast('บันทึกไม่สำเร็จ: ' + err.message);
  } finally {
    submitting = false; done();
  }
}

/* พื้นที่ตั้งต้น: ถ้าแผนกของผู้ใช้ตรงกับรายชื่อพื้นที่ ให้เลือกให้เลย */
function defaultArea() {
  if (ME && S.areas.indexOf(ME.dept) >= 0) return ME.dept;
  return S.areas[0] || '';
}

/* ------------------------------------------------------------------ */
/* GALLERY                                                             */
/* ------------------------------------------------------------------ */
function matchFilters(j) {
  const f = filters;
  if (f.mine && !isOwner(j)) return false;
  if (!f.status.includes('all') && !f.status.includes(j.status)) return false;
  if (f.area && j.area !== f.area) return false;
  if (f.machine && j.machine !== f.machine) return false;
  if (f.from && new Date(j.createdAt) < new Date(f.from + 'T00:00:00')) return false;
  if (f.to && new Date(j.createdAt) > new Date(f.to + 'T23:59:59')) return false;
  if (f.q) {
    const hay = [j.code, j.title, j.detail, j.machine, j.area, j.reporter].join(' ').toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

function visibleJobs() {
  const out = S.jobs.filter(matchFilters);
  if (filters.sort === 'old') out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  else out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return out;
}

function renderGallery() {
  const list = visibleJobs();
  const roleTag = ME && ME.role !== 'user' ? ' · ' + ROLE_LABEL[ME.role] : '';
  $('#list-count').textContent = list.length + ' รายการ' + roleTag;
  $('#list-empty').hidden = list.length > 0;
  $('#gallery').innerHTML = list.map((j, i) => {
    const pic = j.after.length ? j.after[0] : (j.before[0] || '');
    return `
    <button class="tile" data-open="${j.id}" style="animation-delay:${Math.min(i, 8) * 45}ms;--st:${ST[j.status].color}"
      aria-label="${esc(j.code)} ${esc(j.title)} · ${esc(j.area)} ${esc(j.machine)} · ผู้แจ้ง ${esc(j.reporter)} · สถานะ ${ST[j.status].label}">
      <div class="tile-img${pic ? '' : ' nopic'}">
        <img src="${pic}" alt="" loading="lazy">
        <span class="chip ${j.status} tile-chip"><i></i>${ST[j.status].label}</span>
        <span class="tile-code">${j.code}</span>
      </div>
      <div class="tile-body">
        <div class="tile-title">${esc(j.title)}</div>
        <div class="tile-tags">
          <span class="tile-tag">${esc(j.area)}</span>
          ${j.machine ? `<span class="tile-tag mc">${esc(j.machine)}</span>` : ''}
        </div>
        <div class="tile-meta">
          <span class="tile-who">${esc(j.reporter)}</span><i class="dot"></i>
          <span>${fmtDate(j.createdAt)}</span>
        </div>
      </div>
    </button>`;
  }).join('');
  renderQuickCounts();
  const n = (filters.q || filters.mine || filters.area || filters.machine || filters.from || filters.to || !filters.status.includes('all'));
  $('#filter-dot').hidden = !n;
  if (!list.length) renderEmptyState(n);
}

/* ข้อความตอนไม่มีงาน — บอกสาเหตุตามตัวกรองที่เปิดอยู่ ผู้ใช้จะได้รู้ว่าต้องทำอะไรต่อ */
function renderEmptyState(filtered) {
  if (loadError) {                       // โหลดไม่สำเร็จ — บอกสาเหตุจริง ไม่ใช่ "ยังไม่มีงาน" ซึ่งชวนเข้าใจผิด
    $('#list-empty .empty-title').textContent = 'โหลดข้อมูลไม่สำเร็จ';
    $('#list-empty .empty-text').textContent = loadError;
    $('#empty-reset').hidden = true;
    return;
  }
  const st = filters.status.find(x => x !== 'all');
  let title = 'ยังไม่มีรายการงาน', text = 'กดปุ่มกลางเพื่อถ่ายรูปและบันทึกงานปรับปรุงรายการแรก';
  if (filters.mine)      { title = 'คุณยังไม่ได้แจ้งงาน';        text = 'งานที่คุณแจ้งเองจะมาแสดงที่นี่ พร้อมสถานะล่าสุดของแต่ละงาน'; }
  else if (filters.q)    { title = 'ไม่พบงานที่ค้นหา';           text = 'ลองใช้คำสั้นลง หรือค้นด้วยรหัสงาน / ชื่อเครื่องจักรแทน'; }
  else if (st && ST[st]) { title = 'ไม่มีงานสถานะ "' + ST[st].label + '"'; text = 'ตอนนี้ไม่มีงานที่ค้างอยู่ในสถานะนี้'; }
  else if (filtered)     { title = 'ไม่พบงานตามตัวกรอง';         text = 'ลองขยายช่วงวันที่ หรือล้างตัวกรองบางอย่างออก'; }
  $('#list-empty .empty-title').textContent = title;
  $('#list-empty .empty-text').textContent = text;
  $('#empty-reset').hidden = !filtered;
}

/* นับจำนวนงานของแต่ละสถานะจากงานทั้งหมดที่ผู้ใช้เห็นได้ — ไม่ผูกกับตัวกรองอื่น
   เพราะจุดประสงค์คือ "ดูภาระงานรวม" ก่อนตัดสินใจว่าจะกดดูอันไหน */
function renderQuickCounts() {
  const by = { all: S.jobs.length, mine: 0, submitted: 0, in_progress: 0, done: 0, rejected: 0 };
  S.jobs.forEach(j => {
    if (by[j.status] !== undefined) by[j.status]++;
    if (isOwner(j)) by.mine++;
  });
  $$('#quickfilter .qf').forEach(b => {
    const k = b.dataset.status;
    if (by[k] === undefined) return;
    if (!b.dataset.label) b.dataset.label = b.textContent.trim();
    b.innerHTML = '';
    b.append(b.dataset.label);
    const n = document.createElement('span');
    n.className = 'n' + (by[k] ? '' : ' zero');
    n.textContent = by[k];
    b.append(n);
  });
}

/* ------------------------------------------------------------------ */
/* DETAIL                                                              */
/* ------------------------------------------------------------------ */
async function openDetail(id) {
  const cached = S.jobs.find(x => String(x.id) === String(id));
  if (cached) { currentJob = cached; renderDetail(); }
  openSheet('#sheet-detail');
  if (!cached) {                            // เปิดจากแจ้งเตือนโดยที่งานยังไม่อยู่ในรายการที่โหลดไว้
    currentJob = null;
    $('#d-code').textContent = ''; $('#d-title-sm').textContent = 'กำลังโหลด...';
    $('#d-chip').className = 'chip'; $('#d-chip').textContent = '';
    $('#detail-foot').innerHTML = '';
    $('#detail-body').innerHTML = skeletonDetail();
  }
  try {                                       // ดึงไทม์ไลน์/รูปครบชุดจากเซิร์ฟเวอร์
    const r = await api('/jobs/' + id);
    currentJob = normJob(r.job);
    replaceJob(currentJob);
    if ($('#sheet-detail').classList.contains('on')) renderDetail();
  } catch (e) { toast(e.message); }
}
function replaceJob(j) {
  const i = S.jobs.findIndex(x => String(x.id) === String(j.id));
  if (i >= 0) S.jobs[i] = j; else S.jobs.unshift(j);
}

function renderDetail(mode) {
  const j = currentJob; if (!j) return;
  $('#d-code').textContent = j.code;
  $('#d-title-sm').textContent = j.title;
  const chip = $('#d-chip');
  chip.className = 'chip lg ' + j.status;
  chip.innerHTML = '<i></i>' + ST[j.status].label;
  $('#sheet-detail .sheet-bar').style.setProperty('--st', ST[j.status].color);

  const lead = j.closedAt ? daysBetween(j.createdAt, j.closedAt).toFixed(1) : daysBetween(j.createdAt, new Date()).toFixed(1);
  const canReply = j.status !== 'done' && j.status !== 'rejected' && (isOwner(j) || canManage(j));

  $('#detail-body').innerHTML = `
    ${j.status === 'done' ? `<div class="banner ok"><svg viewBox="0 0 24 24"><path d="m4 12.5 5.2 5.2L20 7"/></svg><div><b>ปิดงานเรียบร้อย</b> · ใช้เวลา ${lead} วัน<br>${fmtTime(j.closedAt)}</div></div>` : ''}
    ${j.status === 'rejected' ? `<div class="banner bad"><svg viewBox="0 0 24 24"><path d="M12 8v5m0 3.5v.2"/><circle cx="12" cy="12" r="9"/></svg><div><b>ไม่อนุมัติ</b><br>${esc((j.timeline.filter(t => t.status === 'rejected').pop() || {}).text || '')}</div></div>` : ''}

    ${(j.status === 'done' && j.after.length) ? `
    <div>
      <div class="sec-title">เปรียบเทียบก่อน – หลังแก้ไข</div>
      <div class="compare">
        <figure class="cmp"><span class="tagline">BEFORE</span>
          <img src="${j.before[0]}" data-zoom="${j.before[0]}" alt="รูป Before ของงาน ${j.code}"></figure>
        <figure class="cmp"><span class="tagline after">AFTER</span>
          <img src="${j.after[0]}" data-zoom="${j.after[0]}" alt="รูป After ของงาน ${j.code}"></figure>
      </div>
      ${(j.before.length > 1 || j.after.length > 1) ? `<div class="photo-strip" style="margin-top:10px">${
        j.before.slice(1).map((p, i) => `<img src="${p}" data-zoom="${p}" alt="รูป Before เพิ่มเติมที่ ${i + 2}">`).join('') +
        j.after.slice(1).map((p, i) => `<img src="${p}" data-zoom="${p}" alt="รูป After เพิ่มเติมที่ ${i + 2}">`).join('')
      }</div>` : ''}
    </div>` : `
    <div>
      <div class="sec-title"><span class="tagline">BEFORE</span> รูปก่อนแก้ไข <span class="count">${j.before.length} รูป</span></div>
      <div class="photo-strip">${j.before.map((p, i) => `<img src="${p}" data-zoom="${p}" alt="รูป Before ที่ ${i + 1} ของงาน ${j.code}">`).join('')}</div>
    </div>
    ${j.after.length ? `<div>
      <div class="sec-title"><span class="tagline after">AFTER</span> รูปหลังแก้ไข <span class="count">${j.after.length} รูป</span></div>
      <div class="photo-strip">${j.after.map((p, i) => `<img src="${p}" data-zoom="${p}" alt="รูป After ที่ ${i + 1} ของงาน ${j.code}">`).join('')}</div>
    </div>` : ''}`}

    <div class="info-grid">
      <div class="info wide"><div class="info-k">หัวข้อ</div><div class="info-v">${esc(j.title)}</div></div>
      <div class="info wide"><div class="info-k">รายละเอียดที่ต้องการแก้ไข</div><div class="info-v">${esc(j.detail)}</div></div>
      <div class="info"><div class="info-k">พื้นที่</div><div class="info-v">${esc(j.area)}</div></div>
      <div class="info"><div class="info-k">เครื่องจักร</div><div class="info-v mono">${esc(j.machine)}</div></div>
      <div class="info"><div class="info-k">ผู้แจ้ง</div><div class="info-v">${esc(j.reporter)}</div></div>
      <div class="info"><div class="info-k">แผนกผู้แจ้ง</div><div class="info-v">${esc(j.dept || '—')}</div></div>
      <div class="info"><div class="info-k">วันที่แจ้ง</div><div class="info-v">${fmtTime(j.createdAt)}</div></div>
      <div class="info"><div class="info-k">ระยะเวลา</div><div class="info-v mono">${lead} วัน</div></div>
    </div>

    <div>
      <div class="sec-title">ความคืบหน้า / การตอบกลับ</div>
      <div class="timeline">
        ${j.timeline.map(t => `
          <div class="tl ${t.type === 'note' ? 'note' : 's-' + t.status}">
            <div class="tl-head">
              <span class="tl-who">${esc(t.by)}</span>
              <span class="tl-role ${t.role === 'user' ? 'user' : 'admin'}">${esc(ROLE_LABEL[t.role] || 'พนักงาน')}</span>
              <span class="tl-time">${fmtTime(t.at)}</span>
            </div>
            ${t.type === 'status' && ST[t.status] ? `<div class="tl-status"><span class="chip ${t.status}"><i></i>${ST[t.status].full}</span></div>` : ''}
            <div class="tl-text">${esc(t.text)}</div>
          </div>`).join('')}
      </div>
    </div>

    ${(canManage(j) && j.status === 'in_progress') ? `
    <div>
      <div class="sec-title"><span class="tagline after">AFTER</span> เพิ่มรูปหลังแก้ไข</div>
      <label class="shot-btn primary" style="width:100%">
        <svg viewBox="0 0 24 24"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.4"/></svg>
        <span id="after-btn-txt">ถ่ายรูป After</span>
        <input type="file" accept="image/*" capture="environment" id="in-after" hidden multiple>
      </label>
    </div>` : ''}

    ${canReply ? `
    <div>
      <div class="sec-title">พิมพ์ข้อความตอบกลับ</div>
      <div class="composer">
        <textarea class="input" id="msg" rows="1" placeholder="${canManage(j) ? 'เช่น รอสั่งของ คาดว่าถึงวันศุกร์...' : 'สอบถาม / เพิ่มเติมข้อมูล...'}"></textarea>
        <button class="send" id="btn-send" aria-label="ส่งข้อความ"><svg viewBox="0 0 24 24"><path d="m4 12 16-8-6 8 6 8-16-8Z"/></svg></button>
      </div>
      ${canManage(j) ? `<div class="preset-row">${PRESETS.map(p => `<button class="pick plain" data-preset="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : ''}
    </div>` : ''}
    <div style="height:4px"></div>`;

  renderFoot(mode);
  $('#detail-body').scrollTop = 0;
}

function renderFoot(mode) {
  const j = currentJob, f = $('#detail-foot');
  if (!canManage(j)) {
    f.className = 'sheet-foot';
    f.innerHTML = `<button class="btn ghost" data-close>ปิด</button>`;
    return;
  }
  if (mode === 'reject') {
    f.className = 'sheet-foot foot-col';
    f.innerHTML = `
      <textarea class="input" id="reject-why" rows="2" placeholder="ระบุเหตุผลที่ไม่อนุมัติ (จำเป็น)"></textarea>
      <div class="row"><button class="btn ghost" data-foot="cancel">ยกเลิก</button><button class="btn danger" data-foot="reject-ok">ยืนยันไม่อนุมัติ</button></div>`;
    setTimeout(() => $('#reject-why').focus(), 60);
    return;
  }
  f.className = 'sheet-foot';
  if (j.status === 'submitted') {
    f.innerHTML = `<button class="btn danger-ghost" data-foot="reject">ไม่อนุมัติ</button>
                   <button class="btn blue" data-foot="approve">อนุมัติ · เริ่มดำเนินการ</button>`;
  } else if (j.status === 'in_progress') {
    f.innerHTML = `<button class="btn ghost" data-close>ปิด</button>
                   <button class="btn green" data-foot="close">ปิดงาน (แนบ After)</button>`;
  } else {
    f.innerHTML = `<button class="btn ghost" data-close>ปิด</button>
                   <button class="btn blue" data-foot="reopen">เปิดงานอีกครั้ง</button>`;
  }
}

async function act(what) {
  const j = currentJob; if (!j) return;
  if (what === 'reject') { renderFoot('reject'); return; }
  if (what === 'cancel') { renderFoot(); return; }

  let body = null;
  if (what === 'approve') body = { action: 'approve' };
  if (what === 'reopen')  body = { action: 'reopen' };
  if (what === 'close') {
    if (!j.after.length) {
      toast('กรุณาถ่ายรูป After ก่อนปิดงาน');
      const i = $('#in-after'); if (i) i.click();
      return;
    }
    body = { action: 'close' };
  }
  if (what === 'reject-ok') {
    const why = $('#reject-why').value.trim();
    if (!why) { toast('กรุณาระบุเหตุผล'); return; }
    body = { action: 'reject', reason: why };
  }
  if (!body) return;

  $$('#detail-foot .btn').forEach(b => b.disabled = true);
  try {
    await api('/jobs/' + j.id, { method: 'PATCH', body });
    const r = await api('/jobs/' + j.id);
    currentJob = normJob(r.job);
    replaceJob(currentJob);
    renderDetail(); renderGallery(); renderReport();
    S.pending = S.jobs.filter(x => x.status === 'submitted').length;
    updateBadges();
    toast({ approve: 'อนุมัติแล้ว → กำลังดำเนินการ', 'reject-ok': 'บันทึกการไม่อนุมัติแล้ว',
            close: 'ปิดงานเรียบร้อย', reopen: 'เปิดงานอีกครั้งแล้ว' }[what] || 'บันทึกแล้ว');
  } catch (e) {
    toast(e.message);
    $$('#detail-foot .btn').forEach(b => b.disabled = false);
  }
}

async function sendMsg() {
  const box = $('#msg'); if (!box) return;
  const v = box.value.trim();
  if (!v) { toast('พิมพ์ข้อความก่อนส่ง'); return; }
  const btn = $('#btn-send'); btn.disabled = true;
  try {
    await api('/jobs/' + currentJob.id + '/note', { method: 'POST', body: { text: v } });
    const r = await api('/jobs/' + currentJob.id);
    currentJob = normJob(r.job);
    replaceJob(currentJob);
    renderDetail();
    toast('ส่งข้อความแล้ว');
  } catch (e) { toast(e.message); btn.disabled = false; }
}

async function addAfterPhotos(files) {
  const j = currentJob;
  const list = Array.from(files).slice(0, 4 - j.after.length);
  if (!list.length) { toast('เพิ่มรูปได้สูงสุด 4 รูป'); return; }
  const txt = $('#after-btn-txt');
  const old = txt ? txt.textContent : '';
  try {
    const keys = [];
    for (let i = 0; i < list.length; i++) {
      if (txt) txt.textContent = `กำลังอัปโหลด ${i + 1}/${list.length}...`;
      const d = await compress(list[i]);
      if (d) keys.push(await uploadPhoto(d));
    }
    if (!keys.length) { toast('อ่านไฟล์รูปไม่ได้'); return; }
    await api('/jobs/' + j.id + '/photos', { method: 'POST', body: { kind: 'after', keys } });
    const r = await api('/jobs/' + j.id);
    currentJob = normJob(r.job);
    replaceJob(currentJob);
    renderDetail(); renderGallery();
    toast('เพิ่มรูป After แล้ว');
  } catch (e) {
    toast(e.message);
    if (txt) txt.textContent = old;
  }
}

/* ------------------------------------------------------------------ */
/* REPORT                                                              */
/* ------------------------------------------------------------------ */
function periodJobs() {
  if (reportPeriod === 'all') return S.jobs.slice();
  const lim = Date.now() - Number(reportPeriod) * 86400000;
  return S.jobs.filter(j => new Date(j.createdAt).getTime() >= lim);
}

/* ไอคอนเส้น 1.7px ชุดเดียวกับที่อื่นทั้งแอป — ไม่ใช้อิโมจิ */
const KPI_ICO = {
  rate:        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13a8 8 0 1 1 16 0"/><path d="m12 13 4.2-3.4"/></svg>',
  submitted:   '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.6V12l2.8 1.7"/></svg>',
  in_progress: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-13.6 5.7L4 15.4"/><path d="M4 20v-4.6h4.6"/><path d="M4 12a8 8 0 0 1 13.6-5.7L20 8.6"/><path d="M20 4v4.6h-4.6"/></svg>',
  done:        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8.4 12.2 2.6 2.6 4.6-5"/></svg>',
  rejected:    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m9.2 9.2 5.6 5.6m0-5.6-5.6 5.6"/></svg>'
};

/* ตัวเลข KPI ไล่ขึ้นจาก 0 ตอนเปิดหน้ารายงาน — สื่อว่าค่าเพิ่งคำนวณใหม่
   ทำเฉพาะตอนหน้ารายงานเปิดอยู่จริง และเคารพการตั้งค่า "ลดการเคลื่อนไหว" */
function countUpKpis() {
  const nums = $$('#kpi-grid .num');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || !$('#screen-report').classList.contains('active')) {
    nums.forEach(el => { el.textContent = el.dataset.to; });
    return;
  }
  const t0 = performance.now(), dur = 620;
  nums.forEach(el => el.textContent = '0');
  (function step(now) {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);                 // ease-out — เร็วตอนต้น ค่อย ๆ หยุด
    nums.forEach(el => { el.textContent = Math.round(Number(el.dataset.to) * e); });
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

function stats(list) {
  const s = { total: list.length, submitted: 0, in_progress: 0, done: 0, rejected: 0 };
  list.forEach(j => { if (s[j.status] !== undefined) s[j.status]++; });
  s.rate = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const closed = list.filter(j => j.status === 'done' && j.closedAt);
  s.lead = closed.length ? (closed.reduce((a, j) => a + daysBetween(j.createdAt, j.closedAt), 0) / closed.length) : 0;
  return s;
}

function renderReport() {
  const list = periodJobs(), s = stats(list);
  $('#report-range').textContent = reportPeriod === 'all' ? 'ข้อมูลทั้งหมด · ' + list.length + ' รายการ' : reportPeriod + ' วันล่าสุด · ' + list.length + ' รายการ';

  const kpiCell = (c, delay, ico, lbl, val, sub) =>
    `<div class="kpi" style="--c:${c};animation-delay:${delay}ms">
       <div class="kpi-lbl">${ico}${lbl}</div>
       <div class="kpi-val"><span class="num" data-to="${val}">${val}</span></div>
       <div class="kpi-sub">${sub}</div>
     </div>`;

  $('#kpi-grid').innerHTML = `
    <div class="kpi hero-kpi" style="animation-delay:0ms">
      <div class="kpi-lbl">${KPI_ICO.rate}อัตราปิดงาน</div>
      <div class="kpi-val"><span class="num" data-to="${s.rate}">${s.rate}</span><span style="font-size:18px">%</span></div>
      <div class="kpi-sub">ปิดแล้ว ${s.done} จาก ${s.total} รายการ · เฉลี่ย ${s.lead.toFixed(1)} วัน/งาน</div>
      ${ring(s.rate)}
    </div>
    ${kpiCell(ST.submitted.ink,   60, KPI_ICO.submitted,   'รอตรวจสอบ',     s.submitted,   'ต้องอนุมัติ')}
    ${kpiCell(ST.in_progress.ink, 100, KPI_ICO.in_progress, 'กำลังดำเนินการ', s.in_progress, 'อยู่ระหว่างแก้ไข')}
    ${kpiCell(ST.done.ink,        140, KPI_ICO.done,        'จบงาน',          s.done,        'ปิดงานแล้ว')}
    ${kpiCell(ST.rejected.ink,    180, KPI_ICO.rejected,    'ไม่อนุมัติ',     s.rejected,    'ตีกลับ')}`;
  countUpKpis();

  $('#overall-note').textContent = s.total + ' รายการ';
  const keys = ['submitted', 'in_progress', 'done', 'rejected'];
  $('#overall-stack').innerHTML = keys.map(k =>
    `<span style="width:${s.total ? (s[k] / s.total * 100) : 0}%;background:${ST[k].color}"></span>`).join('');
  $('#overall-legend').innerHTML = keys.map(k =>
    `<span class="lg"><i style="background:${ST[k].color}"></i>${ST[k].label} <b>${s[k]}</b></span>`).join('');

  // by area — แสดงพื้นที่ที่ตั้งไว้ทุกอัน + พื้นที่เก่าที่ยังมีงานค้างอยู่
  const byArea = {};
  list.forEach(j => { (byArea[j.area] = byArea[j.area] || []).push(j); });
  const areaKeys = S.areas.slice();
  Object.keys(byArea).forEach(a => { if (areaKeys.indexOf(a) < 0) areaKeys.push(a); });
  $('#area-list').innerHTML = areaKeys.map(a => {
    const st = stats(byArea[a] || []);
    return `<div class="area-row">
      <div class="a-top"><span class="a-name">${esc(a)}</span><span class="a-num"><b>${st.done}</b>/${st.total} · ${st.rate}%</span></div>
      <div class="a-bar">${st.total
        ? keys.map(k => `<span style="width:${st[k] / st.total * 100}%;background:${ST[k].color}"></span>`).join('')
        : '<span style="width:100%;background:var(--line)"></span>'}</div>
    </div>`;
  }).join('') || '<p class="empty-text">ยังไม่มีข้อมูล</p>';

  // trend (6 เดือนล่าสุด)
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ k: d.getFullYear() + '-' + d.getMonth(), lbl: d.toLocaleDateString('th-TH', { month: 'short' }), inn: 0, done: 0 });
  }
  S.jobs.forEach(j => {
    const c = new Date(j.createdAt), mk = c.getFullYear() + '-' + c.getMonth();
    const m = months.find(x => x.k === mk); if (m) m.inn++;
    if (j.closedAt && j.status === 'done') {
      const cl = new Date(j.closedAt), ck = cl.getFullYear() + '-' + cl.getMonth();
      const m2 = months.find(x => x.k === ck); if (m2) m2.done++;
    }
  });
  const mx = Math.max(1, ...months.map(m => Math.max(m.inn, m.done)));
  $('#trend-bars').innerHTML = months.map(m => `
    <div class="bar-col">
      <div class="bar-pair">
        <span class="bar-in" style="height:${m.inn / mx * 100}%" title="${m.lbl} แจ้งเข้า ${m.inn}">${m.inn ? `<i class="bar-v">${m.inn}</i>` : ''}</span>
        <span class="bar-done" style="height:${m.done / mx * 100}%" title="${m.lbl} ปิดได้ ${m.done}">${m.done ? `<i class="bar-v">${m.done}</i>` : ''}</span>
      </div>
      <div class="bar-lbl">${m.lbl}</div>
    </div>`).join('');
  $('#trend-bars').setAttribute('aria-label',
    'กราฟแนวโน้มรายเดือน — ' + months.map(m => `${m.lbl} แจ้งเข้า ${m.inn} ปิดได้ ${m.done}`).join(', '));
}

function ring(pct) {
  const r = 26, c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 64 64" style="width:64px;height:64px">
    <circle cx="32" cy="32" r="${r}" stroke="rgba(255,255,255,.18)" stroke-width="7" fill="none"/>
    <circle cx="32" cy="32" r="${r}" stroke="#3ED598" stroke-width="7" fill="none" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" transform="rotate(-90 32 32)"/>
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* NOTIFICATIONS                                                       */
/* ------------------------------------------------------------------ */
let notifs = [], unread = 0;

async function loadNotifs() {
  const r = await api('/notifications');
  const fresh = (r.unread || 0) - unread;
  notifs = r.notifications || [];
  unread = r.unread || 0;
  if (fresh > 0 && notifs.length) notify(notifs[0].message, 'มีอัปเดตใหม่');
  updateBadges();
}

function renderNotifs() {
  $('#notif-body').innerHTML = notifs.length ? notifs.map(n => `
    <button class="notif-row ${n.is_read ? '' : 'unread'}" data-njob="${n.job_id || ''}">
      <span class="notif-dot"></span>
      <span class="notif-main">
        <span class="notif-msg">${esc(n.message)}</span>
        <span class="notif-meta">${esc(n.by_name || '')}${n.by_name ? ' · ' : ''}${fmtTime(n.created_at)}</span>
      </span>
    </button>`).join('')
    : '<p class="empty-text" style="text-align:center;padding:24px 0">ยังไม่มีแจ้งเตือน</p>';
}

/* ------------------------------------------------------------------ */
/* SETTINGS — พนักงาน / สิทธิ์ / พื้นที่                                */
/* ------------------------------------------------------------------ */
function renderMeCard() {
  if (!ME) return;
  $('#me-avatar').textContent = initials(ME.name);
  $('#me-name').textContent = ME.name;
  $('#me-id').textContent = ME.id;
  $('#me-dept').textContent = ME.dept || 'ไม่ระบุแผนก';
  const rb = $('#me-role');
  rb.textContent = ROLE_LABEL[ME.role] || ME.role;
  rb.className = 'role-badge r-' + ME.role;
  $('#admin-tools').hidden = !isSuper();
  $('#s-api').value = API;
  $('#s-api-state').textContent = 'เชื่อมต่ออยู่ · ข้อมูลพนักงาน ' + (S.employees.length || '—') + ' คน';
}

let empFilter = { q: '', role: '' };

async function openEmployees() {
  openSheet('#sheet-employees');
  $('#emp-body').innerHTML = '<p class="empty-text" style="text-align:center;padding:24px 0">กำลังโหลดรายชื่อ...</p>';
  try {
    const r = await api('/employees');
    S.employees = r.employees || [];
    renderEmployees();
  } catch (e) {
    $('#emp-body').innerHTML = `<p class="empty-text" style="text-align:center;padding:24px 0">${esc(e.message)}</p>`;
  }
}

function renderEmployees() {
  const q = empFilter.q.toLowerCase();
  const list = S.employees.filter(e => {
    if (empFilter.role && (e.role || 'user') !== empFilter.role) return false;
    if (!q) return true;
    return (e.id + ' ' + e.name + ' ' + (e.dept || '')).toLowerCase().includes(q);
  });
  $('#emp-count').textContent = list.length + ' / ' + S.employees.length + ' คน';
  $('#emp-body').innerHTML = list.length ? list.map(e => {
    const role = e.role || 'user';
    return `<div class="emp ${e.active ? '' : 'off'}" data-emp="${esc(e.id)}">
      <div class="emp-top">
        <div class="avatar sm">${esc(initials(e.name))}</div>
        <div class="emp-id">
          <div class="emp-name">${esc(e.name)}</div>
          <div class="emp-sub"><span class="mono">${esc(e.id)}</span><i class="dot"></i>${esc(e.dept || 'ไม่ระบุแผนก')}</div>
        </div>
        <button class="toggle ${e.active ? 'on' : ''}" data-toggle="${esc(e.id)}"
          aria-label="${e.active ? 'ปิดการใช้งาน' : 'เปิดการใช้งาน'} ${esc(e.name)}"><i></i></button>
      </div>
      <div class="emp-roles">
        ${ROLES.map(r => `<button class="pick plain ${r === role ? 'active' : ''}" data-role="${r}" data-for="${esc(e.id)}">${ROLE_LABEL[r]}</button>`).join('')}
      </div>
      <p class="emp-hint">${esc(ROLE_HINT[role] || '')}${e.active ? '' : ' · ปิดใช้งานอยู่ (ล็อกอินไม่ได้)'}</p>
    </div>`;
  }).join('') : '<p class="empty-text" style="text-align:center;padding:24px 0">ไม่พบพนักงานตามที่ค้นหา</p>';
}

async function setEmpRole(id, role) {
  const e = S.employees.find(x => x.id === id); if (!e) return;
  const old = e.role;
  e.role = role; renderEmployees();
  try {
    await api('/employees/' + encodeURIComponent(id), { method: 'PATCH', body: { role } });
    toast(e.name + ' → ' + ROLE_LABEL[role]);
    if (String(id) === String(ME.id)) { ME.role = role; localStorage.setItem(K_USER, JSON.stringify(ME)); applyRole(); }
  } catch (err) { e.role = old; renderEmployees(); toast(err.message); }
}
async function setEmpActive(id) {
  const e = S.employees.find(x => x.id === id); if (!e) return;
  const next = e.active ? 0 : 1;
  e.active = next; renderEmployees();
  try {
    await api('/employees/' + encodeURIComponent(id), { method: 'PATCH', body: { active: !!next } });
    toast(e.name + (next ? ' — เปิดใช้งาน' : ' — ปิดใช้งาน'));
  } catch (err) { e.active = next ? 0 : 1; renderEmployees(); toast(err.message); }
}

async function syncPsif() {
  const note = $('#s-sync-note');
  const old = note.textContent;
  note.textContent = 'กำลังดึงรายชื่อ...';
  try {
    const r = await api('/employees/sync', { method: 'POST', body: {} });
    note.textContent = 'อัปเดตล่าสุด ' + fmtTime(r.at) + ' · ' + r.synced + ' คน';
    toast('ดึงรายชื่อจาก PSIF แล้ว ' + r.synced + ' คน');
    if (S.employees.length) { const e = await api('/employees'); S.employees = e.employees || []; renderEmployees(); }
  } catch (e) { note.textContent = old; toast(e.message); }
}

/* ---------- พื้นที่ ---------- */
async function openAreas() {
  openSheet('#sheet-areas');
  await renderAreaAdmin();
}
async function renderAreaAdmin() {
  try {
    const r = await api('/areas');
    $('#area-admin').innerHTML = (r.areas || []).map(a => `
      <div class="area-item ${a.active ? '' : 'off'}">
        <span class="area-nm">${esc(a.name)}</span>
        ${a.active ? '' : '<span class="area-tag">ปิดใช้งาน</span>'}
        <button class="icon-btn sm" data-delarea="${esc(a.id)}" aria-label="ลบพื้นที่ ${esc(a.name)}">
          <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12"/></svg>
        </button>
      </div>`).join('') || '<p class="empty-text">ยังไม่มีพื้นที่</p>';
  } catch (e) { $('#area-admin').innerHTML = `<p class="empty-text">${esc(e.message)}</p>`; }
}

/* ------------------------------------------------------------------ */
/* BADGES / ROLE                                                       */
/* ------------------------------------------------------------------ */
function updateBadges() {
  const b = $('#bell-badge');
  b.textContent = unread > 99 ? '99+' : unread;
  b.hidden = !unread;
  $('#tab-badge').hidden = !(managesAll() && S.pending > 0);
  if (ME) {
    $('#rep-name').textContent = ME.name;
    $('#rep-meta').textContent = 'ผู้แจ้ง · ' + (ME.dept || 'ไม่ระบุแผนก') + ' · ' + (ROLE_LABEL[ME.role] || '');
    $('#rep-avatar').textContent = initials(ME.name);
  }
}
function applyRole() { renderMeCard(); updateBadges(); renderGallery(); }

/* ------------------------------------------------------------------ */
/* INIT                                                                */
/* ------------------------------------------------------------------ */
function fillSelects() {
  const areas = S.areas.length ? S.areas : ['VSM1', 'VSM2', 'VSM3', 'VSM4', 'OFFICE'];
  const opts = areas.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
  const keep = $('#in-area').value;
  $('#in-area').innerHTML = opts;
  $('#in-area').value = areas.indexOf(keep) >= 0 ? keep : defaultArea();
  $('#f-area').innerHTML = '<option value="">ทุกพื้นที่</option>' + opts;
  $('#f-area').value = filters.area;
  $('#f-status').innerHTML = ['all', 'submitted', 'in_progress', 'done', 'rejected'].map(k =>
    `<button type="button" class="pick plain ${filters.status.includes(k) ? 'active' : ''}" data-fs="${k}">${k === 'all' ? 'ทั้งหมด' : ST[k].label}</button>`).join('');
  $('#emp-role-filter').innerHTML = '<option value="">ทุกสิทธิ์</option>' +
    ROLES.map(r => `<option value="${r}">${ROLE_LABEL[r]}</option>`).join('');
  fillMachineList();
}

function fillMachineList() {
  const list = [...new Set(S.machines.concat(S.jobs.map(j => j.machine)).filter(Boolean))].sort();
  $('#machine-list').innerHTML = list.map(m => `<option value="${esc(m)}">`).join('');
  $('#f-machine').innerHTML = '<option value="">ทุกเครื่องจักร</option>' +
    list.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  $('#f-machine').value = filters.machine;
}

function bind() {
  // login
  $('#form-login').addEventListener('submit', doLogin);

  // แถบบนยกเงาขึ้นเมื่อเนื้อหาเลื่อนลอดใต้มัน — บอกว่ายังมีของอยู่ด้านบน
  $$('.screen').forEach(sc => sc.addEventListener('scroll', () => {
    if (!sc.classList.contains('active')) return;
    $('.appbar').classList.toggle('scrolled', sc.scrollTop > 4);
  }, { passive: true }));

  // nav
  $$('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
  $('#scrim').addEventListener('click', closeSheets);
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-close]'); if (c) closeSheets();
  });

  // settings
  $('#btn-settings').addEventListener('click', () => { renderMeCard(); openSheet('#sheet-settings'); });
  $('#s-employees').addEventListener('click', openEmployees);
  $('#s-areas').addEventListener('click', openAreas);
  $('#s-sync').addEventListener('click', syncPsif);
  $('#s-logout').addEventListener('click', logout);
  $('#s-api-save').addEventListener('click', async () => {
    const v = $('#s-api').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(v)) { toast('ที่อยู่ต้องขึ้นต้นด้วย https://'); return; }
    API = v; localStorage.setItem(K_API, v);
    toast('บันทึกที่อยู่แล้ว — กำลังเชื่อมต่อใหม่');
    try { await refreshAll(); renderMeCard(); toast('เชื่อมต่อสำเร็จ'); }
    catch (e) { toast(e.message); }
  });

  // employees sheet
  $('#emp-q').addEventListener('input', e => { empFilter.q = e.target.value.trim(); renderEmployees(); });
  $('#emp-role-filter').addEventListener('change', e => { empFilter.role = e.target.value; renderEmployees(); });
  $('#emp-body').addEventListener('click', e => {
    const r = e.target.closest('[data-role]');
    if (r) { setEmpRole(r.dataset.for, r.dataset.role); return; }
    const t = e.target.closest('[data-toggle]');
    if (t) setEmpActive(t.dataset.toggle);
  });

  // areas sheet
  $('#area-add').addEventListener('click', async () => {
    const v = $('#area-new').value.trim();
    if (!v) { toast('กรอกชื่อพื้นที่'); return; }
    try {
      await api('/areas', { method: 'POST', body: { name: v } });
      $('#area-new').value = '';
      await renderAreaAdmin(); await loadBootstrap();
      toast('เพิ่มพื้นที่ ' + v + ' แล้ว');
    } catch (e) { toast(e.message); }
  });
  $('#area-admin').addEventListener('click', async e => {
    const b = e.target.closest('[data-delarea]'); if (!b) return;
    const id = b.dataset.delarea;
    if (!confirm('ลบพื้นที่ "' + id + '" ?')) return;
    try {
      const r = await api('/areas/' + encodeURIComponent(id), { method: 'DELETE' });
      await renderAreaAdmin(); await loadBootstrap(); renderReport();
      toast(r.disabled ? 'มีงานอ้างอยู่ ' + r.jobs + ' รายการ — ปิดใช้งานแทนการลบ' : 'ลบพื้นที่แล้ว');
    } catch (err) { toast(err.message); }
  });

  // bell / notifications
  $('#btn-bell').addEventListener('click', async () => {
    renderNotifs(); openSheet('#sheet-notif');
    if (unread) { try { await api('/notifications/read', { method: 'POST' }); unread = 0; updateBadges(); } catch (e) {} }
  });
  $('#n-read').addEventListener('click', async () => {
    try { await api('/notifications/read', { method: 'POST' }); notifs.forEach(n => n.is_read = 1); unread = 0; renderNotifs(); updateBadges(); }
    catch (e) { toast(e.message); }
  });
  $('#notif-body').addEventListener('click', e => {
    const b = e.target.closest('[data-njob]'); if (!b || !b.dataset.njob) return;
    closeSheets();
    setTimeout(() => { go('list'); openDetail(b.dataset.njob); }, 260);
  });

  // new job
  $('#in-camera').addEventListener('change', e => { addPhotos(e.target.files); e.target.value = ''; });
  $('#in-gallery').addEventListener('change', e => { addPhotos(e.target.files); e.target.value = ''; });
  $('#shots').addEventListener('click', e => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    draft.photos.splice(+b.dataset.rm, 1); renderShots(); saveDraft();
  });
  $('#in-detail').addEventListener('input', e => $('#detail-count').textContent = e.target.value.length);

  // ตรวจความถูกต้องตอนออกจากช่อง (ไม่ขึ้นแดงระหว่างพิมพ์) + เก็บร่างอัตโนมัติ
  [['in-title', 'title'], ['in-detail', 'detail'], ['in-machine', 'machine']].forEach(([id, f]) => {
    const el = $('#' + id);
    el.addEventListener('blur', () => setFieldValid(f, el.value.trim().length > 0));
    el.addEventListener('input', () => { if (el.value.trim()) setFieldValid(f, true); saveDraft(); });
  });
  $('#in-area').addEventListener('change', saveDraft);
  $('#form-new').addEventListener('submit', submitJob);
  $('#sc-again').addEventListener('click', () => { hideSuccess(); go('new'); });
  $('#sc-view').addEventListener('click', () => {
    hideSuccess();
    filters.mine = true; filters.status = ['all'];
    $$('#quickfilter .qf').forEach(x => x.classList.toggle('active', x.dataset.status === 'mine'));
    go('list');
  });

  // gallery
  $('#gallery').addEventListener('click', e => {
    const t = e.target.closest('[data-open]'); if (t) openDetail(t.dataset.open);
  });
  $('#quickfilter').addEventListener('click', e => {
    const b = e.target.closest('.qf'); if (!b) return;
    $$('#quickfilter .qf').forEach(x => x.classList.toggle('active', x === b));
    const v = b.dataset.status;
    filters.mine = v === 'mine';
    filters.status = v === 'mine' ? ['all'] : [v];
    $$('#f-status .pick').forEach(p => p.classList.toggle('active', filters.status.includes(p.dataset.fs)));
    renderGallery();
  });

  // filter sheet
  $('#btn-filter').addEventListener('click', () => {
    fillMachineList();
    $('#f-q').value = filters.q; $('#f-area').value = filters.area;
    $('#f-machine').value = filters.machine; $('#f-from').value = filters.from; $('#f-to').value = filters.to;
    openSheet('#sheet-filter');
  });
  $('#f-status').addEventListener('click', e => {
    const b = e.target.closest('[data-fs]'); if (!b) return;
    const v = b.dataset.fs;
    if (v === 'all') filters.status = ['all'];
    else {
      filters.status = filters.status.filter(x => x !== 'all');
      filters.status.includes(v) ? filters.status = filters.status.filter(x => x !== v) : filters.status.push(v);
      if (!filters.status.length) filters.status = ['all'];
    }
    $$('#f-status .pick').forEach(p => p.classList.toggle('active', filters.status.includes(p.dataset.fs)));
  });
  $('#f-sort').addEventListener('click', e => {
    const b = e.target.closest('.seg-item'); if (!b) return;
    filters.sort = b.dataset.v;
    $$('#f-sort .seg-item').forEach(x => x.classList.toggle('active', x === b));
  });
  $('#f-reset').addEventListener('click', () => {
    filters = { q: '', status: ['all'], mine: false, area: '', machine: '', from: '', to: '', sort: 'new' };
    $('#f-q').value = ''; $('#f-area').value = ''; $('#f-machine').value = ''; $('#f-from').value = ''; $('#f-to').value = '';
    $$('#f-status .pick').forEach(p => p.classList.toggle('active', p.dataset.fs === 'all'));
    $$('#f-sort .seg-item').forEach(x => x.classList.toggle('active', x.dataset.v === 'new'));
    toast('ล้างตัวกรองแล้ว');
  });
  // ล้างตัวกรองจากกล่อง "ไม่พบรายการงาน" — ไม่ต้องเปิดชีตตัวกรองอีกรอบ
  $('#empty-reset').addEventListener('click', () => {
    filters = { q: '', status: ['all'], mine: false, area: '', machine: '', from: '', to: '', sort: 'new' };
    $('#f-q').value = ''; $('#f-area').value = ''; $('#f-machine').value = ''; $('#f-from').value = ''; $('#f-to').value = '';
    $$('#f-status .pick').forEach(p => p.classList.toggle('active', p.dataset.fs === 'all'));
    $$('#f-sort .seg-item').forEach(x => x.classList.toggle('active', x.dataset.v === 'new'));
    $$('#quickfilter .qf').forEach(x => x.classList.toggle('active', x.dataset.status === 'all'));
    renderGallery();
  });

  $('#f-apply').addEventListener('click', () => {
    filters.q = $('#f-q').value.trim();
    filters.area = $('#f-area').value; filters.machine = $('#f-machine').value;
    filters.from = $('#f-from').value; filters.to = $('#f-to').value;
    $$('#quickfilter .qf').forEach(x => x.classList.toggle('active',
      filters.mine ? x.dataset.status === 'mine' : (filters.status.length === 1 && x.dataset.status === filters.status[0])));
    closeSheets(); renderGallery();
  });

  // detail interactions
  $('#detail-body').addEventListener('click', e => {
    const z = e.target.closest('[data-zoom]');
    if (z) { $('#viewer-img').src = z.dataset.zoom; $('#viewer').classList.add('on'); return; }
    const p = e.target.closest('[data-preset]');
    if (p) { const m = $('#msg'); m.value = p.dataset.preset; m.focus(); return; }
    if (e.target.closest('#btn-send')) sendMsg();
  });
  $('#detail-body').addEventListener('change', e => {
    if (e.target.id !== 'in-after') return;
    const files = e.target.files; e.target.value = '';
    addAfterPhotos(files);
  });
  $('#detail-foot').addEventListener('click', e => {
    const b = e.target.closest('[data-foot]'); if (b) act(b.dataset.foot);
  });
  $('#viewer').addEventListener('click', () => $('#viewer').classList.remove('on'));

  // ปุ่ม Back ของมือถือ/เบราว์เซอร์ → ปิด overlay ทีละชั้น แทนการออกจากแอป
  window.addEventListener('popstate', () => {
    if ($('#viewer').classList.contains('on')) { $('#viewer').classList.remove('on'); return; }
    closeSheets(true);
  });
  // Esc → ปิด overlay (สำหรับผู้ใช้คีย์บอร์ด)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('#viewer').classList.contains('on')) { $('#viewer').classList.remove('on'); return; }
    if ($('#success').classList.contains('on')) { hideSuccess(); return; }
    if ($$('.sheet.on').length) closeSheets();
  });

  // report
  $('#seg-period').addEventListener('click', e => {
    const b = e.target.closest('.seg-item'); if (!b) return;
    reportPeriod = b.dataset.v;
    $$('#seg-period .seg-item').forEach(x => x.classList.toggle('active', x === b));
    renderReport();
  });

  // กลับมาที่หน้าจอ → ดึงข้อมูลล่าสุด ให้เห็นตรงกับคนอื่น
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ME) {
      loadJobs().then(() => { renderGallery(); renderReport(); updateBadges(); }).catch(() => {});
      loadNotifs().catch(() => {});
    }
  });
}

function hideSuccess() {
  const s = $('#success');
  s.classList.remove('on');
  s.setAttribute('aria-hidden', 'true');
}

/* ถ้ามีไฟล์โลโก้จริงที่ assets/logo.png จะสลับมาใช้อัตโนมัติ */
function detectLogo() {
  [['#logo-img', '#logo-text'], ['#lock-logo', '#lock-wordmark']].forEach(([i, t]) => {
    const img = $(i), txt = $(t);
    img.addEventListener('load', () => { img.hidden = false; txt.hidden = true; });
    img.addEventListener('error', () => { img.hidden = true; txt.hidden = false; });
  });
}

async function init() {
  detectLogo();
  $('#lock-ver').textContent = 'v' + APP_VERSION;
  fillSelects();
  bind();
  renderShots();      // วางช่องรูปว่างไว้ก่อน จะได้เห็นว่าถ่ายได้ 4 รูป
  restoreDraft();

  /* จำผู้ใช้เดิมไว้ — เปิดแอปครั้งต่อไปเข้าได้เลย (ยืนยันกับเซิร์ฟเวอร์อีกครั้ง) */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(K_USER) || 'null'); } catch (e) {}
  if (saved && saved.id) {
    ME = saved;
    try {
      const b = await api('/bootstrap');
      if (b.me) { await enterApp(); return; }
      ME = null; localStorage.removeItem(K_USER);
      showLockErr('บัญชีนี้ถูกปิดใช้งานหรือถูกลบแล้ว — ติดต่อผู้ดูแลระบบ');
    } catch (e) {
      ME = null;
      showLockErr(e.message);
    }
  }
  $('#lock-input').focus();
}

window.App = {
  get state() { return S; },
  get me() { return ME; },
  get filtered() { return visibleJobs(); },
  stats, periodJobs, ST, fmtTime, fmtDate, daysBetween, toast, photoDataURL,
  get areas() { return S.areas; },
  get period() { return reportPeriod; }
};

document.addEventListener('DOMContentLoaded', init);
})();
