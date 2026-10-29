// Flujo conversacional REAL en la UI de Amy: tocar el kiosco, escribir una
// pregunta en español y confirmar que la respuesta de DeepSeek aparece en
// pantalla (no solo que el endpoint responda).
import { chromium } from 'playwright';

const URL = 'https://ricardochen.github.io/amy-demo/';
let failures = 0;
const errors = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

// El kiosco arranca en la pantalla de atracción (#sleep, con el botón LET'S TALK).
// El flujo real es: LET'S TALK → #wake (saludo) → conversación (#speaking).
const startsOnSleep = await page.evaluate(() =>
  document.getElementById('sleep')?.classList.contains('active') ?? false);
check('Arranca en pantalla de atracción (#sleep)', startsOnSleep);

await page.locator('.wake-btn button').click();
await page.waitForTimeout(1500);
const onWake = await page.evaluate(() =>
  document.getElementById('wake')?.classList.contains('active') ?? false);
check("LET'S TALK entra a la pantalla de saludo (#wake)", onWake);

// Un toque más lleva a la conversación.
await page.locator('#wake').click({ force: true });
await page.waitForTimeout(2500);

const speakingActive = await page.evaluate(() =>
  document.getElementById('speaking')?.classList.contains('active') ?? false);
check('El toque entra a la pantalla de conversación', speakingActive);

// El input de texto está oculto por defecto; se muestra con el botón de teclado.
const shown = await page.evaluate(() => {
  const el = document.getElementById('textInputOverlay');
  if (!el) return false;
  el.style.display = 'block';
  return true;
});
check('Overlay de texto disponible', shown);

// Preguntar lo mismo que en el smoke de API, pero por la UI.
const QUESTION = '¿Qué es el proceso de divorcio?';
await page.fill('#textInputField', QUESTION);
await page.evaluate(() => document.getElementById('textInputField')
  .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));

// Esperar la respuesta del backend (DeepSeek tarda unos segundos).
let answered = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const bubbles = await page.evaluate(() =>
    [...document.querySelectorAll('#chatMessages .chat-bubble')].map((b) => b.innerText.trim()));
  const last = bubbles[bubbles.length - 1] || '';
  if (last.length > 60 && /divorcio|divorce|mutuo|contencioso/i.test(last)) { answered = true; break; }
}

const finalBubbles = await page.evaluate(() =>
  [...document.querySelectorAll('#chatMessages .chat-bubble')].map((b) => b.innerText.trim()));
check('La pregunta del visitante aparece en el chat',
  finalBubbles.some((b) => b.includes('divorcio')));
check('La respuesta de DeepSeek aparece en pantalla', answered,
  (finalBubbles[finalBubbles.length - 1] || '').slice(0, 120));

check('Sin errores de consola en el flujo', errors.length === 0, errors.slice(0, 3).join(' | '));

await page.screenshot({ path: '/tmp/amy_chat.png' });
console.log(`\n=== ${failures === 0 ? 'TODO OK' : failures + ' FALLOS'} ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
