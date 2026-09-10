/* =====================================================================
   TENNECO IMPROVEMENT — Excel report (ExcelJS)
   3 ชีต : สรุปภาพรวม · รายการงาน (ฝังรูป) · เปรียบเทียบ Before-After
   ===================================================================== */
(function () {
'use strict';

/* ---------- โทนสีของรายงาน ---------- */
const NAVY   = 'FF0E36A0';   // น้ำเงินแบรนด์
const NAVY_D = 'FF071B4F';   // น้ำเงินเข้ม
const BLUE   = 'FF2A5BD7';   // น้ำเงินหัวตาราง
const BLUE_L = 'FFF0F4FE';   // พื้นอ่อน
const LINE   = 'FFDDE5F5';
const ZEBRA  = 'FFF8FAFE';
const WHITE  = 'FFFFFFFF';
const GREY   = 'FF5F7387';
const INK    = 'FF0A1B2E';

const C  = { submitted: 'FFB8720A', in_progress: 'FF2A5BD7', done: 'FF07714E', rejected: 'FFB31B29' };
const CB = { submitted: 'FFFDF3E0', in_progress: 'FFDCE6FC', done: 'FFE4F6EF', rejected: 'FFFCE9EB' };

const FONT = 'Tahoma';        // มีอยู่ทุกเครื่อง + อ่านภาษาไทยได้
const MONO = 'Consolas';

/* ---------- helper ---------- */
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = (c) => ({ style: 'thin', color: { argb: c || LINE } });
const box = (c) => ({ top: thin(c), left: thin(c), bottom: thin(c), right: thin(c) });
const mid = (h, indent) => ({ vertical: 'middle', horizontal: h || 'center', wrapText: true, indent: indent || 0 });

/* แถบความคืบหน้าแบบตัวอักษร — ปลอดภัยกับ Excel ทุกเวอร์ชัน และพิมพ์ออกมาสวย */
function progressBar(rate) {
  const filled = Math.max(0, Math.min(10, Math.round(rate / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/* หัวรายงานแบบ 3 แถบ */
function titleBlock(ws, span, title, sub) {
  ws.mergeCells(1, 1, 1, span);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: FONT, size: 18, bold: true, color: { argb: WHITE } };
  t.fill = fill(NAVY);
  t.alignment = mid('left', 1);
  ws.getRow(1).height = 40;

  ws.mergeCells(2, 1, 2, span);
  const s = ws.getCell(2, 1);
  s.value = sub;
  s.font = { name: FONT, size: 9, color: { argb: 'FFC3D4F5' } };
  s.fill = fill(NAVY_D);
  s.alignment = mid('left', 1);
  ws.getRow(2).height = 19;

  ws.mergeCells(3, 1, 3, span);          // เส้นคาดสีฟ้าอ่อน
  ws.getCell(3, 1).fill = fill('FF9DB8F5');
  ws.getRow(3).height = 4;
  ws.getRow(4).height = 8;
}

function headerRow(ws, rowNo, values, widths) {
  const r = ws.getRow(rowNo);
  values.forEach((v, i) => {
    const c = r.getCell(i + 1);
    c.value = v;
    c.font = { name: FONT, size: 9.5, bold: true, color: { argb: WHITE } };
    c.fill = fill(BLUE);
    c.alignment = mid('center');
    c.border = box('FF1F4BC4');
  });
  r.height = 30;
  if (widths) widths.forEach((w, i) => ws.getColumn(i + 1).width = w);
}

function sectionRow(ws, rowNo, span, text, note) {
  ws.mergeCells(rowNo, 1, rowNo, span);
  const c = ws.getCell(rowNo, 1);
  c.value = text + (note ? '        ' + note : '');
  c.font = { name: FONT, size: 11.5, bold: true, color: { argb: NAVY } };
  c.fill = fill(BLUE_L);
  c.alignment = mid('left', 1);
  c.border = { left: { style: 'thick', color: { argb: NAVY } }, bottom: thin() };
  ws.getRow(rowNo).height = 26;
}

/* =====================================================================
   BUILD
   ===================================================================== */
async function buildWorkbook() {
  const A = window.App;
  const jobs = A.periodJobs().slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  /* รูปเก็บอยู่บน R2 — ExcelJS ฝังได้เฉพาะ base64 จึงต้องโหลดรูปที่จะใช้มาก่อน */
  const PIC = {};
  await Promise.all([...new Set(jobs.flatMap(j => [j.before[0], j.after[0]]).filter(Boolean))]
    .map(async u => { PIC[u] = await A.photoDataURL(u); }));
  const pic = u => (u && PIC[u]) || '';
  const s = A.stats(jobs);
  const now = new Date();
  const stamp = now.toLocaleDateString('th-TH', { day: '2-digit', month: 'long', year: 'numeric' }) +
    ' เวลา ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ' น.';
  const range = A.period === 'all' ? 'ข้อมูลทั้งหมด' : A.period + ' วันล่าสุด';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'TENNECO Improvement App';
  wb.created = now;
  wb.company = 'TENNECO';

  /* ==================== SHEET 1 : สรุปภาพรวม ==================== */
  const ws = wb.addWorksheet('สรุปภาพรวม', {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
    }
  });
  ws.properties.tabColor = { argb: NAVY };
  ws.headerFooter.oddFooter = '&L&8 TENNECO Improvement&C&8 หน้า &P / &N&R&8 &D';

  const SPAN = 9;
  titleBlock(ws, SPAN, '    รายงานสรุปงาน IMPROVEMENT',
    '    TENNECO   |   ช่วงข้อมูล: ' + range + '   |   จำนวน ' + jobs.length +
    ' รายการ   |   ออกรายงาน ' + stamp);

  /* --- แถบ KPI แบบการ์ด (แถบสีบาง + ป้าย + ตัวเลขใหญ่) --- */
  const kpis = [
    ['งานทั้งหมด', s.total, NAVY],
    ['รอตรวจสอบ', s.submitted, C.submitted],
    ['กำลังดำเนินการ', s.in_progress, C.in_progress],
    ['จบงาน', s.done, C.done],
    ['ไม่อนุมัติ', s.rejected, C.rejected],
    ['อัตราปิดงาน', s.rate / 100, C.done, '0%'],
    ['เวลาเฉลี่ย (วัน)', Number(s.lead.toFixed(1)), NAVY],
    ['พื้นที่ที่แจ้ง', new Set(jobs.map(j => j.area)).size, NAVY],
    ['ผู้แจ้งทั้งหมด', new Set(jobs.map(j => j.reporter)).size, NAVY]
  ];
  const rCap = ws.getRow(5), rLbl = ws.getRow(6), rVal = ws.getRow(7);
  kpis.forEach((k, i) => {
    const col = i + 1;
    ws.getColumn(col).width = i === 0 ? 22 : 15.5;

    const cap = rCap.getCell(col);
    cap.fill = fill(k[2]);
    cap.border = { left: thin(), right: thin(), top: thin(k[2]) };

    const lbl = rLbl.getCell(col);
    lbl.value = k[0];
    lbl.font = { name: FONT, size: 9, color: { argb: GREY } };
    lbl.fill = fill('FFFBFCFF');
    lbl.alignment = mid('center');
    lbl.border = { left: thin(), right: thin() };

    const val = rVal.getCell(col);
    val.value = k[1];
    if (k[3]) val.numFmt = k[3];
    val.font = { name: FONT, size: 20, bold: true, color: { argb: k[2] } };
    val.fill = fill('FFFBFCFF');
    val.alignment = mid('center');
    val.border = { left: thin(), right: thin(), bottom: thin() };
  });
  rCap.height = 5; rLbl.height = 18; rVal.height = 34; ws.getRow(8).height = 12;

  /* --- ตารางสรุปตามพื้นที่ --- */
  sectionRow(ws, 9, SPAN, 'สรุปตามพื้นที่', '(แสดงครบทุกพื้นที่ แม้ยังไม่มีงานแจ้งเข้า)');
  headerRow(ws, 10, ['พื้นที่', 'ทั้งหมด', 'รอตรวจสอบ', 'กำลังดำเนินการ', 'จบงาน', 'ไม่อนุมัติ',
    '% ปิดงาน', 'ความคืบหน้า', 'เวลาเฉลี่ย (วัน)']);

  const byArea = {};
  jobs.forEach(j => (byArea[j.area] = byArea[j.area] || []).push(j));
  const areaList = (A.areas && A.areas.length) ? A.areas.slice() : Object.keys(byArea);
  Object.keys(byArea).forEach(a => { if (areaList.indexOf(a) < 0) areaList.push(a); });

  let r = 11;
  areaList.forEach((area, idx) => {
    const st = A.stats(byArea[area] || []);
    const row = ws.getRow(r);
    [area, st.total, st.submitted, st.in_progress, st.done, st.rejected,
      st.rate / 100, progressBar(st.rate), Number(st.lead.toFixed(1))].forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v;
      c.border = box();
      c.alignment = mid(i === 0 ? 'left' : 'center', i === 0 ? 1 : 0);
      c.font = { name: FONT, size: 10, color: { argb: 'FF41556E' } };
      if (i === 0) c.font = { name: FONT, size: 11, bold: true, color: { argb: NAVY } };
      if (i === 6) { c.numFmt = '0%'; c.font = { name: FONT, size: 10.5, bold: true, color: { argb: C.done } }; }
      if (i === 7) c.font = { name: MONO, size: 11, color: { argb: st.rate >= 50 ? C.done : C.submitted } };
      if (idx % 2) c.fill = fill(ZEBRA);
    });
    row.height = 22;
    r++;
  });

  const tot = ws.getRow(r);
  ['รวมทั้งหมด', s.total, s.submitted, s.in_progress, s.done, s.rejected,
    s.rate / 100, progressBar(s.rate), Number(s.lead.toFixed(1))].forEach((v, i) => {
    const c = tot.getCell(i + 1);
    c.value = v;
    c.font = { name: i === 7 ? MONO : FONT, size: i === 7 ? 11 : 10.5, bold: true, color: { argb: WHITE } };
    c.fill = fill(NAVY);
    c.alignment = mid(i === 0 ? 'left' : 'center', i === 0 ? 1 : 0);
    c.border = box(NAVY);
    if (i === 6) c.numFmt = '0%';
  });
  tot.height = 24;
  r += 2;

  /* --- คำอธิบายสถานะ --- */
  sectionRow(ws, r, SPAN, 'คำอธิบายสถานะ'); r++;
  [['รอตรวจสอบ', 'ผู้แจ้งส่งข้อมูลเข้ามาแล้ว รอ Admin ตรวจสอบและอนุมัติ', 'submitted'],
   ['กำลังดำเนินการ', 'อนุมัติแล้ว อยู่ระหว่างแก้ไข / รออะไหล่ / รอช่าง', 'in_progress'],
   ['จบงาน', 'แก้ไขเสร็จ แนบรูป After และปิดงานเรียบร้อย', 'done'],
   ['ไม่อนุมัติ', 'Admin ตีกลับพร้อมเหตุผล', 'rejected']].forEach(([name, desc, key]) => {
    const row = ws.getRow(r);
    const c1 = row.getCell(1);
    c1.value = name;
    c1.font = { name: FONT, size: 10, bold: true, color: { argb: C[key] } };
    c1.fill = fill(CB[key]);
    c1.alignment = mid('center');
    c1.border = box();
    ws.mergeCells(r, 2, r, SPAN);
    const c2 = ws.getCell(r, 2);
    c2.value = desc;
    c2.font = { name: FONT, size: 10, color: { argb: GREY } };
    c2.alignment = mid('left', 1);
    c2.border = box();
    row.height = 20;
    r++;
  });

  /* ==================== SHEET 2 : รายการงาน ==================== */
  const wd = wb.addWorksheet('รายการงาน', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 6, showGridLines: false }],
    pageSetup: {
      paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      printTitlesRow: '6:6',
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
    }
  });
  wd.properties.tabColor = { argb: BLUE };
  wd.headerFooter.oddFooter = '&L&8 TENNECO Improvement — รายการงาน&C&8 หน้า &P / &N&R&8 &D';

  const HEAD = ['ลำดับ', 'รหัสงาน', 'วันที่แจ้ง', 'พื้นที่', 'เครื่องจักร', 'หัวข้อ',
    'รายละเอียดที่ต้องการแก้ไข', 'ผู้แจ้ง', 'สถานะ', 'ข้อความล่าสุดจาก Admin',
    'วันที่ปิดงาน', 'ระยะเวลา (วัน)', 'รูป BEFORE', 'รูป AFTER'];
  const WIDTH = [6, 14, 12, 10, 22, 30, 44, 16, 15, 34, 12, 11, 23, 23];

  titleBlock(wd, HEAD.length, '    รายการงาน IMPROVEMENT ทั้งหมด',
    '    TENNECO   |   ' + jobs.length + ' รายการ   |   ช่วงข้อมูล: ' + range + '   |   ออกรายงาน ' + stamp);
  wd.getRow(5).height = 6;
  headerRow(wd, 6, HEAD, WIDTH);
  wd.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: HEAD.length } };

  let rn = 7, no = 1;
  for (const j of jobs) {
    const lastAdmin = j.timeline.filter(t => t.role && t.role !== 'user').pop();
    const lead = j.closedAt ? A.daysBetween(j.createdAt, j.closedAt) : A.daysBetween(j.createdAt, new Date());
    const row = wd.getRow(rn);
    [no, j.code, A.fmtDate(j.createdAt), j.area, j.machine, j.title, j.detail, j.reporter,
      A.ST[j.status].label, lastAdmin ? lastAdmin.text : '—',
      j.closedAt ? A.fmtDate(j.closedAt) : '—', Number(lead.toFixed(1)), '', ''].forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v;
      c.border = box();
      c.alignment = mid([0, 1, 2, 3, 8, 10, 11].includes(i) ? 'center' : 'left',
        [4, 5, 6, 7, 9].includes(i) ? 1 : 0);
      c.font = { name: i === 4 ? MONO : FONT, size: 9.5, color: { argb: 'FF41556E' } };
      if (i === 0) c.font = { name: MONO, size: 9.5, color: { argb: GREY } };
      if (i === 1) c.font = { name: MONO, size: 10, bold: true, color: { argb: BLUE } };
      if (i === 3) c.font = { name: FONT, size: 10, bold: true, color: { argb: NAVY } };
      if (i === 5) c.font = { name: FONT, size: 9.5, bold: true, color: { argb: INK } };
      if (i === 11) c.font = { name: MONO, size: 10, color: { argb: 'FF41556E' } };
      if (i === 8) {
        c.fill = fill(CB[j.status]);
        c.font = { name: FONT, size: 9.5, bold: true, color: { argb: C[j.status] } };
      } else if ((rn - 7) % 2) {
        c.fill = fill(ZEBRA);
      }
    });
    row.height = 84;

    const put = (dataUrl, colIdx) => {
      if (!dataUrl) return;
      const b64 = String(dataUrl).split(',')[1] || dataUrl;
      const id = wb.addImage({ base64: b64, extension: 'jpeg' });
      wd.addImage(id, {
        tl: { col: colIdx + 0.1, row: rn - 1 + 0.07 },
        ext: { width: 140, height: 105 },
        editAs: 'oneCell'
      });
    };
    put(pic(j.before[0]), 12);
    put(pic(j.after[0]), 13);

    rn++; no++;
  }

  if (!jobs.length) {
    wd.mergeCells(7, 1, 7, HEAD.length);
    const c = wd.getCell(7, 1);
    c.value = 'ไม่มีข้อมูลในช่วงที่เลือก';
    c.alignment = mid('center');
    c.font = { name: FONT, size: 11, color: { argb: GREY } };
    wd.getRow(7).height = 40;
  }

  /* ============= SHEET 3 : เปรียบเทียบ Before / After ============= */
  const done = jobs.filter(j => j.status === 'done' && pic(j.after[0]) && pic(j.before[0]));
  const wc = wb.addWorksheet('เปรียบเทียบ Before-After', {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
    }
  });
  wc.properties.tabColor = { argb: 'FF0E9F6E' };
  wc.headerFooter.oddFooter = '&L&8 TENNECO Improvement — Before / After&C&8 หน้า &P / &N';

  for (let i = 1; i <= 6; i++) wc.getColumn(i).width = 16;
  titleBlock(wc, 6, '    ผลงานปรับปรุง : เปรียบเทียบก่อน – หลัง',
    '    TENNECO   |   งานที่ปิดแล้ว ' + done.length + ' รายการ   |   ออกรายงาน ' + stamp);

  let cr = 5;
  done.forEach(j => {
    wc.mergeCells(cr, 1, cr, 6);
    const h = wc.getCell(cr, 1);
    h.value = j.code + '    ' + j.title;
    h.font = { name: FONT, size: 12, bold: true, color: { argb: WHITE } };
    h.fill = fill(NAVY);
    h.alignment = mid('left', 1);
    wc.getRow(cr).height = 26;
    cr++;

    wc.mergeCells(cr, 1, cr, 3);
    wc.mergeCells(cr, 4, cr, 6);
    const i1 = wc.getCell(cr, 1), i2 = wc.getCell(cr, 4);
    i1.value = 'พื้นที่ ' + j.area + '   |   เครื่องจักร ' + j.machine;
    i2.value = 'ผู้แจ้ง ' + j.reporter + '   |   แจ้ง ' + A.fmtDate(j.createdAt) +
      '   |   ปิด ' + A.fmtDate(j.closedAt) +
      '   |   ใช้เวลา ' + A.daysBetween(j.createdAt, j.closedAt).toFixed(1) + ' วัน';
    [i1, i2].forEach(c => {
      c.font = { name: FONT, size: 9.5, color: { argb: GREY } };
      c.fill = fill(BLUE_L);
      c.alignment = mid('left', 1);
      c.border = { bottom: thin() };
    });
    wc.getRow(cr).height = 20;
    cr++;

    wc.mergeCells(cr, 1, cr, 3);
    wc.mergeCells(cr, 4, cr, 6);
    const bf = wc.getCell(cr, 1), af = wc.getCell(cr, 4);
    bf.value = 'BEFORE — ก่อนแก้ไข';
    af.value = 'AFTER — หลังแก้ไข';
    bf.font = { name: FONT, size: 10, bold: true, color: { argb: WHITE } };
    af.font = { name: FONT, size: 10, bold: true, color: { argb: WHITE } };
    bf.fill = fill(NAVY_D);
    af.fill = fill('FF0E9F6E');
    bf.alignment = mid('center');
    af.alignment = mid('center');
    wc.getRow(cr).height = 20;
    cr++;

    const imgTop = cr;
    for (let k = 0; k < 4; k++) {
      const rw = wc.getRow(cr + k);
      rw.height = 46;
      for (let col = 1; col <= 6; col++) {
        const c = rw.getCell(col);
        c.fill = fill('FFF4F7FB');
        const bd = {};
        if (col === 1 || col === 4) bd.left = thin(LINE);
        if (col === 3 || col === 6) bd.right = thin(LINE);
        if (k === 3) bd.bottom = thin(LINE);
        c.border = bd;
      }
    }
    const place = (dataUrl, colIdx) => {
      if (!dataUrl) return;
      const b64 = String(dataUrl).split(',')[1] || dataUrl;
      const id = wb.addImage({ base64: b64, extension: 'jpeg' });
      wc.addImage(id, {
        tl: { col: colIdx + 0.06, row: imgTop - 1 + 0.06 },
        ext: { width: 320, height: 232 },
        editAs: 'oneCell'
      });
    };
    place(pic(j.before[0]), 0);
    place(pic(j.after[0]), 3);
    cr += 4;

    wc.getRow(cr).height = 14;   // ช่องไฟระหว่างงาน
    cr++;
  });

  if (!done.length) {
    wc.mergeCells(5, 1, 5, 6);
    const c = wc.getCell(5, 1);
    c.value = 'ยังไม่มีงานที่ปิดพร้อมรูป After';
    c.alignment = mid('center');
    c.font = { name: FONT, size: 11, color: { argb: GREY } };
    wc.getRow(5).height = 40;
  }

  return wb;
}

/* =====================================================================
   DOWNLOAD
   ===================================================================== */
async function run() {
  const btn = document.getElementById('btn-export');
  if (typeof ExcelJS === 'undefined') {
    window.App.toast('โหลดไลบรารี Excel ไม่สำเร็จ — ต้องต่ออินเทอร์เน็ตครั้งแรก');
    return;
  }
  const label = btn.querySelector('.ex-main');
  const old = label.textContent;
  btn.classList.add('busy');
  label.textContent = 'กำลังสร้างไฟล์ Excel...';
  try {
    const wb = await buildWorkbook();
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const d = new Date();
    const name = 'Improvement_Report_' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '.xlsx';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    window.App.toast('ดาวน์โหลด ' + name + ' แล้ว');
  } catch (e) {
    console.error(e);
    window.App.toast('สร้างไฟล์ไม่สำเร็จ: ' + e.message);
  } finally {
    btn.classList.remove('busy');
    label.textContent = old;
  }
}

window.buildReportWorkbook = buildWorkbook;   // เผื่อเรียกใช้/ทดสอบจากภายนอก

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-export').addEventListener('click', run);
});
})();
