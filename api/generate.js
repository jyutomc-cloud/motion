// api/generate.js — Vercel Serverless Function: AI Motion Director (Gemini)
// Kunci API disimpan di Environment Variable Vercel (GEMINI_API_KEY), bukan di index.html.
const SYS = 'Kamu animator motion-graphics kelas dunia. Tulis HANYA kode JavaScript (tanpa markdown, tanpa penjelasan). Definisikan const parameter lalu function draw(t,ctx,W,H,D) yang menggambar SELURUH frame dari waktu t (detik) — murni fungsi waktu: tanpa state, tanpa requestAnimationFrame, tanpa Math.random (pakai M.h(n)). Toolkit global M: M.clamp(x,a,b), M.lerp, M.h(n) acak deterministik 0..1, M.e.out/in/inOut/expo/back(x 0..1), M.spring(t,w,z) naik 0→1 dengan overshoot, M.a(hex,alpha) hex #rrggbb ke rgba, M.rr(ctx,x,y,w,h,r) path rounded-rect, M.letters(ctx,str,cx,cy,t,t0,gap) teks kinetik (atur ctx.font & fillStyle dulu). Gerak harus seperti animator manusia: anticipation, overshoot lalu settle, follow-through, stagger antar elemen, arc, slow-in/slow-out, secondary motion, parallax berlapis, kamera push-in/drift halus, cahaya/bayangan/glow, timing tidak seragam, tidak ada gerak linear kaku. Susun intro, aksi utama, dan outro yang memakai seluruh durasi D. Pakai warna hex.';
const PATCH = 'Kamu editor kode presisi. Berdasarkan KODE dan PERMINTAAN, kembalikan HANYA JSON array perubahan minimal: [{"find":"potongan kode persis dari KODE yang muncul tepat sekali","replace":"penggantinya"}]. Ubah sesedikit mungkin, jangan sentuh bagian lain, jangan ubah nama atau struktur. Untuk menambah elemen baru, sisipkan lewat find+replace yang tetap memuat teks find di dalam replace.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const why = (e) => String((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || e).slice(0, 60);
const hits = new Map(); // pembatas sederhana per IP (best-effort di serverless)

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST' });
  // rapikan key: buang spasi, baris baru, dan tanda kutip hasil copy-paste
  const key = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY belum diisi di Vercel (Settings > Environment Variables)' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= 12) return res.status(429).json({ error: 'Terlalu banyak permintaan, coba lagi sebentar' });
  recent.push(now); hits.set(ip, recent);

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  const { mode, brief = '', code = '', ctx = '', err = '' } = b || {};
  if (!['new', 'rewrite', 'patch'].includes(mode) || !String(brief).trim() || brief.length > 2000 ||
      code.length > 40000 || ctx.length > 500 || err.length > 1000) {
    return res.status(400).json({ error: 'Permintaan tidak valid' });
  }

  const system = mode === 'patch' ? PATCH : SYS;
  const user = mode === 'patch'
    ? 'KODE:\n' + code + '\n\nPERMINTAAN: ' + brief
    : (mode === 'rewrite'
        ? 'KODE SAAT INI:\n' + code + '\n\nPERMINTAAN (ubah HANYA yang disebut; semua nilai, nama, dan timing lain harus sama persis; keluarkan kode lengkap): ' + brief
        : 'BRIEF: ' + brief) + '\n' + ctx + (err ? '\n\nPERCOBAAN SEBELUMNYA ERROR: ' + err + '. Perbaiki.' : '');

  const THINK = process.env.GEMINI_THINKING === undefined ? 'low' : process.env.GEMINI_THINKING.trim();
  const HEDGE = +process.env.GEMINI_HEDGE_MS || 12000;        // model belum menjawab sebanyak ini -> jalankan model berikutnya juga
  const BUDGET = +process.env.GEMINI_BUDGET_MS || 54000;      // total waktu (maxDuration fungsi = 60 dtk)
  const MIN_START = +process.env.GEMINI_MINSTART_MS || 12000; // jangan mulai percobaan baru bila sisa waktu lebih sedikit
  const GAP = +process.env.GEMINI_GAP_MS || 5000;             // jeda sebelum putaran kedua

  const primary = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const fallbacks = (process.env.GEMINI_FALLBACK || 'gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',').map((m) => m.trim()).filter(Boolean);
  const models = [...new Set([primary, ...fallbacks])];
  const noThink = new Set(THINK && !/^(off|default|none)$/i.test(THINK) ? [] : models);
  const dead = new Set();
  const fails = [];
  const short = (m) => m.replace(/^gemini-/, '');
  const deadline = Date.now() + BUDGET;
  let fatal = null;
  let abortWhy = '';

  const bodyFor = (m) => JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: Object.assign(
      { maxOutputTokens: 16384 },
      noThink.has(m) ? {} : { thinkingConfig: { thinkingLevel: THINK } },
      mode === 'patch' ? { responseMimeType: 'application/json' } : {}
    ),
  });

  // Satu percobaan ke satu model. Hasil: { out } bila sukses, { fatal } bila key/izin bermasalah, null bila gagal.
  const run = async (m, signal) => {
    for (let k = 0; k < 2; k++) { // percobaan ke-2 hanya bila model menolak pengaturan thinking
      if (signal.aborted) return null;
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal.addEventListener('abort', onAbort);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, Math.max(deadline - Date.now(), 1));
      try {
        const r = await fetch(API + encodeURIComponent(m) + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: bodyFor(m),
          signal: ac.signal,
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
          const text = parts.map((p) => p.text || '').join('').trim();
          if (!text) { fails.push({ m, status: 0, msg: 'respons kosong' }); return null; }
          if (mode === 'patch') {
            try { return { out: { patches: JSON.parse(text) } }; }
            catch { fails.push({ m, status: 0, msg: 'patch tidak valid' }); return null; }
          }
          return { out: { code: text.replace(/```[a-zA-Z]*\n?/g, '').trim() } };
        }
        const msg = (j.error && j.error.message) || ('Gemini ' + r.status);
        if (r.status === 400 && /thinking/i.test(msg) && !noThink.has(m)) { noThink.add(m); continue; }
        fails.push({ m, status: r.status, msg });
        if (r.status === 401 || r.status === 403 || (r.status === 400 && /api key|api_key/i.test(msg))) { fatal = { msg }; return { fatal: true }; }
        if (r.status === 404 || r.status === 400) dead.add(m); // model tidak tersedia / tidak cocok: lewati
        return null;
      } catch (e) {
        if (signal.aborted && !timedOut) { if (abortWhy === 'timeout') fails.push({ m, status: 0, msg: 'timeout' }); return null; }
        fails.push({ m, status: 0, msg: timedOut ? 'timeout' : why(e) });
        return null;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    }
    return null;
  };

  // Jalankan model berurutan; bila satu gagal langsung lanjut, bila lambat jalankan berikutnya bersamaan. Yang pertama sukses menang.
  const race = (list, budgetMs) => new Promise((resolve) => {
    const all = new AbortController();
    let next = 0, running = 0, done = false, hedge = null;
    const budgetTimer = setTimeout(() => finish(null, 'timeout'), budgetMs);
    function finish(v, w) {
      if (done) return;
      done = true; abortWhy = w || '';
      clearTimeout(hedge); clearTimeout(budgetTimer);
      all.abort(); resolve(v);
    }
    function arm() { clearTimeout(hedge); if (!done && next < list.length) hedge = setTimeout(launch, HEDGE); }
    function launch() {
      if (done || next >= list.length) return;
      if (deadline - Date.now() < MIN_START) { if (running === 0) finish(null); return; }
      const m = list[next++]; running++;
      run(m, all.signal).then((r) => {
        if (r && r.out) finish(r.out);
        else if (r && r.fatal) finish(null);
      }).finally(() => {
        running--;
        if (done) return;
        if (next < list.length) launch(); else if (running === 0) finish(null);
      });
      arm();
    }
    launch();
  });

  let out = null;
  for (let round = 0; round < 2 && !out && !fatal; round++) {
    const live = (round ? models.slice(0, 3) : models).filter((m) => !dead.has(m));
    if (!live.length) break;
    if (round) { if (deadline - Date.now() < GAP + MIN_START) break; await sleep(GAP); }
    out = await race(live, Math.max(deadline - Date.now(), 1));
  }
  if (out) return res.status(200).json(out);

  const trail = fails.map((f) => short(f.m) + ': ' + (f.status || f.msg)).join(', ');
  console.error('[gemini] gagal:', trail);
  if (fatal) return res.status(502).json({ error: fatal.msg });
  if (fails.some((f) => f.status === 503 || /high demand|overloaded/i.test(f.msg))) {
    return res.status(503).json({ error: 'Server AI sedang ramai. Coba lagi beberapa detik lagi. [' + trail + ']' });
  }
  const q = fails.find((f) => f.status === 429);
  if (q) return res.status(429).json({ error: q.msg });
  const real = fails.find((f) => f.status);
  return res.status(502).json({ error: (real ? real.msg : 'Gagal menghubungi Gemini') + (trail ? ' [' + trail + ']' : '') });
};
