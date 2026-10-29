// Real conversational flow in the Amy UI: tap the kiosk, type a
// question and confirm the DeepSeek answer is rendered on
// screen (not just that the endpoint responds).
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

// The kiosk starts on the attract screen (#sleep, with the LET'S TALK button).
// Real flow: LET'S TALK -> #wake (greeting) -> conversation (#speaking).
const startsOnSleep = await page.evaluate(() =>
  document.getElementById('sleep')?.classList.contains('active') ?? false);
check('Starts on the attract screen (#sleep)', startsOnSleep);

await page.locator('.wake-btn button').click();
await page.waitForTimeout(1500);
const onWake = await page.evaluate(() =>
  document.getElementById('wake')?.classList.contains('active') ?? false);
check("LET'S TALK opens the greeting screen (#wake)", onWake);

// One more tap moves into the conversation.
await page.locator('#wake').click({ force: true });
await page.waitForTimeout(2500);

const speakingActive = await page.evaluate(() =>
  document.getElementById('speaking')?.classList.contains('active') ?? false);
check('Tap opens the conversation screen', speakingActive);

// The text input is hidden by default; reveal it programmatically.
const shown = await page.evaluate(() => {
  const el = document.getElementById('textInputOverlay');
  if (!el) return false;
  el.style.display = 'block';
  return true;
});
check('Text input overlay available', shown);

// Ask through the UI, not just the API.
const QUESTION = 'What is the divorce process in Panama?';
await page.fill('#textInputField', QUESTION);
await page.evaluate(() => document.getElementById('textInputField')
  .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));

// Wait for the backend answer (DeepSeek takes a few seconds).
let answered = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const bubbles = await page.evaluate(() =>
    [...document.querySelectorAll('#chatMessages .chat-bubble')].map((b) => b.innerText.trim()));
  const last = bubbles[bubbles.length - 1] || '';
  if (last.length > 60 && /divorce|mutual consent|contentious/i.test(last)) { answered = true; break; }
}

const finalBubbles = await page.evaluate(() =>
  [...document.querySelectorAll('#chatMessages .chat-bubble')].map((b) => b.innerText.trim()));
check('Visitor question appears in the chat',
  finalBubbles.some((b) => /divorce/i.test(b)));
check('DeepSeek answer appears on screen', answered,
  (finalBubbles[finalBubbles.length - 1] || '').slice(0, 120));

check('No console errors during the flow', errors.length === 0, errors.slice(0, 3).join(' | '));

await page.screenshot({ path: '/tmp/amy_chat.png' });
console.log(`\n=== ${failures === 0 ? 'TODO OK' : failures + ' FALLOS'} ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
