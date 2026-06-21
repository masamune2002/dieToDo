import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox','--headless=new','--enable-unsafe-swiftshader',
         '--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--window-size=900,700'],
});
const page = await browser.newPage();
await page.goto('http://localhost:8099/index.html', { waitUntil: 'networkidle0', timeout: 60000 });
await page.waitForFunction(() => !document.getElementById('loading'), { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll('#toolbar button')].find(b=>b.textContent==='d10').click());
await new Promise(r=>setTimeout(r,400));
// For each upward-facing label, cast a ray from camera and see whether the die
// body (mesh) is hit BEFORE the label plane -> occlusion.
const out = await page.evaluate(() => {
  const THREE = window.__THREE;
  const d = window.__die, cam = window.__camera;
  const rc = new THREE.Raycaster();
  const res = [];
  for (const l of d.labels) {
    const wp = new THREE.Vector3(); l.getWorldPosition(wp);
    const dir = wp.clone().sub(cam.position).normalize();
    rc.set(cam.position, dir);
    const hits = rc.intersectObject(d.mesh, true); // includes labels (children)
    if (!hits.length) continue;
    const first = hits[0].object;
    const isLabel = d.labels.includes(first);
    res.push({ value: l.userData.face.value, firstIsLabel: isLabel, firstType: isLabel ? 'number' : 'dieBody' });
  }
  return res;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
