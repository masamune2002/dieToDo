import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath:'/usr/bin/chromium', headless:'new',
  args:['--no-sandbox','--headless=new','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage(); await p.setViewport({width:1100,height:720});
await p.goto('http://localhost:3000/index.html',{waitUntil:'networkidle0'});
await p.waitForFunction(()=>document.getElementById('loginScreen').classList.contains('show'),{timeout:30000});
await new Promise(r=>setTimeout(r,300));
await p.screenshot({path:'/tmp/login.png'});
// also the admin app with user bar
await p.evaluate(async()=>{await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'adminpass'})});});
await p.reload({waitUntil:'networkidle0'});
await p.waitForFunction(()=>!document.getElementById('loginScreen').classList.contains('show')&&!!window.__app,{timeout:15000});
await new Promise(r=>setTimeout(r,500));
await p.click('#usersBtn'); await new Promise(r=>setTimeout(r,400));
await p.screenshot({path:'/tmp/users.png'});
await b.close(); console.log('shots done');
