import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox','--headless=new','--enable-unsafe-swiftshader',
         '--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--window-size=900,700'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700 });
await page.goto('http://localhost:8099/index.html', { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !document.getElementById('loading'), { timeout: 60000 });

for (const type of ['d6','d10']) {
  await page.evaluate((t) => [...document.querySelectorAll('#toolbar button')].find(b=>b.textContent===t).click(), type);
  await new Promise(r=>setTimeout(r,300));
  // freeze the die flat so all top faces are readable, then report label count + sizes
  const info = await page.evaluate(() => {
    const d = window.__die;
    return { type:d.type, labels:d.labels.length, faces:d.faces.length,
             sizes:d.faces.map(f=>+f.size.toFixed(3)),
             visible:d.labels.map(l=>l.visible) };
  });
  console.log(JSON.stringify(info));
  await page.click('#rollBtn');
  await page.waitForFunction(()=>/^\d+$/.test(document.getElementById('result').textContent.trim()),{timeout:15000});
  await new Promise(r=>setTimeout(r,200));
  await page.screenshot({ path:`/tmp/${type}.png` });
}
await browser.close();
console.log('done');
