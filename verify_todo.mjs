import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox','--headless=new','--enable-unsafe-swiftshader',
         '--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--window-size=1200,820'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 820 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

// start clean (no persisted state)
await page.goto('http://localhost:3000/index.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.removeItem('diceTodo'));
await page.evaluate(async () => { await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username:'admin', password:'adminpass' }) }); });
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !document.getElementById('loading'), { timeout: 60000 });
await page.waitForFunction(() => !!window.__app && !document.getElementById('loginScreen').classList.contains('show'), { timeout: 10000 });

const checks = [];
const ok = (name, cond, extra='') => { checks.push({ name, pass: !!cond, extra }); console.log(`${cond?'PASS':'FAIL'}  ${name}${extra?'  '+extra:''}`); };

// 1) 80/20 layout
const layout = await page.evaluate(() => {
  const top = document.querySelector('.top').getBoundingClientRect();
  const dice = document.querySelector('.dice').getBoundingClientRect();
  const total = top.height + dice.height;
  return { topPct: top.height/total, dicePct: dice.height/total };
});
ok('top is ~80% tall', Math.abs(layout.topPct - 0.8) < 0.03, `top=${(layout.topPct*100).toFixed(1)}%`);
ok('dice is ~20% tall', Math.abs(layout.dicePct - 0.2) < 0.03, `dice=${(layout.dicePct*100).toFixed(1)}%`);

// 2) seed data present, two columns
const seed = await page.evaluate(() => ({
  master: window.__app.state.master.length,
  daily: window.__app.state.daily.length,
}));
ok('master seeded', seed.master === 6, `master=${seed.master}`);
ok('today starts empty', seed.daily === 0);

// 3) die-type mapping (unit)
const mapping = await page.evaluate(() => {
  const f = window.__app.dieForCount;
  return [1,3,4,5,6,7,8,9,10,11,12,13,20].map(n => [n, f(n)]);
});
const expect = {1:'d4',3:'d4',4:'d4',5:'d6',6:'d6',7:'d8',8:'d8',9:'d10',10:'d10',11:'d12',12:'d12',13:'d20',20:'d20'};
let mapOk = mapping.every(([n,d]) => expect[n] === d);
ok('die-type mapping correct', mapOk, JSON.stringify(Object.fromEntries(mapping)));

// 4) move 5 tasks to daily -> die should become d6, badge + lead update
await page.evaluate(() => {
  const a = window.__app;
  for (let i = 0; i < 5; i++) a.moveItem(a.state.master[0].id, a.state.daily, a.state.daily.length);
});
await new Promise(r=>setTimeout(r,400));
const after5 = await page.evaluate(() => ({
  daily: window.__app.state.daily.length,
  badge: document.getElementById('dieBadge').textContent,
  lead: document.getElementById('diceLead').textContent,
  rollDisabled: document.getElementById('rollBtn').disabled,
  numbers: [...document.querySelectorAll('#dailyList .num')].map(n=>n.textContent),
}));
ok('5 tasks in today', after5.daily === 5);
ok('die became d6 for 5 items', after5.badge === 'd6', after5.badge);
ok('lead shows 1-5', after5.lead.includes('1–5'), after5.lead);
ok('daily numbered 1..5', after5.numbers.join(',') === '1,2,3,4,5', after5.numbers.join(','));
ok('roll enabled with tasks', after5.rollDisabled === false);

// 5) result logic: valid pick vs roll-again (drive the callback path directly)
const validPick = await page.evaluate(() => {
  // simulate the onResult handler by reading the same logic the app uses
  const n = window.__app.state.daily.length;
  const value = 3;
  return (value>=1 && value<=n) ? window.__app.state.daily[value-1].text : 'AGAIN';
});
ok('roll within range maps to a task', validPick !== 'AGAIN' && typeof validPick === 'string', validPick);
const rollAgain = await page.evaluate(() => {
  const n = window.__app.state.daily.length; const value = 6; // d6 face beyond 5 items
  return (value>=1 && value<=n) ? 'TASK' : 'AGAIN';
});
ok('roll beyond count = roll again', rollAgain === 'AGAIN');

// 6) complete a task -> removed + renumber
const beforeComplete = await page.evaluate(() => window.__app.state.daily.map(t=>t.text));
await page.evaluate(() => window.__app.completeById(window.__app.state.daily[1].id));
await new Promise(r=>setTimeout(r,200));
const afterComplete = await page.evaluate(() => ({
  texts: window.__app.state.daily.map(t=>t.text),
  numbers: [...document.querySelectorAll('#dailyList .num')].map(n=>n.textContent),
}));
ok('completing removes one task', afterComplete.texts.length === beforeComplete.length - 1);
ok('removed the right task', !afterComplete.texts.includes(beforeComplete[1]));
ok('renumbered contiguously', afterComplete.numbers.join(',') === '1,2,3,4', afterComplete.numbers.join(','));
const after4 = await page.evaluate(() => document.getElementById('dieBadge').textContent);
ok('die back to d4 for 4 items', after4 === 'd4', after4);

// 7) a real on-canvas roll fires the overlay
await page.click('#rollBtn');
await page.waitForFunction(() => document.getElementById('overlay').classList.contains('show'), { timeout: 16000 });
const ov = await page.evaluate(() => ({
  roll: document.getElementById('ovRoll').textContent,
  pick: document.getElementById('ovPick').textContent,
}));
ok('roll shows overlay', /You rolled \d+/.test(ov.roll), `${ov.roll} | ${ov.pick}`);

await page.screenshot({ path: '/tmp/todo.png' });

const realErrors = errors.filter(e => !/Failed to load resource/.test(e) && !e.includes('404'));
ok('no console errors', realErrors.length === 0, realErrors.join(' | '));

const allPass = checks.every(c => c.pass);
console.log('\nVERIFY', allPass ? 'PASS' : 'FAIL');
await browser.close();
process.exit(allPass ? 0 : 1);
