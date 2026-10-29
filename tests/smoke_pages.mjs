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
check('Página carga (title contiene Amy)', (await page.title()).includes('Amy'), await page.title());

// 2. Kiosco visible
const wake = await page.locator('#wake').count();
check('Pantalla de reposo (#wake) existe', wake > 0);

// 3. Backend URL inyectada correctamente
const backendUrl = await page.evaluate(() => window.AMY_BACKEND_URL || null);
check('AMY_BACKEND_URL apunta al edge', backendUrl === BACKEND, backendUrl);

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
check(`Imágenes de fondo cargan (${imgOk.total} revisadas)`, imgOk.total > 0 && imgOk.bad.length === 0,
  imgOk.total === 0 ? 'TEST CIEGO: no se encontró ninguna imagen' : (imgOk.bad.length ? JSON.stringify(imgOk.bad) : ''));

// 5. Backend real: /health
const health = await page.evaluate(async (B) => {
  const r = await fetch(B + '/health');
  return { status: r.status, body: await r.json() };
}, BACKEND);
check('/health 200 y kb_size > 0', health.status === 200 && health.body.kb_size > 0,
  `kb_size=${health.body.kb_size}`);

// 6. Backend real: /query en español (el caso que estaba roto)
const q = await page.evaluate(async (B) => {
  const r = await fetch(B + '/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '¿Qué es el proceso de divorcio?', language: 'es' }),
  });
  return { status: r.status, body: await r.json() };
}, BACKEND);
check('/query responde 200', q.status === 200, `HTTP ${q.status}`);
check('/query devuelve respuesta no vacía', (q.body.answer || '').length > 40);
check('/query en español recupera contexto de divorcio',
  (q.body.context_sources || []).some((s) => /divorce|divorcio/i.test(s)),
  (q.body.context_sources || [])[0] || '');

// 7. TTS real: audio reproducible
const tts = await page.evaluate(async (B) => {
  const r = await fetch(B + '/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Bienvenido a Kraemer y Kraemer.', language: 'es' }),
  });
  const blob = await r.blob();
  return { status: r.status, type: r.headers.get('content-type'), size: blob.size };
}, BACKEND);
check('/tts devuelve audio/mpeg', tts.status === 200 && tts.type === 'audio/mpeg',
  `${tts.size} bytes`);

// 8. La UI de voz existe (micrófono presente)
const mic = await page.locator('#micButton').count();
check('Botón de micrófono presente', mic > 0);

// 9. Sin errores de consola
check('Sin errores de consola', errors.length === 0, errors.slice(0, 5).join(' | '));

await page.screenshot({ path: '/tmp/amy_pages.png', fullPage: false });
console.log('\nScreenshot: /tmp/amy_pages.png');
console.log(`\n=== ${failures === 0 ? 'TODO OK' : failures + ' FALLOS'} ===`);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
