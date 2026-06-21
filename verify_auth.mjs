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
const loginVisible = () => page.evaluate(() => document.getElementById('loginScreen').classList.contains('show'));

// 1) Unauthenticated -> login screen shown, app gated
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !document.getElementById('loading'), { timeout: 60000 });
await new Promise(r=>setTimeout(r,300));
ok('login screen shown when unauthenticated', await loginVisible());

// 2) Wrong password -> error
await page.type('#loginUser', 'admin');
await page.type('#loginPass', 'wrongpw');
await page.click('#loginForm button[type=submit]');
await page.waitForFunction(() => document.getElementById('loginErr').textContent.length > 0, { timeout: 8000 });
ok('wrong password shows error', /invalid/i.test(await page.$eval('#loginErr', e=>e.textContent)));
ok('still on login screen after bad login', await loginVisible());

// 3) Correct admin login -> app loads, admin UI visible
await page.click('#loginUser', { clickCount: 3 }); await page.type('#loginUser', 'admin');
await page.click('#loginPass', { clickCount: 3 }); await page.type('#loginPass', 'adminpass');
await page.click('#loginForm button[type=submit]');
await page.waitForFunction(() => !document.getElementById('loginScreen').classList.contains('show') && !!window.__app, { timeout: 10000 });
const who = await page.$eval('#whoName', e=>e.textContent);
ok('admin logged in, app shown', !(await loginVisible()) && who === 'admin', `who=${who}`);
ok('admin sees Users button (is-admin)', await page.evaluate(() => document.body.classList.contains('is-admin')));
const adminMaster = await page.evaluate(() => window.__app.state.master.length);
ok('fresh admin seeded with 6 demo tasks', adminMaster === 6, `master=${adminMaster}`);

// 4) Admin user management: open modal, add a user
await page.click('#usersBtn');
await page.waitForFunction(() => document.getElementById('usersModal').classList.contains('show'), { timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll('#usersList li').length >= 1, { timeout: 5000 });
const usersBefore = await page.evaluate(() => document.querySelectorAll('#usersList li').length);
ok('users list shows the admin', usersBefore === 1, `count=${usersBefore}`);
await page.type('#newUser', 'bob');
await page.type('#newPass', 'bobpw123');
await page.click('#addUserForm button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('#usersList li').length === 2, { timeout: 8000 });
const names = await page.$$eval('#usersList .uname', els => els.map(e=>e.textContent));
ok('new user appears in list', names.includes('bob'), names.join(', '));
await page.click('#usersClose');   // close modal so it doesn't intercept later clicks
await page.waitForFunction(() => !document.getElementById('usersModal').classList.contains('show'), { timeout: 5000 });

// 5) Logout -> back to login
await page.click('#logoutBtn');
await page.waitForFunction(() => document.getElementById('loginScreen').classList.contains('show'), { timeout: 10000 });
ok('logout returns to login screen', await loginVisible());

// 6) Login as the new (non-admin) user -> own empty list, no admin UI
await page.type('#loginUser', 'bob');
await page.type('#loginPass', 'bobpw123');
await page.click('#loginForm button[type=submit]');
await page.waitForFunction(() => !document.getElementById('loginScreen').classList.contains('show') && !!window.__app, { timeout: 10000 });
const bobWho = await page.$eval('#whoName', e=>e.textContent);
ok('bob logged in', bobWho === 'bob', `who=${bobWho}`);
ok('bob is NOT admin (no Users button)', await page.evaluate(() => !document.body.classList.contains('is-admin')));
const bob = await page.evaluate(() => ({ m: window.__app.state.master.length, d: window.__app.state.daily.length }));
ok('bob has his OWN empty list (per-user isolation)', bob.m === 0 && bob.d === 0, JSON.stringify(bob));

// 7) bob can't reach the admin API directly
const forbid = await page.evaluate(async () => (await fetch('/api/users')).status);
ok('non-admin blocked from /api/users (403)', forbid === 403, `status=${forbid}`);

// Ignore the browser's automatic logging of expected non-2xx fetches
// (401 before login / on logout, 403 for the deliberate non-admin probe).
// Genuine JS exceptions arrive as 'PAGEERROR:' and are still caught.
const realErrors = errors.filter(e => !/Failed to load resource/.test(e) && !e.includes('favicon'));
ok('no uncaught JS errors', realErrors.length === 0, realErrors.join(' | '));

await page.screenshot({ path: '/tmp/auth.png' });
await browser.close();
const allPass = checks.every(Boolean);
console.log('\nAUTH', allPass ? 'PASS' : 'FAIL');
process.exit(allPass ? 0 : 1);
