import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox','--headless=new','--enable-unsafe-swiftshader',
         '--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--window-size=1200,820'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 820 });
await page.goto('http://localhost:8099/index.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.removeItem('diceTodo'));
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !document.getElementById('loading') && !!window.__app, { timeout: 60000 });
// put 5 tasks into today (d6) and let the die settle
await page.evaluate(() => { const a=window.__app; for(let i=0;i<5;i++) a.moveItem(a.state.master[0].id, a.state.daily, a.state.daily.length); });
await new Promise(r=>setTimeout(r,1800));
await page.screenshot({ path: '/tmp/todo_idle.png' });
console.log('done');
await browser.close();
