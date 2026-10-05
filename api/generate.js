// api/generate.js — Vercel Serverless Function: AI Motion Director (Gemini)
// Kunci API disimpan di Environment Variable Vercel (GEMINI_API_KEY), bukan di index.html.
const SYS = 'Kamu animator motion-graphics kelas dunia. Tulis HANYA kode JavaScript (tanpa markdown, tanpa penjelasan). Definisikan const parameter lalu function draw(t,ctx,W,H,D) yang menggambar SELURUH frame dari waktu t (detik) — murni fungsi waktu: tanpa state, tanpa requestAnimationFrame, tanpa Math.random (pakai M.h(n)). Toolkit global M: M.clamp(x,a,b), M.lerp, M.h(n) acak deterministik 0..1, M.e.out/in/inOut/expo/back(x 0..1), M.spring(t,w,z) naik 0→1 dengan overshoot, M.a(hex,alpha) hex #rrggbb ke rgba, M.rr(ctx,x,y,w,h,r) path rounded-rect, M.letters(ctx,str,cx,cy,t,t0,gap) teks kinetik (atur ctx.font & fillStyle dulu). Gerak harus seperti animator manusia: anticipation, overshoot lalu settle, follow-through, stagger antar elemen, arc, slow-in/slow-out, secondary motion, parallax berlapis, kamera push-in/drift halus, cahaya/bayangan/glow, timing tidak seragam, tidak ada gerak linear kaku. Susun intro, aksi utama, dan outro yang memakai seluruh durasi D. Pakai warna hex.';
const PATCH = 'Kamu editor kode presisi. Berdasarkan KODE dan PERMINTAAN, kembalikan HANYA JSON array perubahan minimal: [{"find":"potongan kode persis dari KODE yang muncul tepat sekali","replace":"penggantinya"}]. Ubah sesedikit mungkin, jangan sentuh bagian lain, jangan ubah nama atau struktur. Untuk menambah elemen baru, sisipkan lewat find+replace yang tetap memuat teks find di dalam replace.';
const hits = new Map(); // pembatas sederhana per IP (best-effort di serverless)

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST' });
  const key = process.env.GEMINI_API_KEY;
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

  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: Object.assign(
          { maxOutputTokens: 16384 },
          process.env.GEMINI_THINKING ? { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING } } : {},
          mode === 'patch' ? { responseMimeType: 'application/json' } : {}
        ),
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: (j.error && j.error.message) || ('Gemini ' + r.status) });
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const text = parts.map((p) => p.text || '').join('').trim();
    if (!text) return res.status(502).json({ error: 'Model tidak mengembalikan hasil' });
    if (mode === 'patch') {
      try { return res.status(200).json({ patches: JSON.parse(text) }); }
      catch { return res.status(502).json({ error: 'Format patch tidak valid' }); }
    }
    return res.status(200).json({ code: text.replace(/```[a-zA-Z]*\n?/g, '').trim() });
  } catch (e) {
    return res.status(502).json({ error: 'Gagal menghubungi Gemini' });
  }
};
