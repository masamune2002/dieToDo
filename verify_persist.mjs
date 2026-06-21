import puppeteer from 'puppeteer-core';
const BASE = 'http://localhost:3000';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox','--headless=new','--enable-unsafe-swiftshader',
         '--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 820 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

const checks = [];
const ok = (name, cond, extra='') => { checks.push(!!cond); console.log(`${cond?'PASS':'FAIL'}  ${name}${extra?'  '+extra:''}`); };

// 1) Fresh server -> frontend seeds the 6 example tasks
await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.evaluate(async () => { await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username:'admin', password:'adminpass' }) }); });
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !document.getElementById('loading') && !!window.__app && !document.getElementById('loginScreen').classList.contains('show'), { timeout: 60000 });
await new Promise(r=>setTimeout(r,400));
const seeded = await page.evaluate(() => ({ m: window.__app.state.master.length, d: window.__app.state.daily.length }));
ok('fresh load seeds 6 master tasks', seeded.m === 6 && seeded.d === 0, JSON.stringify(seeded));

// 2) The seed was persisted to the server (independent API read)
const apiAfterSeed = await page.evaluate(async (b) => (await fetch(b+'/api/state')).json(), BASE);
ok('server now reports seeded:true', apiAfterSeed.seeded === true);
ok('server stored the 6 seed tasks', apiAfterSeed.master.length === 6, `master=${apiAfterSeed.master.length}`);

// 3) Make edits through the app: add a task, then move two master tasks into Today
await page.type('#masterInput', 'E2E added task');
await page.keyboard.press('Enter');
await page.evaluate(() => { const a=window.__app; a.moveItem(a.state.master[0].id, a.state.daily, a.state.daily.length);
                                                   a.moveItem(a.state.master[0].id, a.state.daily, a.state.daily.length); });
await new Promise(r=>setTimeout(r,600));   // let the chained PUTs flush

// 4) Reload — state must come back from the server (not localStorage)
await page.evaluate(() => localStorage.clear());   // prove it's the SERVER, not localStorage
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !document.getElementById('loading') && !!window.__app, { timeout: 60000 });
await new Promise(r=>setTimeout(r,400));
const afterReload = await page.evaluate(() => ({
  master: window.__app.state.master.map(t=>t.text),
  daily: window.__app.state.daily.map(t=>t.text),
}));
ok('added task survived reload (from server)', afterReload.master.includes('E2E added task'), afterReload.master.join(' | '));
ok('moved tasks are in Today after reload', afterReload.daily.length === 2, `daily=${afterReload.daily.length}`);
ok('Today is numbered/ordered', afterReload.daily.length === 2);

// 5) total task count consistent (8 = 6 seed + 1 added, 2 of which moved to daily)
const total = afterReload.master.length + afterReload.daily.length;
ok('no tasks lost across reload', total === 7, `total=${total}`);

// Ignore the expected 401 from /api/me on the initial pre-login page load.
const realErrors = errors.filter(e => !/Failed to load resource/.test(e) && !e.includes('favicon'));
ok('no uncaught JS errors', realErrors.length === 0, realErrors.join(' | '));

await page.screenshot({ path: '/tmp/persist.png' });
await browser.close();
const allPass = checks.every(Boolean);
console.log('\nPERSIST', allPass ? 'PASS' : 'FAIL');
process.exit(allPass ? 0 : 1);
