import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox','--headless=new','--enable-unsafe-swiftshader',
         '--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'],
});

const sizes = [ {w:1400,h:820}, {w:760,h:820}, {w:1100,h:640} ];
let worstNDC = 0, anyFail = false;
const errs = [];

for (const sz of sizes) {
  const page = await browser.newPage();
  page.on('pageerror', e => errs.push(`${sz.w}x${sz.h}: ` + e.message));
  try {
    await page.setViewport({ width: sz.w, height: sz.h });
    await page.goto('http://localhost:3000/index.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('diceTodo'));
    await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('loading') && !!window.__dice, { timeout: 60000 });
    await page.evaluate(() => { const a=window.__app; for(let i=0;i<6;i++) a.moveItem(a.state.master[0].id, a.state.daily, a.state.daily.length); });
    await new Promise(r=>setTimeout(r,300));

    let extreme = 0;
    for (let roll = 0; roll < 6; roll++) {
      const e = await page.evaluate((dur) => new Promise((res) => {
        window.__dice.roll();
        let m = 0; const start = performance.now();
        const tick = () => {
          const b = window.__dice.screenBoundsNDC();
          if (b) m = Math.max(m, Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
          if (performance.now() - start < dur) requestAnimationFrame(tick); else res(m);
        };
        requestAnimationFrame(tick);
      }), 1500);
      extreme = Math.max(extreme, e);
      await page.evaluate(() => { const o=document.getElementById('overlay'); o && o.classList.remove('show'); });
    }
    const die = await page.evaluate(() => window.__dice.getType());
    const pass = extreme <= 1.0;
    worstNDC = Math.max(worstNDC, extreme);
    if (!pass) anyFail = true;
    process.stdout.write(`${pass?'PASS':'FAIL'}  ${sz.w}x${sz.h}  worst |NDC| = ${extreme.toFixed(3)}  (die=${die})\n`);
  } catch (err) {
    anyFail = true;
    process.stdout.write(`ERROR ${sz.w}x${sz.h}: ${err.message}\n`);
  } finally {
    await page.close();
  }
}

await browser.close();
process.stdout.write(`\nworst across all sizes: ${worstNDC.toFixed(3)}  (<=1.0 = fully on-screen)\n`);
process.stdout.write('errors: ' + (errs.length ? errs.join(' | ') : 'none') + '\n');
const ok = !anyFail && errs.length === 0;
process.stdout.write('CONTAINMENT ' + (ok ? 'PASS' : 'FAIL') + '\n');
process.exit(ok ? 0 : 1);
