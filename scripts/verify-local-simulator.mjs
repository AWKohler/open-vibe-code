// Browser integration test with the real Companion. Only Botflow's authenticated
// source/config/state endpoints are fixture-backed; no database or cloud Mac is
// used. Run after building this repo and starting the Companion with
// BOTFLOW_SIMULATOR_ORIGINS=http://localhost:3000.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const output = '/tmp/botflow-browser-test';
await mkdir(output, { recursive: true });
const source = await readFile(process.argv[2] || '/tmp/botflow-browser-fixture.tgz');
await build({ stdin: {
  contents: `import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SwiftSimulatorPreview } from './src/components/persistent-workspace/swift-simulator-preview';
    import { ToastProvider } from './src/components/ui/toast';
    function App() {
      const [running, setRunning] = React.useState(true);
      return <ToastProvider>{running ? <SwiftSimulatorPreview projectId="browser-smoke" onStop={() => setRunning(false)} /> : <p>Preview stopped</p>}</ToastProvider>;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);`,
  loader: 'tsx', resolveDir: root,
}, bundle: true, platform: 'browser', jsx: 'automatic', outfile: output + '/app.js',
  define: { 'process.env.NODE_ENV': '"development"', 'process.env.NEXT_PUBLIC_COMPANION_MAC_URL': '""' }, tsconfig: path.join(root, 'tsconfig.json') });
const cssDir = path.join(root, '.next/static/css');
const css = (await Promise.all((await readdir(cssDir)).filter((f) => f.endsWith('.css')).map((f) => readFile(path.join(cssDir, f), 'utf8')))).join('\n');
const bundle = await readFile(output + '/app.js');
const calls = [];
const server = createServer(async (req, res) => {
  calls.push(`${req.method} ${req.url}`);
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle); }
  else if (req.url === '/styles.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
  else if (req.url === '/api/swift-preview/config') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ provider: 'local' })); }
  else if (req.url.endsWith('/source')) { res.setHeader('Content-Type', 'application/gzip'); res.end(source); }
  else if (req.url.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end('{}'); }
  else if (/\.(png|webp|svg)$/.test(req.url)) {
    try { res.setHeader('Content-Type', req.url.endsWith('.svg') ? 'image/svg+xml' : req.url.endsWith('.webp') ? 'image/webp' : 'image/png'); res.end(await readFile(path.join(root, 'public', req.url))); }
    catch { res.statusCode = 404; res.end(); }
  }
  else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root" style="position:relative;height:100vh;background:var(--background,#171717)"></div><script src="/app.js"></script></body></html>'); }
});
await new Promise((resolve) => server.listen(3000, '127.0.0.1', resolve));
let browser;
let page;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.BOTFLOW_TEST_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    headless: true,
  });
  page = await browser.newPage();
  async function clickButton(text) {
    for (const button of await page.$$('button')) {
      if (await button.evaluate((el, label) => el.innerText === label, text)) {
        await button.click();
        return;
      }
    }
    throw new Error(`Button not found: ${text}`);
  }
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(String(e)); console.error(e); });
  await page.goto('http://localhost:3000');
  await page.waitForFunction(() => document.body.innerText.includes('currently at capacity'));
  console.log('Setup screen rendered');
  await page.screenshot({ path: output + '/setup.png' });
  await clickButton('Check setup');
  await page.waitForFunction(() => document.body.innerText.includes('Start local preview'), { timeout: 60000 });
  await page.screenshot({ path: output + '/ready.png' });
  console.log('Prerequisites ready');
  await clickButton('Start local preview');
  const progress = setInterval(async () => {
    try { console.log('Preview:', (await page.evaluate(() => document.body.innerText)).slice(0, 700)); }
    catch { /* Browser closed by cleanup. */ }
  }, 10000);
  progress.unref();
  await page.waitForFunction(() => /\d+ fps/.test(document.body.innerText), { timeout: 300000 });
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas');
    return c && c.width > 500;
  });
  await page.screenshot({ path: output + '/live.png' });
  console.log('Live video decoded');
  clearInterval(progress);
  const canvas = await page.$('canvas');
  const rect = await canvas.boundingBox();
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await page.screenshot({ path: output + '/tap.png' });
  await page.locator('button[title="Rotate to landscape"]').click();
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas');
    return c && c.width > c.height;
  }, { timeout: 15000 });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page.screenshot({ path: output + '/landscape.png' });
  await page.locator('button[title="Tar the sandbox and rebuild"]').click();
  await page.waitForFunction(() => /\d+ fps/.test(document.body.innerText), { timeout: 180000 });
  await page.screenshot({ path: output + '/rebuilt.png' });
  await page.locator('button[title="Stop the simulator"]').click();
  await page.waitForFunction(() => document.body.innerText.includes('Preview stopped'));
  assert.equal(calls.filter((url) => url.endsWith('/source')).length, 2, 'initial build and refresh each export source exactly once');
  assert.ok(!calls.some((url) => /swift-preview\/(start|rebuild)/.test(url)), 'local UI must never allocate cloud previews');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  await writeFile(output + '/requests.json', JSON.stringify(calls, null, 2));
  console.log('PASS: setup, readiness, local build, decoded H.264, tap, rotation, refresh, Stop; no cloud allocation. Screenshots:', output);
} catch (error) {
  if (page) {
    await page.screenshot({ path: output + '/failure.png' });
    console.error(await page.evaluate(() => document.body.innerText));
  }
  throw error;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
