import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox','--headless=new','--enable-unsafe-swiftshader',
         '--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));

await page.goto('http://localhost:3000/index.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.removeItem('diceTodo'));
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !document.getElementById('loading') && !!window.__dice, { timeout: 60000 });
await new Promise(r=>setTimeout(r,1800));   // let the die drop & settle

const info = await page.evaluate(() => {
  const mount = document.getElementById('diceCanvas');
  const cv = mount.querySelector('canvas');
  const d = window.__dice;
  const sb = d.screenBoundsNDC && d.screenBoundsNDC();
  return {
    dieType: d.getType(),
    dailyCount: window.__app.dailyCount,
    mountW: mount.clientWidth, mountH: mount.clientHeight,
    dpr: window.devicePixelRatio,
    canvasBufW: cv ? cv.width : null, canvasBufH: cv ? cv.height : null,
    canvasCssW: cv ? cv.clientWidth : null, canvasCssH: cv ? cv.clientHeight : null,
    screenBoundsNDC: sb,
  };
});
console.log(JSON.stringify(info, null, 2));
console.log('logs:', logs.length ? logs : 'none');
await page.screenshot({ path: '/tmp/fresh.png' });
// also a cropped shot of just the bottom pane
const dice = await page.$('.dice');
await dice.screenshot({ path: '/tmp/fresh_pane.png' });
await browser.close();
