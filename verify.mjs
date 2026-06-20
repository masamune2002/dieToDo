import puppeteer from 'puppeteer-core';

const exe = '/usr/bin/chromium';

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  args: ['--no-sandbox', '--headless=new', '--enable-unsafe-swiftshader',
         '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
         '--enable-webgl', '--window-size=900,700'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700 });

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:8099/index.html', { waitUntil: 'networkidle0', timeout: 60000 });

// Wait for physics init (loading overlay removed) + toolbar built
try {
  await page.waitForFunction(() => !document.getElementById('loading'), { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('#toolbar button').length === 6, { timeout: 10000 });
  console.log('booted: loading gone, 6 dice buttons present');
} catch (e) {
  console.log('BOOT FAILED:', e.message);
  console.log('page errors so far:', errors);
  await browser.close();
  process.exit(1);
}

async function rollAndRead(type) {
  // click the matching toolbar button
  await page.evaluate((t) => {
    [...document.querySelectorAll('#toolbar button')].find(b => b.textContent === t).click();
  }, type);
  await new Promise(r => setTimeout(r, 400));
  await page.click('#rollBtn');
  // wait until result is a finalized number (not placeholder)
  await page.waitForFunction(() => {
    const t = document.getElementById('result').textContent.trim();
    return /^\d+$/.test(t);
  }, { timeout: 15000 });
  const val = await page.$eval('#result', e => parseInt(e.textContent, 10));
  return val;
}

const ranges = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 };
const report = {};
for (const [type, max] of Object.entries(ranges)) {
  // select the die, then assert exact face count via the page's own state
  await page.evaluate((t) => {
    [...document.querySelectorAll('#toolbar button')].find(b => b.textContent === t).click();
  }, type);
  await new Promise(r => setTimeout(r, 300));
  const faceCount = await page.evaluate(() => window.__die ? window.__die.faces.length : -1);

  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(await rollAndRead(type));
  const valid = seen.every(v => v >= 1 && v <= max);
  const facesOk = faceCount === max;
  report[type] = { rolls: seen, allInRange: valid, faceCount, facesOk };
  console.log(`${type}: faces=${faceCount}(${facesOk ? 'ok' : 'BAD'}) rolls=[${seen.join(', ')}] inRange=${valid}`);
}

await page.screenshot({ path: '/tmp/dice.png' });
console.log('screenshot saved');

const realErrors = errors.filter(e => !e.includes('404'));
console.log('console errors:', realErrors.length ? realErrors : 'none (ignoring favicon 404)');

const ok = Object.values(report).every(r => r.allInRange && r.facesOk) && realErrors.length === 0;
console.log('VERIFY', ok ? 'PASS' : 'FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
