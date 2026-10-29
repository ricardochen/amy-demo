// Smoke E2E REAL de la demo Amy en GitHub Pages.
// Verifica: (1) la página carga sin errores de consola, (2) el kiosco se ve,
// (3) el micro / la UI responden, (4) el backend real contesta por texto,
// (5) el TTS devuelve audio reproducible.
import { chromium } from 'playwright';

const URL = 'https://ricardochen.github.io/amy-demo/';
const BACKEND = 'https://xwvaegliifpggqlmxxhu.supabase.co/functions/v1/amy-api';

const errors = [];
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1080, height: 1920 },
  permissions: ['microphone'],
  locale: 'es-PA',
});
const page = await ctx.newPage();

page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

// 1. Carga
check('Page loads (title contains Amy)', (await page.title()).includes('Amy'), await page.title());

// 2. Kiosco visible
const wake = await page.locator('#wake').count();
check('Kiosk root (#wake) exists', wake > 0);

// 3. Backend URL inyectada correctamente
const backendUrl = await page.evaluate(() => window.AMY_BACKEND_URL || null);
check('AMY_BACKEND_URL points at the edge', backendUrl === BACKEND, backendUrl);

// 4. Las imágenes de fondo cargan (404 daría un kiosco negro)
// OJO: las urls viven en un <style> inline y son RELATIVAS, así que hay que
// leer el HTML crudo y resolverlas contra el origen. (La primera versión de
// este chequeo solo miraba document.styleSheets y daba "0 revisadas" = test ciego.)
const imgOk = await page.evaluate(async () => {
  const html = document.documentElement.innerHTML;
  const rel = [...html.matchAll(/url\(['"]?([^'")]+\.(?:webp|png|jpg|jpeg))['"]?\)/g)].map((m) => m[1]);
  const imgs = [...document.querySelectorAll('img')].map((i) => i.src);
  const abs = [...new Set([...rel.map((u) => new URL(u, location.href).href), ...imgs])]
    .filter((u) => !u.startsWith('data:'));
  const results = await Promise.all(
    abs.map((u) =>
      fetch(u, { method: 'GET' })
        .then((r) => ({ u, ok: r.status === 200, type: r.headers.get('content-type') || '' }))
        .catch(() => ({ u, ok: false, type: '' })),
    ),
  );
  return { total: abs.length, bad: results.filter((r) => !r.ok || !r.type.startsWith('image')) };
});
check(`Background images load (${imgOk.total} checked)`, imgOk.total > 0 && imgOk.bad.length === 0,
  imgOk.total === 0 ? 'BLIND TEST: no images found' : (imgOk.bad.length ? JSON.stringify(imgOk.bad) : ''));

// 5. Backend real: /health
const health = await page.evaluate(async (B) => {
  const r = await fetch(B + '/health');
  return { status: r.status, body: await r.json() };
}, BACKEND);
check('/health 200 and kb_size > 0', health.status === 200 && health.body.kb_size > 0,
  `kb_size=${health.body.kb_size}`);

// 6. English-only: no language toggle, no Spanish text visible
const langBtn = await page.locator('#langToggle').count();
check('No language toggle present (English-only)', langBtn === 0, `${langBtn} found`);

const spanishText = await page.evaluate(() => {
  // Only inspect TEXT NODES THAT RENDER. A TreeWalker over body also walks into
  // <script> and <style>, which would flag source code the user never sees.
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let p = node.parentElement; p; p = p.parentElement) {
        if (SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const hits = [];
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent.trim();
    if (!t) continue;
    if (/[áéíóúñ¿¡]/i.test(t) || /\b(años|Asesoría|Español|Gracias|Bienvenido|Toca para)\b/i.test(t)) {
      hits.push(t.slice(0, 60));
    }
  }
  return hits;
});
check('No Spanish text rendered on screen', spanishText.length === 0,
  spanishText.slice(0, 3).join(' | '));

// 7. Backend real: /query answers in English even for a Spanish question
const q = await page.evaluate(async (B) => {
  const r = await fetch(B + '/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '¿Qué es el proceso de divorcio?', language: 'es' }),
  });
  return { status: r.status, body: await r.json() };
}, BACKEND);
check('/query responds 200', q.status === 200, `HTTP ${q.status}`);
check('/query returns a non-empty answer', (q.body.answer || '').length > 40);
check('/query force-answers in English for a Spanish question',
  q.body.language === 'en' && !/\b(el proceso|la respuesta|no tengo esa información)\b/i.test(q.body.answer || ''),
  `language=${q.body.language}`);
check('/query in English retrieves divorce context',
  (q.body.context_sources || []).some((s) => /divorce|divorcio/i.test(s)),
  (q.body.context_sources || [])[0] || '');

// 7b. Verbosity guard: a voice kiosk must stay short and ask to go deeper.
// Regression guard — the first version of Amy answered 66-100 words per turn,
// which is ~40 seconds of speech and drowns the visitor.
const brief = await page.evaluate(async (B) => {
  const qs = [
    'What services do you offer?',
    'What payment methods do you accept?',
    'How do I get residency in Panama?',
  ];
  const out = [];
  for (const question of qs) {
    const r = await fetch(B + '/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, language: 'en' }),
    });
    const d = await r.json();
    out.push({
      question,
      words: (d.answer || '').split(/\s+/).filter(Boolean).length,
      asksBack: (d.answer || '').includes('?'),
    });
  }
  return out;
}, BACKEND);
const longest = Math.max(...brief.map((b) => b.words));
check('Answers stay short (<=45 words)', longest <= 45,
  brief.map((b) => `${b.words}w`).join(', '));
check('Most answers end with a question to go deeper',
  brief.filter((b) => b.asksBack).length >= 2,
  brief.map((b) => (b.asksBack ? 'asks' : 'no-question')).join(', '));

// 8. TTS real: audio reproducible
const tts = await page.evaluate(async (B) => {
  const r = await fetch(B + '/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Bienvenido a Kraemer y Kraemer.', language: 'es' }),
  });
  const blob = await r.blob();
  return { status: r.status, type: r.headers.get('content-type'), size: blob.size };
}, BACKEND);
check('/tts returns audio/mpeg', tts.status === 200 && tts.type === 'audio/mpeg',
  `${tts.size} bytes`);

// 9. La UI de voz existe (micrófono presente)
const mic = await page.locator('#micButton').count();
check('Microphone button present', mic > 0);

// 10. Sin errores de consola
check('No console errors', errors.length === 0, errors.slice(0, 5).join(' | '));

await page.screenshot({ path: '/tmp/amy_pages.png', fullPage: false });
console.log('\nScreenshot: /tmp/amy_pages.png');
console.log(`\n=== ${failures === 0 ? 'TODO OK' : failures + ' FALLOS'} ===`);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
