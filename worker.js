/* ============================================================
 *  TENNECO Improvement — Cloudflare Worker (API)
 *  Bindings (wrangler.toml):
 *    DB      -> D1  improvement-db   (schema.sql)
 *    PSIF_DB -> D1  psif-db          (อ่านอย่างเดียว — ต้นทางรายชื่อพนักงาน)
 *    BUCKET  -> R2  improvement-photos
 *  ทุก response เป็น { ok:true, ... } หรือ { ok:false, error }
 *  ตัวตนผู้เรียก: header X-Emp-Id — role อ่านจากตาราง employees ฝั่ง server เสมอ
 *  ไม่เชื่อ role ที่ client ส่งมา
 * ============================================================ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Emp-Id',
  'Access-Control-Max-Age': '86400',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
});
const ok  = (extra = {}) => json({ ok: true, ...extra });
const err = (msg, status = 400) => json({ ok: false, error: String(msg) }, status);

const VERSION = '1.0';

/* ---------------- เวลา ----------------
 * เก็บลง DB เป็น UTC (ISO) — ฝั่งหน้าเว็บแปลงเป็นเวลาไทยเอง
 * ส่วนเลขที่งาน IMP-YYMM-NN ต้องอิงเดือนตามเวลาไทย จึงบวก 7 ชม.ก่อนอ่านเดือน */
const nowISO = () => new Date().toISOString();
function thaiParts(d = new Date()) {
  const t = new Date(d.getTime() + 7 * 3600 * 1000);
  return { be2: String(t.getUTCFullYear() + 543).slice(2), mm: String(t.getUTCMonth() + 1).padStart(2, '0') };
}

/* ---------------- สิทธิ์ ----------------
 * user          พนักงาน            แจ้งงาน · เห็นทุกงาน · ตอบกลับเฉพาะงานตัวเอง
 * manager       หัวหน้า/Manager    + อนุมัติ / ตอบกลับ / ปิดงาน เฉพาะแผนกตัวเอง
 * improve_admin Admin Improvement  + จัดการทุกงานทุกแผนก
 * admin         Super Admin        + เมนูตั้งค่า
 * เพิ่ม/ลด role ที่นี่ที่เดียว (assets/app.js ใช้ชุดเดียวกัน) */
const ROLES = ['user', 'manager', 'improve_admin', 'admin'];
const isSuper      = r => r === 'admin';
const managesAll   = r => r === 'admin' || r === 'improve_admin';
const canManageJob = (me, job) =>
  managesAll(me.role) || (me.role === 'manager' && !!me.dept && String(job.dept || '') === String(me.dept || ''));

async function getActor(env, request) {
  let id = request.headers.get('X-Emp-Id') || '';
  try { id = decodeURIComponent(id); } catch (_) { /* ไม่ใช่ URI-encoded ก็ใช้ตามนั้น */ }
  id = String(id).trim();
  if (!id) return null;
  const emp = await env.DB.prepare(
    'SELECT id,name,dept,role,active FROM employees WHERE id=? COLLATE NOCASE'
  ).bind(id).first();
  return (emp && emp.active !== 0) ? emp : null;
}
async function requireUser(env, request) {
  const me = await getActor(env, request);
  if (!me) return { error: err('ไม่ทราบตัวตนผู้ใช้ — กรุณาเข้าสู่ระบบใหม่', 401) };
  return { me };
}
async function requireSuper(env, request) {
  const r = await requireUser(env, request);
  if (r.error) return r;
  if (!isSuper(r.me.role)) return { error: err('เฉพาะ Super Admin เท่านั้น (เมนูตั้งค่า)', 403) };
  return r;
}

/* ---------------- router ---------------- */
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const seg = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    const head = seg[0] || '';
    const M = request.method;
    try {
      /* รูปเป็นไฟล์ไบนารี — จัดการก่อนเข้า router ที่ตอบ JSON */
      if (head === 'photo' && M === 'GET' && seg[1]) return await servePhoto(env, decodeURIComponent(seg.slice(1).join('/')));
      if (head === 'photo' && M === 'POST') return await uploadPhoto(env, request);

      switch (head) {
        case '':
        case 'health':        return ok({ service: 'improvement', version: VERSION, time: nowISO() });
        case 'login':         return await loginRoute(env, request);
        case 'bootstrap':     return await bootstrapRoute(env, request);
        case 'jobs':          return await jobsRoute(env, request, seg);
        case 'employees':     return await employeesRoute(env, request, seg);
        case 'areas':         return await areasRoute(env, request, seg);
        case 'notifications': return await notifRoute(env, request, seg);
        default:              return err('ไม่พบปลายทางนี้: /' + head, 404);
      }
    } catch (e) {
      return err('เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์: ' + (e && e.message ? e.message : e), 500);
    }
  },
};

/* ============================================================
 *  LOGIN — ล็อกอินด้วยรหัสพนักงานอย่างเดียว (ไม่มีรหัสผ่าน เหมือนระบบ PSIF)
 * ============================================================ */
const bare = s => String(s || '').replace(/[\s\-_.]/g, '').toUpperCase();

async function loginRoute(env, request) {
  if (request.method !== 'POST') return err('ต้องเรียกด้วย POST', 405);
  const body = await request.json().catch(() => ({}));
  const raw = String(body.code || '').trim();
  if (!raw) return err('กรุณากรอกรหัสพนักงาน');

  /* ตรงเป๊ะก่อน แล้วค่อยยอมรับรหัสที่ขีด/ช่องว่างต่างกัน (G260 = G-260) */
  let emp = await env.DB.prepare(
    'SELECT id,name,dept,role,active FROM employees WHERE id=? COLLATE NOCASE').bind(raw).first();
  if (!emp) {
    const all = await env.DB.prepare('SELECT id,name,dept,role,active FROM employees').all();
    const b = bare(raw);
    emp = (all.results || []).find(e => bare(e.id) === b) || null;
  }
  if (!emp) {
    const n = await env.DB.prepare('SELECT COUNT(*) c FROM employees').first();
    if (!n || !n.c) return err('ยังไม่มีรายชื่อพนักงานในระบบ — ให้ผู้ดูแลกดปุ่ม "ดึงรายชื่อจาก PSIF" ก่อน', 404);
    return err('ไม่พบรหัสพนักงานนี้ (ลองใส่ขีด เช่น G-260)', 404);
  }
  if (emp.active === 0) return err('รหัสนี้ถูกปิดใช้งานแล้ว — ติดต่อผู้ดูแลระบบ', 403);
  return ok({ me: { id: emp.id, name: emp.name, dept: emp.dept || '', role: emp.role || 'user' } });
}

/* ข้อมูลตั้งต้นหลังล็อกอิน: พื้นที่ · รายการเครื่องจักรที่เคยใช้ · จำนวนงานค้างอนุมัติ */
async function bootstrapRoute(env, request) {
  const me = await getActor(env, request);
  const areas = await env.DB.prepare('SELECT id,name FROM areas WHERE active=1 ORDER BY sort,id').all();
  const machines = await env.DB.prepare(
    "SELECT DISTINCT machine FROM jobs WHERE machine<>'' ORDER BY machine").all();
  const pend = await env.DB.prepare("SELECT COUNT(*) c FROM jobs WHERE status='submitted'").first();
  const emps = await env.DB.prepare('SELECT COUNT(*) c FROM employees').first();
  return ok({
    version: VERSION,
    areas: (areas.results || []).map(a => a.name),
    machines: (machines.results || []).map(m => m.machine),
    pending: (pend && pend.c) || 0,
    employees: (emps && emps.c) || 0,
    me: me ? { id: me.id, name: me.name, dept: me.dept || '', role: me.role || 'user' } : null,
  });
}

/* ============================================================
 *  JOBS
 * ============================================================ */
async function jobsRoute(env, request, seg) {
  const M = request.method;
  const id = seg[1] && /^\d+$/.test(seg[1]) ? Number(seg[1]) : null;

  if (M === 'GET'  && !id)                       return await listJobs(env, request);
  if (M === 'GET'  && id)                        return await getJob(env, request, id);
  if (M === 'POST' && !seg[1])                   return await createJob(env, request);
  if (M === 'POST' && id && seg[2] === 'note')   return await addNote(env, request, id);
  if (M === 'POST' && id && seg[2] === 'photos') return await addPhotos(env, request, id);
  if (M === 'PATCH' && id)                       return await actOnJob(env, request, id);
  if (M === 'DELETE' && id)                      return await deleteJob(env, request, id);
  return err('ไม่รองรับคำสั่งนี้', 405);
}

/* แนบ key รูปให้ทุกงานในชุดเดียว — ไม่ต้องยิงคิวรีต่อ 1 งาน */
async function attachPhotos(env, rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const ph = await env.DB.prepare(
    'SELECT job_id,kind,r2_key FROM job_photos WHERE job_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY id'
  ).bind(...ids).all();
  const map = {};
  (ph.results || []).forEach(p => {
    const m = (map[p.job_id] = map[p.job_id] || { before: [], after: [] });
    if (m[p.kind]) m[p.kind].push(p.r2_key);
  });
  rows.forEach(r => { const m = map[r.id] || { before: [], after: [] }; r.before = m.before; r.after = m.after; });
  return rows;
}

async function listJobs(env, request) {
  const u = new URL(request.url);
  const q = (u.searchParams.get('q') || '').trim();
  const status = (u.searchParams.get('status') || '').trim();   // คั่นด้วย , ได้
  const area = (u.searchParams.get('area') || '').trim();
  const machine = (u.searchParams.get('machine') || '').trim();
  const mine = u.searchParams.get('mine') === '1';
  const me = await getActor(env, request);

  const where = [], bind = [];
  if (status && status !== 'all') {
    const list = status.split(',').filter(Boolean);
    if (list.length) { where.push('status IN (' + list.map(() => '?').join(',') + ')'); bind.push(...list); }
  }
  if (area)    { where.push('area=?');    bind.push(area); }
  if (machine) { where.push('machine=?'); bind.push(machine); }
  if (mine && me) { where.push('reporter_id=?'); bind.push(me.id); }
  if (q) {
    where.push('(code LIKE ? OR title LIKE ? OR detail LIKE ? OR machine LIKE ? OR reporter_name LIKE ? OR area LIKE ?)');
    const like = '%' + q + '%';
    for (let i = 0; i < 6; i++) bind.push(like);
  }
  const sql = 'SELECT * FROM jobs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
              ' ORDER BY datetime(created_at) DESC, id DESC LIMIT 800';
  const rs = await env.DB.prepare(sql).bind(...bind).all();
  const rows = await attachPhotos(env, rs.results || []);
  const pend = await env.DB.prepare("SELECT COUNT(*) c FROM jobs WHERE status='submitted'").first();
  return ok({ jobs: rows, pending: (pend && pend.c) || 0 });
}

async function getJob(env, request, id) {
  const j = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
  if (!j) return err('ไม่พบงานนี้', 404);
  const ph = await env.DB.prepare('SELECT kind,r2_key FROM job_photos WHERE job_id=? ORDER BY id').bind(id).all();
  const ev = await env.DB.prepare('SELECT * FROM job_events WHERE job_id=? ORDER BY id').bind(id).all();
  j.before = (ph.results || []).filter(p => p.kind === 'before').map(p => p.r2_key);
  j.after  = (ph.results || []).filter(p => p.kind === 'after').map(p => p.r2_key);
  j.events = ev.results || [];
  return ok({ job: j });
}

async function nextCode(env) {
  const { be2, mm } = thaiParts();
  const k = be2 + mm;
  const row = await env.DB.prepare(
    'INSERT INTO counters (k,n) VALUES (?,1) ON CONFLICT(k) DO UPDATE SET n=n+1 RETURNING n'
  ).bind(k).first();
  return 'IMP-' + k + '-' + String((row && row.n) || 1).padStart(2, '0');
}

async function createJob(env, request) {
  const { me, error } = await requireUser(env, request);
  if (error) return error;
  const b = await request.json().catch(() => ({}));

  const area = String(b.area || '').trim();
  const machine = String(b.machine || '').trim();
  const title = String(b.title || '').trim();
  const detail = String(b.detail || '').trim();
  const before = Array.isArray(b.before) ? b.before.filter(Boolean).slice(0, 4) : [];
  const reqId = String(b.request_id || '').trim();

  if (!before.length) return err('ต้องแนบรูป Before อย่างน้อย 1 รูป');
  if (!area)    return err('กรุณาเลือกพื้นที่');
  if (!machine) return err('กรุณาระบุเครื่องจักร');
  if (!title)   return err('กรุณากรอกหัวข้อ');
  if (!detail)  return err('กรุณากรอกรายละเอียด');

  /* กันบันทึกซ้ำตอนกดส่งแล้วเน็ตสะดุด — request_id เดิมคืนงานเดิม ไม่สร้างใหม่ */
  if (reqId) {
    const dup = await env.DB.prepare('SELECT * FROM jobs WHERE request_id=?').bind(reqId).first();
    if (dup) { const d = await attachPhotos(env, [dup]); return ok({ job: d[0], duplicate: true }); }
  }

  const at = nowISO();
  const code = await nextCode(env);
  const ins = await env.DB.prepare(
    'INSERT INTO jobs (code,reporter_id,reporter_name,dept,area,machine,title,detail,status,request_id,created_at,updated_at)' +
    " VALUES (?,?,?,?,?,?,?,?,'submitted',?,?,?) RETURNING id"
  ).bind(code, me.id, me.name, me.dept || '', area, machine, title, detail, reqId, at, at).first();
  const jobId = ins.id;

  const stmts = before.map(key =>
    env.DB.prepare('INSERT INTO job_photos (job_id,kind,r2_key,uploaded_at) VALUES (?,?,?,?)')
      .bind(jobId, 'before', String(key), at));
  stmts.push(env.DB.prepare(
    "INSERT INTO job_events (job_id,type,status,text,by_id,by_name,by_role,at) VALUES (?,'status','submitted','ส่งข้อมูลเข้าระบบ',?,?,?,?)"
  ).bind(jobId, me.id, me.name, me.role, at));
  await env.DB.batch(stmts);

  await notifyManagers(env, jobId, me, code + ' · ' + title, 'มีงานใหม่รอตรวจสอบ');
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first();
  job.before = before; job.after = [];
  return ok({ job });
}

/* แนบรูป After — เฉพาะคนที่ดูแลงานนั้นได้ */
async function addPhotos(env, request, id) {
  const { me, error } = await requireUser(env, request);
  if (error) return error;
  const j = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
  if (!j) return err('ไม่พบงานนี้', 404);
  if (!canManageJob(me, j)) return err('ไม่มีสิทธิ์แนบรูปในงานนี้', 403);
  const b = await request.json().catch(() => ({}));
  const kind = b.kind === 'before' ? 'before' : 'after';
  const keys = Array.isArray(b.keys) ? b.keys.filter(Boolean).slice(0, 4) : [];
  if (!keys.length) return err('ไม่มีรูปที่จะบันทึก');
  const at = nowISO();
  const stmts = keys.map(k =>
    env.DB.prepare('INSERT INTO job_photos (job_id,kind,r2_key,uploaded_at) VALUES (?,?,?,?)')
      .bind(id, kind, String(k), at));
  stmts.push(env.DB.prepare('UPDATE jobs SET updated_at=? WHERE id=?').bind(at, id));
  await env.DB.batch(stmts);
  return ok({ added: keys.length });
}

/* ข้อความตอบโต้: ผู้แจ้งคุยในงานตัวเองได้ · ผู้ดูแลงานตอบได้ */
async function addNote(env, request, id) {
  const { me, error } = await requireUser(env, request);
  if (error) return error;
  const j = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
  if (!j) return err('ไม่พบงานนี้', 404);
  const isOwner = String(j.reporter_id) === String(me.id);
  if (!isOwner && !canManageJob(me, j)) return err('ไม่มีสิทธิ์ตอบกลับในงานนี้', 403);
  const b = await request.json().catch(() => ({}));
  const text = String(b.text || '').trim();
  if (!text) return err('กรุณาพิมพ์ข้อความก่อนส่ง');
  const at = nowISO();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO job_events (job_id,type,status,text,by_id,by_name,by_role,at) VALUES (?,'note','',?,?,?,?,?)")
      .bind(id, text, me.id, me.name, me.role, at),
    env.DB.prepare('UPDATE jobs SET updated_at=? WHERE id=?').bind(at, id),
  ]);
  if (isOwner) await notifyManagers(env, id, me, j.code + ' · ' + text, 'ผู้แจ้งส่งข้อความ');
  else await notifyOne(env, j.reporter_id, id, me, j.code + ' · ' + text, 'มีข้อความตอบกลับ');
  return ok();
}

const NEXT_TEXT = {
  approve: 'อนุมัติแล้ว เริ่มดำเนินการ',
  close:   'ดำเนินการแล้วเสร็จ ปิดงาน',
  reopen:  'เปิดงานอีกครั้งเพื่อดำเนินการต่อ',
};

async function actOnJob(env, request, id) {
  const { me, error } = await requireUser(env, request);
  if (error) return error;
  const j = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
  if (!j) return err('ไม่พบงานนี้', 404);
  if (!canManageJob(me, j)) return err('ไม่มีสิทธิ์จัดการงานนี้ (งานอยู่แผนก ' + (j.dept || '-') + ')', 403);

  const b = await request.json().catch(() => ({}));
  const action = String(b.action || '');
  const at = nowISO();
  let status = j.status, closed = j.closed_at, text = '';

  if (action === 'approve') {
    if (j.status !== 'submitted') return err('งานนี้ผ่านขั้นตอนอนุมัติไปแล้ว');
    status = 'in_progress'; closed = ''; text = NEXT_TEXT.approve;
  } else if (action === 'reject') {
    const why = String(b.reason || '').trim();
    if (!why) return err('กรุณาระบุเหตุผลที่ไม่อนุมัติ');
    status = 'rejected'; closed = at; text = 'ไม่อนุมัติ — ' + why;
  } else if (action === 'close') {
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM job_photos WHERE job_id=? AND kind='after'").bind(id).first();
    if (!n || !n.c) return err('ต้องแนบรูป After ก่อนปิดงาน');
    status = 'done'; closed = at; text = String(b.text || '').trim() || NEXT_TEXT.close;
  } else if (action === 'reopen') {
    status = 'in_progress'; closed = ''; text = NEXT_TEXT.reopen;
  } else return err('คำสั่งไม่ถูกต้อง');

  await env.DB.batch([
    env.DB.prepare('UPDATE jobs SET status=?,closed_at=?,updated_at=? WHERE id=?').bind(status, closed, at, id),
    env.DB.prepare("INSERT INTO job_events (job_id,type,status,text,by_id,by_name,by_role,at) VALUES (?,'status',?,?,?,?,?,?)")
      .bind(id, status, text, me.id, me.name, me.role, at),
  ]);
  await notifyOne(env, j.reporter_id, id, me, j.code + ' · ' + text, 'อัปเดตสถานะงาน');

  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
  return ok({ job });
}

/* ลบงาน — เฉพาะ Super Admin (ลบรูปใน R2 ให้ด้วย จะได้ไม่เหลือไฟล์ค้าง) */
async function deleteJob(env, request, id) {
  const { error } = await requireSuper(env, request);
  if (error) return error;
  const ph = await env.DB.prepare('SELECT r2_key FROM job_photos WHERE job_id=?').bind(id).all();
  for (const p of (ph.results || [])) { try { await env.BUCKET.delete(p.r2_key); } catch (_) { /* ไฟล์หายไปแล้วก็ข้าม */ } }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM job_photos WHERE job_id=?').bind(id),
    env.DB.prepare('DELETE FROM job_events WHERE job_id=?').bind(id),
    env.DB.prepare('DELETE FROM notifications WHERE job_id=?').bind(id),
    env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id),
  ]);
  return ok();
}

/* ============================================================
 *  PHOTOS (R2)
 * ============================================================ */
async function uploadPhoto(env, request) {
  const me = await getActor(env, request);
  if (!me) return err('ไม่ทราบตัวตนผู้ใช้ — กรุณาเข้าสู่ระบบใหม่', 401);
  const ct = request.headers.get('Content-Type') || 'image/jpeg';
  if (!/^image\//.test(ct)) return err('รองรับเฉพาะไฟล์รูปภาพ');
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return err('ไฟล์ว่าง');
  if (buf.byteLength > 6 * 1024 * 1024) return err('รูปใหญ่เกิน 6 MB');
  const { be2, mm } = thaiParts();
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
  const key = 'jobs/' + be2 + mm + '/' + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8) + '.' + ext;
  await env.BUCKET.put(key, buf, {
    httpMetadata: { contentType: ct, cacheControl: 'public, max-age=31536000, immutable' },
  });
  return ok({ key });
}

async function servePhoto(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response('ไม่พบรูป', { status: 404, headers: CORS });
  const h = new Headers(CORS);
  h.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg');
  h.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (obj.httpEtag) h.set('ETag', obj.httpEtag);
  return new Response(obj.body, { headers: h });
}

/* ============================================================
 *  EMPLOYEES — สิทธิ์ในระบบ Improvement + ดึงรายชื่อจาก PSIF
 * ============================================================ */
async function employeesRoute(env, request, seg) {
  const M = request.method;
  if (M === 'POST' && seg[1] === 'sync') return await syncFromPsif(env, request);

  if (M === 'GET') {
    const { me, error } = await requireUser(env, request);
    if (error) return error;
    if (!managesAll(me.role) && me.role !== 'manager') return err('ไม่มีสิทธิ์ดูรายชื่อพนักงาน', 403);
    const rs = await env.DB.prepare(
      'SELECT id,name,dept,role,active,synced_at FROM employees ORDER BY dept,name').all();
    return ok({ employees: rs.results || [] });
  }

  if (M === 'PATCH' && seg[1]) {
    const { error } = await requireSuper(env, request);
    if (error) return error;
    const id = decodeURIComponent(seg[1]);
    const b = await request.json().catch(() => ({}));
    const sets = [], bind = [];
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) return err('สิทธิ์ไม่ถูกต้อง');
      sets.push('role=?'); bind.push(b.role);
    }
    if (b.active !== undefined) { sets.push('active=?'); bind.push(b.active ? 1 : 0); }
    if (b.dept !== undefined)   { sets.push('dept=?');   bind.push(String(b.dept || '')); }
    if (!sets.length) return err('ไม่มีข้อมูลที่จะแก้ไข');
    bind.push(id);
    const r = await env.DB.prepare('UPDATE employees SET ' + sets.join(',') + ' WHERE id=? COLLATE NOCASE').bind(...bind).run();
    if (!r.meta || !r.meta.changes) return err('ไม่พบพนักงานรหัสนี้', 404);
    const emp = await env.DB.prepare('SELECT id,name,dept,role,active FROM employees WHERE id=? COLLATE NOCASE').bind(id).first();
    return ok({ employee: emp });
  }
  return err('ไม่รองรับคำสั่งนี้', 405);
}

/* ดึงรายชื่อจาก PSIF (psif-db) — อัปเดตชื่อ / แผนก / สถานะใช้งาน
 * แต่ "ไม่แตะ role" ของระบบ Improvement ที่ตั้งไว้แล้ว เพราะสิทธิ์คนละชุดกับ PSIF
 * รหัสที่ขึ้นต้น RESIGNED- ใน PSIF = ช่องเก็บข้อมูลคนลาออก ไม่ใช่คน จึงข้ามไป
 * เรียกครั้งแรกทำได้โดยยังไม่ต้องมี Super Admin — ตอนนั้นตาราง employees ยังว่าง ไม่มีใครล็อกอินได้เลย */
async function syncFromPsif(env, request) {
  const cnt = await env.DB.prepare('SELECT COUNT(*) c FROM employees').first();
  const firstRun = !cnt || !cnt.c;
  if (!firstRun) {
    const { error } = await requireSuper(env, request);
    if (error) return error;
  }
  if (!env.PSIF_DB) return err('ยังไม่ได้ผูกฐานข้อมูล PSIF (binding PSIF_DB) กับ Worker นี้', 500);

  const src = await env.PSIF_DB.prepare(
    "SELECT id,name,vsm,role,active FROM employees WHERE id NOT LIKE 'RESIGNED-%'").all();
  const rows = src.results || [];
  if (!rows.length) return err('ไม่พบรายชื่อในฐานข้อมูล PSIF');

  const at = nowISO();
  const b = await request.json().catch(() => ({}));
  /* ครั้งแรก: แปลง role ของ PSIF เป็นสิทธิ์ตั้งต้นของ Improvement เพื่อให้มีคนเข้าหน้าตั้งค่าได้
     ครั้งต่อไป: ไม่ยุ่งกับ role ที่ตั้งไว้เลย (เว้นแต่ส่ง reset_roles มาโดยตรง) */
  const mapRole = (b.reset_roles || firstRun)
    ? (r => (r === 'admin' ? 'admin' : (r === 'dept_admin' || r === 'manager') ? 'manager' : 'user'))
    : null;

  const stmts = rows.map(e => mapRole
    ? env.DB.prepare(
        'INSERT INTO employees (id,name,dept,role,active,synced_at) VALUES (?,?,?,?,?,?)' +
        ' ON CONFLICT(id) DO UPDATE SET name=excluded.name,dept=excluded.dept,role=excluded.role,' +
        ' active=excluded.active,synced_at=excluded.synced_at'
      ).bind(e.id, e.name, e.vsm || '', mapRole(e.role), e.active === 0 ? 0 : 1, at)
    : env.DB.prepare(
        "INSERT INTO employees (id,name,dept,role,active,synced_at) VALUES (?,?,?,'user',?,?)" +
        ' ON CONFLICT(id) DO UPDATE SET name=excluded.name,dept=excluded.dept,' +
        ' active=excluded.active,synced_at=excluded.synced_at'
      ).bind(e.id, e.name, e.vsm || '', e.active === 0 ? 0 : 1, at));

  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  const admins = await env.DB.prepare("SELECT id,name FROM employees WHERE role='admin' ORDER BY id").all();
  return ok({ synced: rows.length, first_run: firstRun, admins: admins.results || [], at });
}

/* ============================================================
 *  AREAS
 * ============================================================ */
async function areasRoute(env, request, seg) {
  const M = request.method;
  if (M === 'GET') {
    const rs = await env.DB.prepare('SELECT id,name,sort,active FROM areas ORDER BY sort,id').all();
    return ok({ areas: rs.results || [] });
  }
  const { error } = await requireSuper(env, request);
  if (error) return error;

  if (M === 'POST') {
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || '').trim();
    if (!name) return err('กรุณากรอกชื่อพื้นที่');
    const mx = await env.DB.prepare('SELECT COALESCE(MAX(sort),0) m FROM areas').first();
    await env.DB.prepare('INSERT OR REPLACE INTO areas (id,name,sort,active) VALUES (?,?,?,1)')
      .bind(name, name, ((mx && mx.m) || 0) + 1).run();
    return ok();
  }
  if (M === 'DELETE' && seg[1]) {
    const id = decodeURIComponent(seg[1]);
    const used = await env.DB.prepare('SELECT COUNT(*) c FROM jobs WHERE area=?').bind(id).first();
    if (used && used.c) {  // มีงานอ้างอยู่ — ปิดใช้งานแทนการลบ ประวัติจะได้ไม่พัง
      await env.DB.prepare('UPDATE areas SET active=0 WHERE id=?').bind(id).run();
      return ok({ disabled: true, jobs: used.c });
    }
    await env.DB.prepare('DELETE FROM areas WHERE id=?').bind(id).run();
    return ok({ deleted: true });
  }
  return err('ไม่รองรับคำสั่งนี้', 405);
}

/* ============================================================
 *  NOTIFICATIONS
 * ============================================================ */
async function notifyOne(env, employeeId, jobId, by, message, prefix) {
  if (!employeeId || String(employeeId) === String(by.id)) return;
  await env.DB.prepare(
    'INSERT INTO notifications (employee_id,job_id,message,by_name,created_at) VALUES (?,?,?,?,?)'
  ).bind(employeeId, jobId, (prefix ? prefix + ' — ' : '') + message, by.name, nowISO()).run();
}

/* แจ้งผู้ดูแล: Admin Improvement + Super Admin ทุกคน และ Manager ของแผนกผู้แจ้ง */
async function notifyManagers(env, jobId, by, message, prefix) {
  const rs = await env.DB.prepare(
    "SELECT id FROM employees WHERE active=1 AND (role IN ('improve_admin','admin') OR (role='manager' AND dept=?))"
  ).bind(by.dept || '').all();
  const at = nowISO();
  const stmts = (rs.results || []).filter(e => String(e.id) !== String(by.id)).map(e =>
    env.DB.prepare('INSERT INTO notifications (employee_id,job_id,message,by_name,created_at) VALUES (?,?,?,?,?)')
      .bind(e.id, jobId, (prefix ? prefix + ' — ' : '') + message, by.name, at));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

async function notifRoute(env, request, seg) {
  const { me, error } = await requireUser(env, request);
  if (error) return error;
  if (request.method === 'GET') {
    const rs = await env.DB.prepare(
      'SELECT id,job_id,message,by_name,is_read,created_at FROM notifications WHERE employee_id=? ORDER BY id DESC LIMIT 50'
    ).bind(me.id).all();
    const un = await env.DB.prepare('SELECT COUNT(*) c FROM notifications WHERE employee_id=? AND is_read=0').bind(me.id).first();
    return ok({ notifications: rs.results || [], unread: (un && un.c) || 0 });
  }
  if (request.method === 'POST' && seg[1] === 'read') {
    await env.DB.prepare('UPDATE notifications SET is_read=1 WHERE employee_id=?').bind(me.id).run();
    return ok();
  }
  return err('ไม่รองรับคำสั่งนี้', 405);
}
