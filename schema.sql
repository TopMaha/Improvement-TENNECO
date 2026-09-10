-- ============================================================
--  TENNECO Improvement — Cloudflare D1 schema
--  ใช้งาน:  npx wrangler d1 execute improvement-db --remote --file=./schema.sql
--  ไม่มีข้อมูลตัวอย่างในไฟล์นี้ — มีแต่ข้อมูลหลักที่ระบบต้องใช้จริง
-- ============================================================

-- ---------- พนักงาน ----------
-- id / name / dept  = คัดลอกมาจากฐานข้อมูล PSIF (ปุ่ม "ดึงรายชื่อจาก PSIF" ในหน้าตั้งค่า)
-- role              = สิทธิ์เฉพาะระบบ Improvement ตั้งเองในหน้าตั้งค่า การ sync จะไม่ทับค่านี้
--   user          พนักงาน           แจ้งงาน · เห็นทุกงานทั้งโรงงาน · ตอบกลับได้เฉพาะงานตัวเอง
--   manager       หัวหน้า/Manager   + อนุมัติ / ตอบกลับ / ปิดงาน เฉพาะแผนกตัวเอง
--   improve_admin Admin Improvement + จัดการได้ทุกงานทุกแผนก
--   admin         Super Admin       + เมนูตั้งค่า (สิทธิ์พนักงาน · พื้นที่ · ดึงรายชื่อจาก PSIF)
CREATE TABLE IF NOT EXISTS employees (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  dept      TEXT DEFAULT '',
  role      TEXT DEFAULT 'user',
  active    INTEGER DEFAULT 1,
  synced_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_emp_dept ON employees(dept);

-- ---------- พื้นที่ / ไลน์ผลิต ----------
CREATE TABLE IF NOT EXISTS areas (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  sort   INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

-- ---------- งาน Improvement ----------
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL,            -- IMP-YYMM-NN (YY = พ.ศ. 2 หลัก)
  reporter_id   TEXT NOT NULL,
  reporter_name TEXT DEFAULT '',
  dept          TEXT DEFAULT '',          -- แผนกของผู้แจ้ง ณ วันที่แจ้ง (ใช้กำหนดขอบเขตสิทธิ์ manager)
  area          TEXT NOT NULL,
  machine       TEXT DEFAULT '',
  title         TEXT NOT NULL,
  detail        TEXT DEFAULT '',
  -- submitted (รอตรวจสอบ) -> in_progress (กำลังดำเนินการ) -> done (จบงาน) | rejected (ไม่อนุมัติ)
  status        TEXT DEFAULT 'submitted',
  closed_at     TEXT DEFAULT '',
  request_id    TEXT DEFAULT '',          -- idempotency key จาก client กันบันทึกซ้ำตอนเน็ตสะดุด
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_code ON jobs(code);
CREATE INDEX IF NOT EXISTS idx_jobs_reporter   ON jobs(reporter_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_dept       ON jobs(dept);
CREATE INDEX IF NOT EXISTS idx_jobs_created    ON jobs(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_request_id ON jobs(request_id) WHERE request_id <> '';

-- ---------- รูป Before / After (เก็บไฟล์จริงใน R2 ตารางนี้เก็บแค่ key) ----------
CREATE TABLE IF NOT EXISTS job_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL,
  kind        TEXT NOT NULL,              -- before | after
  r2_key      TEXT NOT NULL,
  uploaded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_job ON job_photos(job_id);

-- ---------- ไทม์ไลน์: เปลี่ยนสถานะ + ข้อความตอบโต้ ----------
CREATE TABLE IF NOT EXISTS job_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  INTEGER NOT NULL,
  type    TEXT NOT NULL,                  -- status | note
  status  TEXT DEFAULT '',
  text    TEXT DEFAULT '',
  by_id   TEXT DEFAULT '',
  by_name TEXT DEFAULT '',
  by_role TEXT DEFAULT '',
  at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id, id);

-- ---------- แจ้งเตือน ----------
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL,
  job_id      INTEGER,
  message     TEXT NOT NULL,
  by_name     TEXT DEFAULT '',
  is_read     INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_emp ON notifications(employee_id, id DESC);

-- ---------- ตัวนับเลขที่งานต่อเดือน ----------
CREATE TABLE IF NOT EXISTS counters (
  k TEXT PRIMARY KEY,                     -- 'YYMM'
  n INTEGER DEFAULT 0
);

-- ============================================================
--  ข้อมูลหลักที่ระบบต้องมี (ไม่ใช่ข้อมูลตัวอย่าง)
-- ============================================================
INSERT OR IGNORE INTO areas (id, name, sort) VALUES
  ('VSM1',   'VSM1',   1),
  ('VSM2',   'VSM2',   2),
  ('VSM3',   'VSM3',   3),
  ('VSM4',   'VSM4',   4),
  ('OFFICE', 'OFFICE', 5);
