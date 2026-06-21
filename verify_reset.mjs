import puppeteer from 'puppeteer-core';
const BASE = 'http://localhost:3000';
const b = await puppeteer.launch({ executablePath:'/usr/bin/chromium', headless:'new',
  args:['--no-sandbox','--headless=new','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const page = await b.newPage(); await page.setViewport({ width: 1200, height: 820 });
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const checks = []; const ok = (n,c,x='') => { checks.push(!!c); console.log(`${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`); };

await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.evaluate(async () => { await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'adminpass'})}); });
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !!window.__app && !document.getElementById('loginScreen').classList.contains('show'), { timeout: 60000 });

// Ensure at least 3 tasks in Today
await page.evaluate(() => { const a = window.__app;
  while (a.state.daily.length < 3 && a.state.master.length > 0) a.moveItem(a.state.master[0].id, a.state.daily, a.state.daily.length); });
await new Promise(r=>setTimeout(r,300));

const before = await page.evaluate(() => ({
  master: window.__app.state.master.length,
  daily: window.__app.state.daily.length,
  badge: document.getElementById('dieBadge').textContent,
  resetDisabled: document.getElementById('resetBtn').disabled,
}));
ok('Today has tasks before reset', before.daily >= 3, JSON.stringify(before));
ok('reset button enabled when Today has tasks', before.resetDisabled === false);
const total = before.master + before.daily;

// Click Reset
await page.click('#resetBtn');
await page.waitForFunction(() => window.__app.state.daily.length === 0, { timeout: 5000 });
const after = await page.evaluate(() => ({
  master: window.__app.state.master.length,
  daily: window.__app.state.daily.length,
  badge: document.getElementById('dieBadge').textContent,
  resetDisabled: document.getElementById('resetBtn').disabled,
  dailyDom: document.querySelectorAll('#dailyList .task').length,
}));
ok('Today is empty after reset', after.daily === 0 && after.dailyDom === 0);
ok('all tasks moved back to master (none lost)', after.master === total, `master=${after.master} expected=${total}`);
ok('die badge reset to d4', after.badge === 'd4', after.badge);
ok('reset button disabled when Today empty', after.resetDisabled === true);

// Persisted on the server?
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !!window.__app && !document.getElementById('loginScreen').classList.contains('show'), { timeout: 60000 });
await new Promise(r=>setTimeout(r,300));
const reload = await page.evaluate(() => ({ master: window.__app.state.master.length, daily: window.__app.state.daily.length }));
ok('reset persisted across reload (server)', reload.daily === 0 && reload.master === total, JSON.stringify(reload));

ok('no uncaught JS errors', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: '/tmp/reset.png' });
await b.close();
const allPass = checks.every(Boolean);
console.log('\nRESET', allPass ? 'PASS' : 'FAIL');
process.exit(allPass ? 0 : 1);
