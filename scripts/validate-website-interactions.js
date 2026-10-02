const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');

async function run() {
  const root = path.resolve(__dirname, '../site/dist');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'codexauth-website-test-'));
  const output = path.resolve(__dirname, '../output/playwright/website');
  await fs.mkdir(output, { recursive: true });
  const headerFile = await fs.readFile(path.join(root, '_headers'), 'utf8');
  const csp = headerFile.match(/Content-Security-Policy:\s*([^\r\n]+)/)[1];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname) + (url.pathname.endsWith('/') ? 'index.html' : ''));
    if (!file.startsWith(root + path.sep)) { response.writeHead(404).end(); return; }
    try {
      const body = await fs.readFile(file);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
      response.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Content-Security-Policy': csp });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  const evaluate = code => win.webContents.executeJavaScript(code);
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); };
  try {
    for (const language of ['zh', 'en']) {
      await win.loadURL(`http://127.0.0.1:${server.address().port}/${language}/`);
      await settle();
      assert.equal(await evaluate("document.querySelectorAll('#demo-accounts .account-row').length"), 5);
      assert.equal(await evaluate("document.querySelector('.vault-summary, .strategy-panel, .bar-chart')"), null);
      assert.equal(await evaluate("document.querySelectorAll('#demo-accounts [data-account]').length"), 4);
      for (const width of [360, 760, 1440]) {
        win.setContentSize(width, 1000); await settle();
        assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, `${language}: horizontal overflow at ${width}`);
        assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.app-tools button')).filter(button => { const r=button.getBoundingClientRect(); return r.left<0 || r.right>innerWidth; }).map(button=>button.id)`), [], `${language}: clipped toolbar at ${width}`);
        assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#demo-accounts .account-row')).filter(row => row.scrollWidth > row.clientWidth).map(row => row.textContent)`), [], `${language}: account overflow at ${width}`);
        await evaluate("document.querySelector('#preview').scrollIntoView({block:'start',behavior:'instant'})"); await settle();
        await fs.writeFile(path.join(output, `${language}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      await click('#demo-accounts [data-account="1"]');
      await evaluate(`new Promise((resolve,reject) => { const start=Date.now(); const poll=()=>{ if(document.querySelector('#current-email').textContent==='work@example.com') return resolve(); if(Date.now()-start>3000)return reject(new Error('Switch timed out')); setTimeout(poll,30); }; poll(); })`);
      assert.equal(await evaluate("document.querySelector('#widget-name').textContent"), 'work@example.com');
      assert.equal(await evaluate("document.querySelector('#session-value').textContent"), '95%');
      await click('#demo-settings');
      assert.equal(await evaluate("document.querySelector('#demo-settings-dialog').open"), true);
      assert.equal(await evaluate("document.querySelector('#demo-auto-reset').disabled"), true);
      await click('#demo-auto-switch');
      assert.equal(await evaluate("document.querySelector('#demo-auto-reset').disabled"), false);
      await click('#demo-settings-dialog [value="close"]');
      await click('#tab-usage');
      assert.equal(await evaluate("document.querySelector('#panel-usage').hidden"), false);
      assert.equal(await evaluate("document.querySelectorAll('.demo-local-stats article').length"), 4);
      await click('.demo-stat-details summary');
      assert.equal(await evaluate("document.querySelector('.demo-stat-details').open"), true);
      await click('#tab-accounts'); await click('#privacy-toggle');
      assert.equal(await evaluate("document.querySelector('#current-email').textContent"), '••••••@example.com');
      await click('.desktop-screenshots summary');
      await evaluate("Promise.all(Array.from(document.querySelectorAll('.screenshot-grid img')).map(img => { img.loading = 'eager'; return img.decode(); }))");
      assert.equal(await evaluate("Array.from(document.querySelectorAll('.screenshot-grid img')).every(img=>img.naturalWidth>0)"), true);
    }
    assert.deepEqual(errors, [], 'browser errors under production CSP');
    console.log('Website interactions passed: Chinese/English, 360/760/1440 layouts, switching/widget sync, settings dependencies, usage details, privacy and screenshots under production CSP.');
  } finally {
    win.destroy();
    await new Promise(resolve => server.close(resolve));
    assert.ok(profile.startsWith(path.join(os.tmpdir(), 'codexauth-website-test-')));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
run().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
