/* =========================================================
   PHOTO BOOTH ✦ 저장소 연결 (backend.js)
   - config.js에 Apps Script 주소가 있으면 → 선생님 구글 드라이브에 저장 (실제 운영)
   - 주소가 없으면 → '부스 모드' : 이 기기(브라우저) 안에 저장 → 같은 기기 선생님 모드에서 인쇄
   ========================================================= */
const SCRIPT_URL = String(window.PHOTOBOOTH_CONFIG?.APPS_SCRIPT_URL || '').trim();
export const MODE = /^https:\/\/script\.google\.com\/.+\/exec$/.test(SCRIPT_URL) ? 'remote' : 'local';
export const TEST_PASSWORD = String(window.PHOTOBOOTH_CONFIG?.BOOTH_PASSWORD || '0000');
const CODE_DAYS = 3;

function fail(code) { const e = new Error(code); e.code = code; return e; }
const blobToDataURL = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });

/* ---------- 1. 실제 운영: Google Apps Script ---------- */
async function call(action, data = {}) {
  let res;
  try {
    res = await fetch(SCRIPT_URL, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 이 형식이어야 브라우저가 바로 보낼 수 있어요
      body: JSON.stringify({ action, ...data })
    });
  } catch (e) { throw fail('NETWORK'); }
  if (!res.ok) throw fail('NETWORK');
  let j; try { j = await res.json(); } catch (e) { throw fail('SERVER'); }
  if (!j.ok) throw fail(j.error || 'SERVER');
  return j;
}
const remote = {
  checkCode: code => call('checkCode', { code }),
  upload: async ({ code, blob, layout, style }) => call('upload', { code, layout, style, image: await blobToDataURL(blob) }),
  login: pw => call('login', { password: pw }),
  createCode: pw => call('createCode', { password: pw }),
  endCode: pw => call('endCode', { password: pw }),
  async list(pw) {
    const j = await call('list', { password: pw });
    j.items.forEach(it => {
      it.thumb = `https://drive.google.com/thumbnail?id=${encodeURIComponent(it.id)}&sz=w800`;
      it.full = `https://drive.google.com/thumbnail?id=${encodeURIComponent(it.id)}&sz=w2400`;
      it.download = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(it.id)}`;
      it.open = `https://drive.google.com/file/d/${encodeURIComponent(it.id)}/view`;
    });
    return j;
  },
  setPrinted: (pw, id, printed) => call('setPrinted', { password: pw, id, printed })
};

/* ---------- 2. 부스 모드: 이 기기 안에 저장 (IndexedDB) ---------- */
const mem = { active: null, photos: new Map() };      // IndexedDB를 못 쓰는 환경용 예비 저장소
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return mem[k] ?? null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { mem[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { delete mem[k]; } }
};
let dbP = null;
function openDB() {
  if (!dbP) dbP = new Promise(res => {
    try {
      const r = indexedDB.open('photobooth-test', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    } catch (e) { res(null); }
  });
  return dbP;
}
const store = {
  async put(p) {
    const db = await openDB(); if (!db) { mem.photos.set(p.id, p); return; }
    await new Promise((res, rej) => { const t = db.transaction('photos', 'readwrite'); t.objectStore('photos').put(p); t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async all() {
    const db = await openDB(); if (!db) return [...mem.photos.values()];
    return new Promise((res, rej) => { const r = db.transaction('photos').objectStore('photos').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
};
const urlCache = new Map();
const localActive = () => { const a = ls.get('pb_test_active'); return a && Date.now() < a.expiresAt ? a : null; };
const checkPw = pw => { if (pw !== TEST_PASSWORD) throw fail('WRONG_PASSWORD'); };
const local = {
  async checkCode(code) { const a = localActive(); if (!a || a.code !== String(code)) throw fail('BAD_CODE'); return { ok: true, expiresAt: a.expiresAt }; },
  async upload({ code, blob, layout, style }) {
    await local.checkCode(code);
    const id = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
    await store.put({ id, blob, created: Date.now(), code: String(code), layout, style, printed: false });
    return { ok: true, id };
  },
  async login(pw) { checkPw(pw); return { ok: true, active: localActive() }; },
  async createCode(pw) {
    checkPw(pw);
    const a = { code: String(Math.floor(1000 + Math.random() * 9000)), createdAt: Date.now(), expiresAt: Date.now() + CODE_DAYS * 864e5 };
    ls.set('pb_test_active', a); return { ok: true, active: a };
  },
  async endCode(pw) { checkPw(pw); ls.del('pb_test_active'); return { ok: true }; },
  async list(pw) {
    checkPw(pw);
    const items = (await store.all()).sort((a, b) => b.created - a.created).map(p => {
      if (!urlCache.has(p.id)) urlCache.set(p.id, URL.createObjectURL(p.blob));
      const u = urlCache.get(p.id);
      return { id: p.id, created: p.created, code: p.code, layout: p.layout, style: p.style, printed: p.printed, thumb: u, full: u, download: u, open: u, local: true };
    });
    return { ok: true, active: localActive(), items };
  },
  async setPrinted(pw, id, printed) {
    checkPw(pw);
    const p = (await store.all()).find(x => x.id === id); if (!p) throw fail('NOT_FOUND');
    p.printed = !!printed; await store.put(p); return { ok: true };
  }
};

export const backend = MODE === 'remote' ? remote : local;

/* 오류 코드를 학생/선생님이 이해할 수 있는 문장으로 */
export function errorText(err) {
  switch (err && err.code) {
    case 'BAD_CODE': return '코드가 맞지 않거나 사용 기간이 끝났어요. 선생님께 다시 확인해 주세요.';
    case 'WRONG_PASSWORD': return '비밀번호가 맞지 않아요.';
    case 'NETWORK': return '인터넷 연결을 확인해 주세요. (와이파이)';
    case 'BAD_IMAGE': return '사진 파일에 문제가 있어요. 다시 시도해 주세요.';
    default: return '잠시 문제가 생겼어요. 다시 시도해 주세요.';
  }
}
