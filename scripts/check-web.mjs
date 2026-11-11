import assert from 'node:assert/strict';
import {connectCdp} from './lib/browser-cdp.mjs';
import {prepareBusinessDemo} from './lib/business-demo.mjs';
import {rehearseBusinessDemo} from './lib/demo-rehearsal.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { connectionConfig } from './lib/backup.mjs';
import {checkApplicationBilling} from './check-application-billing.mjs';
import { checkUsageAnalytics } from './check-usage-analytics.mjs';
import {checkModelManagement} from './check-model-management-web.mjs';

/*
 * Browser regression for the tracing/migration/verification changes.
 * Chrome is driven over the DevTools protocol with Node's built-in WebSocket,
 * so the check adds no test dependency. Everything runs in its own temp
 * directory, ports and review workspace; external model access stays disabled.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
let chrome, cdp, tempDir, debugPort;
const postgres=process.argv.includes('--postgres');
let database,schema;
const assertions = [];
const screenshotDir = resolve(root, process.env.WEB_CHECK_SCREENSHOT_DIR || 'docs/validation/screenshots-2026-10-23');
const check = (value, message) => { assert.ok(value, message); assertions.push(message); };

const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function start(file, args = [], env = {}, cwd = root) {
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('UPSTREAM_') && !key.startsWith('VITE_')));
  const child = spawn(file === process.execPath ? process.execPath : file, file === process.execPath ? args : args, {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...baseEnv, PLATFORM_MODE: 'development', DATABASE_URL: '', DATABASE_SCHEMA: '', REDIS_URL: '', STORE_MODE: 'memory',
      PGOPTIONS: '', HOST: '127.0.0.1', SERVICE_TOKEN: 'web-check-service-token', BOOTSTRAP_TOKEN: '', COOKIE_SECURE: 'false',
      ALLOW_UPSTREAM_VALIDATION: 'false', ALLOW_UPSTREAM_REQUESTS: 'false', ...env },
  });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-8000); });
  child.stderr.on('data', data => { output = (output + data).slice(-8000); });
  child.diagnostic = () => output;
  children.push(child);
  return child;
}
function spawnNode(file, env = {}) { return start(process.execPath, [resolve(root, file)], env); }
async function ready(url, child) {
  for (let i = 0; i < 160; i++) {
    if (child && child.exitCode !== null) throw new Error(`service exited before readiness: ${child.diagnostic()}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(400) })).ok) return; } catch { /* keep polling */ }
    await pause(100);
  }
  throw new Error(`service did not become ready: ${url}`);
}
async function stopAll() {
  try { await cdp?.close(); } catch { /* ignore */ }
  for (const child of [...children].reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)]);
    }
  }
  if(database){
    if(schema&&/^agp_web_[a-f0-9]{32}$/.test(schema))await database.query(`drop schema "${schema}" cascade`);
    await database.end();
  }
  if(tempDir){
    const physical=await realpath(tempDir),runtime=await realpath(resolve(root,'.runtime'));
    assert.ok(runtime.startsWith((await realpath(root))+sep)&&physical.startsWith(runtime+sep)&&/^web-check-[a-f0-9-]{36}$/.test(physical.split(/[\\/]/).at(-1)),'only remove the owned web-check directory inside this workspace');
    await rm(physical,{recursive:true,force:true});
  }
}

/* ---------------- minimal CDP client ---------------- */
async function waitFor(expression, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await cdp.evaluate(expression)) return true; } catch { /* page may be navigating */ }
    await pause(120);
  }
  throw new Error(`timed out waiting for: ${expression}`);
}
async function evaluate(expression) { return cdp.evaluate(expression); }
async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 760 });
  await pause(150);
}
async function screenshot(name) {
  await pause(350);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = resolve(screenshotDir, name);
  await mkdir(screenshotDir, { recursive: true });
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
}
const clickExact = text => evaluate(`(()=>{const el=[...document.querySelectorAll('button,a,summary')].find(node=>node.textContent.replace(/\\s+/g,' ').trim()===${JSON.stringify(text)});if(!el)return false;el.click();return true;})()`);
const clickNav = async label => {
  const clicked = await evaluate(`(()=>{const el=[...document.querySelectorAll('#v4-sidebar nav button')].find(node=>node.textContent.replace(/\\s+/g,' ').trim().includes(${JSON.stringify(label)}));if(!el)return false;el.click();return true;})()`);
  check(clicked, `navigation target exists: ${label}`);
  await pause(400);
};
const setInput = (selector, value, tag = 'HTMLInputElement') => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const setter=Object.getOwnPropertyDescriptor(${tag}.prototype,'value').set;setter.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
const pressKey = async (key, code = key) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0 });
  await pause(120);
};
async function login(loginName, password) {
  await waitFor(`!!document.querySelector('input[autocomplete="username"]')`, 15000);
  await setInput('input[autocomplete="username"]', loginName);
  await setInput('#login-password', password);
  const clicked = await clickExact('登录');
  check(clicked, 'login button is present');
  await waitFor(`!!document.querySelector('#v4-sidebar') || document.body.innerText.includes('运营工作台') || document.body.innerText.includes('开始使用')`, 15000);
  await pause(500);
}

/* ---------------- seed ---------------- */
async function seed(cp, gateway, model, employeePassword) {
  let cookie = '';
  async function api(path, body) {
    const response = await fetch(`${cp}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const value = await response.json();
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  let step = 0;
  async function command(type, payload) {
    const c = { type, payload, idempotencyKey: `web-check-${randomUUID()}-${++step}` };
    const preview = await api('/api/v1/platform/preview', c);
    return (await api('/api/v1/platform/commands', { ...c, previewToken: preview.previewToken })).result;
  }
  const adminPassword = 'Web-check-admin-2026!';
  await api('/api/v1/auth/setup', { directoryId: 'web-ops', name: '回归运营', password: adminPassword });
  await api('/api/v1/auth/login', { directoryId: 'web-ops', password: adminPassword });
  const state = await api('/api/v1/platform/state');
  const service = state.services[0];
  await command('save.service', {
    ...service, name: '回归模型服务', baseUrl: model, credentialRef: null, active: true,
    mappings: service.mappings.map(mapping => ({ ...mapping, upstreamModel: mapping.upstreamModel, inputPrice: 2, outputPrice: 3, cachedInputPrice: 0.5, limits: { mode: 'inherit' } })),
  });
  await api(`/api/v1/platform/services/${service.id}/verify`, { idempotencyKey: 'web-check-seed-verify' });
  await command('save.pool', { id: state.pools[0].id, name: '回归模型池', entries: [{ definitionId: state.definitions[0].id, serviceId: service.id, open: true }], limits: { mode: 'inherit' } });
  await command('settings.update', { name: 'Signal Atlas · 浏览器回归', personalDefaultPoolId: state.pools[0].id, projectDefaultPoolId: state.pools[0].id });
  const employee = await command('save.member', { name: '回归员工', directoryId: 'web-employee', organizationId: 'department-engineering', category: 'employee', roles: ['employee'], tags: [], active: true, password: employeePassword });
  const range = { poolId: state.pools[0].id, mode: 'follow', definitionIds: [] };
  const plan = await command('save.plan', { name: '回归月度方案', range, amount: 20, cadence: 'monthly', quotaDays: 30, entitlementDays: 365 });
  await command('distribution.execute', { operation: 'open_plan', planId: plan.id, memberIds: [employee.id] });
  // Bump the plan so the granted entitlement is one version behind for the migration UI.
  await command('save.plan', { id: plan.id, name: '回归月度方案', range, amount: 25, cadence: 'monthly', quotaDays: 30, entitlementDays: 365 });
  const issued = await command('key.issue', { name: '回归密钥', purpose: 'personal', memberId: employee.id });
  const origin = `web-origin-${randomUUID()}`, retry = `web-retry-${randomUUID()}`;
  async function gatewayCall(id, retryOf) {
    const response = await fetch(`${gateway}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.secret}`, 'x-request-id': id, 'idempotency-key': id, ...(retryOf ? { 'x-retry-of-request-id': retryOf } : {}) },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'browser regression' }] }),
    });
    await response.text();
    if (response.status !== 200) throw new Error(`seed gateway call failed: HTTP ${response.status}`);
  }
  await gatewayCall(origin);
  await gatewayCall(retry, origin);
  return { adminPassword, employeePassword, origin, retry, employeeId: employee.id };
}

/* ---------------- main ---------------- */
try {
  if (!existsSync(CHROME)) throw new Error(`Chrome was not found at ${CHROME}; set CHROME_PATH to run the browser check`);
  tempDir = resolve(root, '.runtime', `web-check-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });
  const [webPort, cpPort, gatewayPort, modelPort, debugPortValue] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  debugPort = debugPortValue;
  const cp = `http://127.0.0.1:${cpPort}`, gateway = `http://127.0.0.1:${gatewayPort}`, model = `http://127.0.0.1:${modelPort}`, web = `http://127.0.0.1:${webPort}`;

  let dbEnv={};
  if(postgres){
    const require=createRequire(new URL('../apps/control-plane/package.json',import.meta.url)),{Pool}=require('pg');
    const {connectionString}=await connectionConfig();
    database=new Pool({connectionString,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,max:1});
    const candidateSchema=`agp_web_${randomUUID().replaceAll('-','')}`;
    await database.query(`create schema "${candidateSchema}"`);schema=candidateSchema;
    dbEnv={DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,STORE_MODE:'postgres',PGAPPNAME:schema};
  }

  const modelProcess = spawnNode('postman/mocks/test-model/default.js', { PORT: String(modelPort) });
  const control = spawnNode('apps/control-plane/dist/main.js', { ...dbEnv, PORT: String(cpPort), WEB_ORIGIN: web });
  const gatewayProcess = spawnNode('services/gateway-sim/dist/server.js', { PORT: String(gatewayPort), CONTROL_PLANE_URL: cp, MODEL_URL: model, WEB_ORIGIN: web, GATEWAY_JOURNAL_DIR: resolve(tempDir, 'journal') });
  await Promise.all([ready(`${model}/health`, modelProcess), ready(`${cp}/health`, control), ready(`${gateway}/health`, gatewayProcess)]);

  const employeePassword = 'Web-check-employee-2026!';
  const seeded = await seed(cp, gateway, model, employeePassword);
  if(postgres)await checkUsageAnalytics({database,schema,controlPlaneUrl:cp,seeded});

  // Build the web bundle for this isolated environment so it never points at a shared review instance.
  const vite = resolve(root, 'apps/web/node_modules/vite/bin/vite.js');
  const webEnv = { VITE_CONTROL_PLANE_URL: cp, VITE_GATEWAY_URL: gateway, VITE_REVIEW_MODE: 'true', VITE_REVIEW_STORAGE: 'memory' };
  const build = spawn(process.execPath, [vite, 'build', '--outDir', resolve(tempDir, 'web'), '--emptyOutDir'], {
    cwd: resolve(root, 'apps/web'), windowsHide: true, stdio: 'inherit',
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_'))), ...webEnv },
  });
  children.push(build);
  await new Promise((resolveDone, reject) => { build.once('exit', code => code === 0 ? resolveDone() : reject(new Error(`web build failed: ${code}`))); });
  const preview = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort', '--outDir', resolve(tempDir, 'web')], { cwd: resolve(root, 'apps/web'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...webEnv } });
  children.push(preview);
  await ready(web, preview);

  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${resolve(tempDir, 'chrome-profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--remote-allow-origins=*', '--window-size=1440,1000', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  children.push(chrome);
  let version;
  for (let i = 0; i < 120; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); break; } catch { await pause(100); }
  }
  if (!version) throw new Error('Chrome DevTools endpoint did not start');
  let page;
  try {
    page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${web}/?ui=azure`)}`, { method: 'PUT' })).json();
  } catch {
    page = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(target => target.type === 'page');
  }
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await setViewport(1440, 1000);
  await cdp.send('Page.navigate', { url: `${web}/?ui=azure` });

  check(await waitFor(`document.documentElement.dataset.ui==='azure'`, 15000), 'blue-gray review shell is active');
  await login('web-ops', seeded.adminPassword);
  check(await waitFor(`document.body.innerText.includes('运营工作台')`, 15000), 'operator reaches the operations workspace');

  if(!process.argv.includes('--model-management-only')&&!process.argv.includes('--application-billing-only')){
  // Onboarding continuity: selection survives a page switch in the same session.
  await clickNav('为人员开通');
  await waitFor(`document.body.innerText.includes('让同事开始使用 AI')`);
  const selected = await evaluate(`(()=>{const row=[...document.querySelectorAll('.person-row')].find(node=>node.textContent.includes('回归员工'));if(!row)return false;row.querySelector('input[type=checkbox]').click();return true;})()`);
  check(selected, 'onboarding person row is selectable');
  await waitFor(`document.body.innerText.includes('已选 1 人')`);
  await clickNav('模型服务');
  await clickNav('为人员开通');
  check(await waitFor(`document.body.innerText.includes('已选 1 人')`, 8000), 'onboarding selection survives a page switch');
  await screenshot('onboarding-continuity-1440.png');

  // Verification via UI, then the run detail modal.
  await clickNav('模型服务');
  await waitFor(`document.body.innerText.includes('首次接入引导')`);
  await waitFor(`[...document.querySelectorAll('#v4-sidebar')].length>=0`);
  check(await clickExact('验证连接'), 'model service verify action is present');
  check(await waitFor(`document.body.innerText.includes('最近一次连接验证')`, 20000), 'verification result is shown with its metering notice');
  check(await clickExact('查看逐协议诊断'), 'verification run detail action is present');
  check(await waitFor(`document.querySelector('dialog.modal[open]')?.innerText.includes('上游请求号')`, 8000), 'verification detail shows the upstream request id column');
  await pressKey('Escape');
  await waitFor(`!document.querySelector('dialog.modal[open]')`);
  check(true, 'verification detail closes with Escape');
  check(await clickExact('验证记录'), 'verification history action is present');
  check(await waitFor(`document.querySelector('dialog.modal[open]')?.innerText.includes('连接验证记录')`, 8000), 'verification history modal opens');
  check(await evaluate(`[...document.querySelectorAll('dialog.modal[open] tbody tr')].length>=2`), 'verification history lists previous runs');
  await pressKey('Escape');
  await waitFor(`!document.querySelector('dialog.modal[open]')`);
  await screenshot('model-verification-1440.png');

  // Entitlement migration through the existing preview/confirm flow.
  await clickNav('为人员开通');
  await waitFor(`document.body.innerText.includes('让同事开始使用 AI')`);
  await evaluate(`(()=>{[...document.querySelectorAll('summary')].find(node=>node.textContent.includes('开通设置与记录'))?.click();return true;})()`);
  check(await waitFor(`[...document.querySelectorAll('button')].some(node=>node.textContent.trim()==='迁移版本')`, 8000), 'per-entitlement migration action is present');
  check(await clickExact('迁移版本'), 'migration editor opens from the entitlement list');
  await waitFor(`document.querySelector('dialog.modal[open]')?.innerText.includes('迁移存量权益到当前方案版本')`);
  await evaluate(`(()=>{const el=[...document.querySelectorAll('dialog.modal[open] textarea')].at(-1);const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(el,'浏览器回归：统一到当前版本');el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  check(await clickExact('继续'), 'migration editor submits to preview');
  check(await waitFor(`[...document.querySelectorAll('dialog.modal[open]')].some(dialog=>dialog.innerText.includes('不补发额度'))`, 12000), 'migration preview states that no quota is backfilled');
  check(await evaluate(`[...document.querySelectorAll('dialog.modal[open]')].some(dialog=>dialog.innerText.includes('v1 → v2'))`), 'migration preview shows the version change');
  await screenshot('entitlement-migration-preview-1440.png');
  check(await clickExact('确认执行'), 'migration confirmation executes');
  await waitFor(`!document.querySelector('dialog.modal[open]')`, 15000);
  const migratedVersion = await evaluate(`fetch(${JSON.stringify(`${cp}/api/v1/platform/state`)},{credentials:'include'}).then(response=>response.json()).then(state=>state.entitlements.map(entry=>entry.planVersion))`);
  check(Array.isArray(migratedVersion) && migratedVersion.every(version => version === 2), 'migration updates the entitlement version through the API');

  // Usage cockpit: the operator-only aggregation page must render from the
  // analytics endpoint and never print NaN or a fabricated zero.
  await evaluate(`(()=>{
    const fetchReal=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      const response=await fetchReal(...args);
      if(String(args[0]).endsWith('/api/v1/platform/analytics/usage')&&response.ok)window.__usageLiveReport=await response.clone().json();
      return response;
    };
  })()`);
  check(await evaluate(`(()=>{const el=[...document.querySelectorAll('#v4-sidebar button, aside button, nav button')].find(node=>node.textContent.replace(/\\s+/g,' ').trim().includes('用量驾驶舱'));if(!el)return false;el.click();return true;})()`), 'usage cockpit is reachable from the operator navigation');
  check(await waitFor(`!!document.querySelector('.usage-cockpit')`, 15000), 'usage cockpit page renders');
  check(await waitFor(`!!document.querySelector('.usage-cockpit .metric, .usage-cockpit .empty-state')`, 20000), 'usage cockpit shows either metrics or its empty state');
  const cockpitText = await evaluate(`document.querySelector('.usage-cockpit').innerText`);
  check(!/NaN|undefined/.test(cockpitText), 'usage cockpit prints no NaN or undefined');
  check(/已结束调用/.test(cockpitText), 'usage cockpit states the ended-call basis');
  // Observe the real HTTP response and the actual Blob emitted by the export
  // button; no analytics response is replaced during this portion of the check.
  const liveReport=await evaluate('window.__usageLiveReport');
  check(liveReport?.totals.requests>=2,'real analytics includes the seeded gateway calls');
  const csvText=await evaluate(`(async()=>{
    const create=URL.createObjectURL.bind(URL),prevent=event=>{if(event.target instanceof HTMLAnchorElement&&event.target.download)event.preventDefault();};
    document.addEventListener('click',prevent,true);
    let csv;
    URL.createObjectURL=blob=>{csv=blob.arrayBuffer().then(buffer=>new TextDecoder('utf-8',{ignoreBOM:true}).decode(buffer));return create(blob);};
    try{[...document.querySelectorAll('.usage-cockpit button')].find(button=>button.textContent==='导出 CSV').click();return await csv;}
    finally{URL.createObjectURL=create;document.removeEventListener('click',prevent,true);}
  })()`);
  check(typeof csvText==='string'&&csvText.charCodeAt(0)===0xfeff,'CSV is exported from the actual page with a UTF-8 BOM');
  const csvRows=csvText.slice(1).trim().split('\r\n').map(line=>line.split(','));
  check(csvRows.every(row=>row.length===15),'real CSV has 15 columns on every row');
  const total=csvRows.find(row=>row[0]==='合计');
  check(Number(total?.[3])===liveReport.totals.requests&&Number(total?.[8])===liveReport.totals.confirmedAmount,'CSV total matches the real analytics response');
  for(const labels of [['人员','应用'],['项目'],['模型'],['组织'],['自然日']]){
    const rows=csvRows.slice(1).filter(row=>labels.includes(row[0]));
    check(rows.reduce((sum,row)=>sum+Number(row[3]),0)===liveReport.totals.requests,`real CSV requests close for ${labels.join('/')}`);
    check(Math.abs(rows.reduce((sum,row)=>sum+Number(row[8]),0)-liveReport.totals.confirmedAmount)<0.0000001,`real CSV money closes for ${labels.join('/')}`);
  }
  check(await evaluate(`Number(document.querySelector('.cockpit-rank-foot b:last-child').textContent.replace(/[^0-9.-]/g,''))===window.__usageLiveReport.totals.confirmedAmount`),'real cockpit total matches HTTP and CSV');
  await screenshot('usage-live-1440.png');
  await setViewport(390, 844);
  await pause(300);
  const cockpitWidth = await evaluate(`({doc:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})`);
  check(cockpitWidth.doc <= cockpitWidth.client + 1, 'usage cockpit does not overflow at 390');
  await screenshot('usage-live-390.png');
  await setViewport(1440, 1000);
  await pause(200);
  await clickNav('排行榜');
  await waitFor(`!!document.querySelector('.usage-leaderboard button.primary:not([disabled])')&&document.querySelector('.usage-leaderboard .detail-list dd')?.textContent!=='—'`,20000);
  check(await evaluate(`Number(document.querySelector('.usage-leaderboard .detail-list dd').textContent.replace(/[^0-9.-]/g,''))===window.__usageLiveReport.totals.confirmedAmount`),'real leaderboard total matches HTTP and CSV');
  await screenshot('usage-leaderboard-live-1440.png');
  await clickNav('用量驾驶舱');

  // Only the browser receives these fixtures: the isolated workspace and API
  // remain real. Include an expired caller, an entitled non-caller and a costly
  // historical identity so incorrect cohorts cannot pass as plausible numbers.
  await evaluate(`(async()=>{
    window.__usageRealFetch=window.fetch.bind(window);
    const snapshot=await window.__usageRealFetch(${JSON.stringify(`${cp}/api/v1/platform/state`)},{credentials:'include'}).then(r=>r.json());
    const sample=snapshot.entitlements[0];
    snapshot.entitlements=[
      {...sample,id:'usage-active',memberId:snapshot.actor.id,status:'active',expiresAt:'2099-01-01T00:00:00Z'},
      {...sample,id:'usage-expired',memberId:${JSON.stringify(seeded.employeeId)},status:'active',expiresAt:'2000-01-01T00:00:00Z'}
    ];
    const bucket=(key,amount)=>({key,requests:1,unknownUsage:0,inputTokens:10,outputTokens:20,cachedInputTokens:0,confirmedAmount:amount,pendingReview:0,pendingAmount:0,errors:0,forwarded:1,upstreamFailures:0,lastActiveAt:new Date().toISOString()});
    const person=bucket(${JSON.stringify(seeded.employeeId)},1),historical=bucket('usage-missing-person',999);
    window.__usageFixture={from:new Date(Date.now()-7*86400000).toISOString(),to:new Date().toISOString(),timezone:'Asia/Shanghai',
      totals:{...bucket('',1000),requests:2,activePeople:2,activeApplications:0},people:[historical,person],
      applications:[],projects:[],models:[],organizations:[],days:[],collectedAt:new Date().toISOString()};
    window.__usageMode='success';
    window.fetch=async(input,init)=>{
      const url=String(input instanceof Request?input.url:input);
      if(url.endsWith('/api/v1/platform/state'))return new Response(JSON.stringify(snapshot),{headers:{'content-type':'application/json'}});
      if(!url.endsWith('/api/v1/platform/analytics/usage'))return window.__usageRealFetch(input,init);
      if(window.__usageMode==='delay')await new Promise(resolve=>{window.__usageRelease=resolve;});
      if(window.__usageMode==='error')return new Response(JSON.stringify({message:'usage fixture unavailable'}),{status:503,headers:{'content-type':'application/json'}});
      return new Response(JSON.stringify(window.__usageFixture),{headers:{'content-type':'application/json'}});
    };
  })()`);
  await clickNav('项目');
  check(await clickExact('刷新数据'), 'workspace refresh is available for the cohort fixture');
  await clickNav('用量驾驶舱');
  const usageRoot = '.v2-page-enter:not([hidden]) .usage-cockpit';
  check(await waitFor(`document.querySelector(${JSON.stringify(usageRoot+' .gauge-caption')})?.textContent.includes('0%')`), 'expired callers do not inflate currently entitled activity');
  check(await evaluate(`document.querySelector(${JSON.stringify(usageRoot+' .gauge-boxes')}).textContent.includes('1')`), 'the entitled non-caller remains in the inactive cohort');
  check(await evaluate(`document.querySelector(${JSON.stringify(usageRoot+' .cockpit-rank')}).textContent.includes('回归员工')&&!document.querySelector(${JSON.stringify(usageRoot+' .cockpit-rank')}).textContent.includes('未识别身份')`), 'historical identities are excluded from cockpit ranks');
  check(await evaluate(`document.querySelector(${JSON.stringify(usageRoot+' .cockpit-area-quality')}).textContent.includes('1 次请求 / 1 个主体')`), 'historical usage remains in data quality');
  check(await evaluate(`document.querySelector(${JSON.stringify(usageRoot+' .cockpit-rank-foot')}).textContent.includes('1,000')`), 'historical money remains in the report total');
  await screenshot('usage-fixed-1440.png');
  await setViewport(390, 844);
  check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'), 'corrected usage cockpit fits at 390px');
  await screenshot('usage-fixed-390.png');
  await setViewport(1440, 1000);

  // A query in progress and a failed query must both invalidate the old report.
  await evaluate(`window.__usageMode='delay';document.querySelector(${JSON.stringify(usageRoot+' form')}).requestSubmit()`);
  await waitFor(`typeof window.__usageRelease==='function'`);
  check(await evaluate(`!document.querySelector(${JSON.stringify(usageRoot+' .metric')})&&[...document.querySelectorAll(${JSON.stringify(usageRoot+' button')})].find(b=>b.textContent==='导出 CSV').disabled`), 'loading clears previous numbers and disables CSV');
  await evaluate(`window.__usageMode='error';window.__usageRelease()`);
  await waitFor(`document.querySelector(${JSON.stringify(usageRoot+' [role=alert]')})?.textContent.includes('当前数字不可用')`);
  check(await evaluate(`!document.querySelector(${JSON.stringify(usageRoot+' .metric')})&&[...document.querySelectorAll(${JSON.stringify(usageRoot+' button')})].find(b=>b.textContent==='导出 CSV').disabled`), 'a failed query cannot display or export old data');
  await screenshot('usage-fixed-error-1440.png');
  await evaluate(`window.__usageMode='success';document.querySelector(${JSON.stringify(usageRoot+' form')}).requestSubmit()`);
  await waitFor(`!!document.querySelector(${JSON.stringify(usageRoot+' .metric')})`);
  check(await evaluate(`![...document.querySelectorAll(${JSON.stringify(usageRoot+' button')})].find(b=>b.textContent==='导出 CSV').disabled`), 'a successful retry restores CSV');

  // Keep a draft filter and rank choice across mounted page tabs.
  await evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(usageRoot+' select')});select.value=select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true}));window.__usageDraft=select.value;})()`);
  await clickNav('排行榜');
  await waitFor(`!!document.querySelector('.usage-leaderboard tbody tr')`);
  check(await evaluate(`document.querySelector('.usage-leaderboard tbody').textContent.includes('回归员工')&&!document.querySelector('.usage-leaderboard tbody').textContent.includes('未识别身份')`), 'leaderboard also excludes historical people');
  await evaluate(`document.querySelector('.usage-leaderboard .cockpit-seg button:last-child').click()`);
  await clickNav('项目');
  check(await evaluate(`['用量驾驶舱','排行榜'].every(label=>[...document.querySelectorAll('.v4-tab-select')].some(b=>b.textContent.trim()===label))`), 'analytics page tabs survive navigation');
  await clickNav('用量驾驶舱');
  check(await evaluate(`document.querySelector(${JSON.stringify(usageRoot+' select')}).value===window.__usageDraft`), 'usage filter draft survives tab switches');
  await clickNav('排行榜');
  check(await evaluate(`document.querySelector('.usage-leaderboard .cockpit-seg button:last-child').getAttribute('aria-pressed')==='true'`), 'leaderboard metric survives tab switches');
  await clickNav('用量驾驶舱');
  await evaluate(`document.querySelector('.cockpit-area-org [role=tab]:nth-child(2)').click()`);
  await waitFor(`document.querySelector('.cockpit-area-org [role=tab][aria-selected=true]')?.textContent==='项目'`);
  await evaluate(`document.querySelector('.cockpit-area-org .link-button').click()`);
  check(await waitFor(`document.querySelector('.usage-leaderboard [role=tab][aria-selected=true]')?.textContent.includes('项目')`), 'a retained leaderboard follows a new dimension target');

  for(const label of ['浅色驾驶舱','深蓝驾驶舱','大屏驾驶舱']){
    await clickNav(label);
    await waitFor(`!!document.querySelector('.v2-page-enter:not([hidden]) .dc-rank')`);
    check(await evaluate(`!document.querySelector('.v2-page-enter:not([hidden]) .dc-rank').textContent.includes('未识别身份')`), label+' excludes historical people');
    await clickNav('项目');
    check(await evaluate(`[...document.querySelectorAll('.v4-tab-select')].some(b=>b.textContent.trim()===${JSON.stringify(label)})`), label+' retains its page tab');
  }
  // Verify the normal keyboard path reaches the shared date picker.
  await clickNav('用量驾驶舱');
  await evaluate(`document.querySelector(${JSON.stringify(usageRoot+' .date-field-trigger')}).focus()`);
  await pressKey('ArrowDown');
  check(await waitFor(`!!document.querySelector(${JSON.stringify(usageRoot+' .date-panel')})`), 'keyboard opens the usage date picker');
  await pressKey('Escape');
  check(await evaluate(`document.activeElement?.classList.contains('date-field-trigger')`), 'Escape returns focus to the date trigger');
  await evaluate(`window.fetch=window.__usageRealFetch`);

  // Employee view: call tracing and related retry.
  await evaluate(`fetch(${JSON.stringify(`${cp}/api/v1/auth/logout`)},{method:'POST',credentials:'include'}).then(()=>true)`);
  await cdp.send('Page.navigate', { url: `${web}/?ui=azure` });
  await login('web-employee', seeded.employeePassword);
  await clickNav('调用记录');
  check(await waitFor(`document.body.innerText.includes(${JSON.stringify(seeded.retry.slice(0, 20))})`, 15000), 'employee sees their own retried call');
  await evaluate(`(()=>{const button=[...document.querySelectorAll('button.code-button')].find(node=>node.textContent.includes(${JSON.stringify(seeded.retry.slice(0, 20))}));button?.click();return !!button;})()`);
  await waitFor(`document.querySelector('dialog.modal[open]')?.innerText.includes('调用详情')`);
  const detailText = await evaluate(`document.querySelector('dialog.modal[open]').innerText`);
  check(detailText.includes('上游请求号') && detailText.includes(`upstream-${seeded.retry}`), 'call detail shows the upstream request id');
  check(detailText.includes(seeded.origin), 'call detail shows the related original request id');
  check(await clickExact('查看原调用与重试'), 'related-call action is available');
  check(await waitFor(`document.querySelector('dialog.modal[open]')?.innerText.includes('关联调用')`, 8000), 'related-call modal opens');
  const relatedText = await evaluate(`document.querySelector('dialog.modal[open]').innerText`);
  check(relatedText.includes('原调用') && relatedText.includes('显式重试'), 'related-call modal separates the original from the retry');
  await screenshot('call-tracing-1440.png');
  await pressKey('Escape');
  await waitFor(`!document.querySelector('dialog.modal[open]')`);

  // Shell regressions for every design. `beacon` reuses the v4 shell, so it must
  // paint data-layout="sidebar" and offer the same five-design switch.
  for (const [mode, ui, layout, label] of [
    ['sidebar', 'next', 'sidebar', '左栏'],
    ['next', 'next', 'next', '顶栏'],
    ['classic', 'classic', 'classic', '经典'],
    ['azure', 'azure', 'sidebar', '蓝灰'],
    ['beacon', 'beacon', 'sidebar', '信标'],
  ]) {
    await cdp.send('Page.navigate', { url: `${web}/?ui=${mode}` });
    check(await waitFor(`document.documentElement.dataset.ui===${JSON.stringify(ui)}`, 15000), `shell ${mode} paints data-ui=${ui}`);
    check(await waitFor(`document.documentElement.dataset.layout===${JSON.stringify(layout)}`, 15000), `shell ${mode} paints data-layout=${layout}`);
    check(await waitFor(`document.body.innerText.length>20`), `shell ${mode} renders`);
    const designs = await evaluate(`[...document.querySelectorAll('.design-switch button')].filter(b=>b.getClientRects().length>0).map(b=>[b.textContent.trim(),b.getAttribute('aria-pressed')])`);
    check(designs.length === 5, `shell ${mode} offers five designs (${designs.map(d=>d[0]).join('/')})`);
    check(designs.filter(d=>d[1]==='true').length === 1 && designs.find(d=>d[1]==='true')[0] === label, `shell ${mode} marks only ${label} as pressed`);
  }
  await cdp.send('Page.navigate', { url: `${web}/?ui=azure` });
  await waitFor(`document.body.innerText.includes('调用记录')`, 15000);
  await clickNav('调用记录');

  // Horizontal overflow at the documented widths.
  for (const width of [320, 360, 736, 1024, 1440]) {
    await setViewport(width, width <= 760 ? 844 : 1000);
    await pause(250);
    const overflow = await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    check(overflow <= 0, `no page-level horizontal overflow at ${width}px (${overflow})`);
  }

  // Mobile drawer focus trap and Escape return.
  await setViewport(390, 844);
  await waitFor(`!!document.querySelector('.v4-menu-button')`);
  await evaluate(`document.querySelector('.v4-menu-button').click()`);
  await waitFor(`document.querySelector('#v4-sidebar')?.getAttribute('role')==='dialog'`);
  check(await evaluate(`document.querySelector('#v4-sidebar').contains(document.activeElement)`), 'mobile drawer moves focus inside');
  await evaluate(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));return true;})()`);
  check(await evaluate(`document.querySelector('#v4-sidebar').contains(document.activeElement)`), 'Tab stays inside the mobile drawer');
  await evaluate(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;})()`);
  await waitFor(`document.querySelector('#v4-sidebar')?.getAttribute('role')!=='dialog'`, 5000);
  await pause(120);
  check(await evaluate(`document.activeElement?.classList.contains('v4-menu-button')`), 'Escape closes the drawer and returns focus to the menu button');
  await screenshot('calls-mobile-390.png');

  check(cdp.runtimeErrors.length === 0, `no uncaught browser exceptions (${cdp.runtimeErrors.join(' | ')})`);
  if(process.argv.includes('--demo')){
    const options={controlPlaneUrl:cp,gatewayUrl:gateway,modelUrl:model,workspaceId:schema??randomUUID(),createdAt:new Date().toISOString(),operatorLogin:'web-ops',operatorPassword:seeded.adminPassword};
    const demo=await prepareBusinessDemo(options);
    await setViewport(1440,1000);
    await rehearseBusinessDemo({evaluate,waitFor,clickNav,clickExact,setInput,screenshot,login,navigate:url=>cdp.send('Page.navigate',{url}),controlPlaneUrl:cp,webUrl:web,manifest:demo});
    check(cdp.runtimeErrors.length===0,'demo rehearsal has no uncaught browser exceptions');
  }
  }
  if(process.argv.includes('--model-management-only'))await checkModelManagement({cp,web,seeded,cdp,evaluate,waitFor,clickExact,setInput,pressKey,setViewport,screenshot,login,check});
  if(process.argv.includes('--model-management-only')){await mkdir(screenshotDir,{recursive:true});await writeFile(resolve(screenshotDir,'browser.json'),JSON.stringify({checkedAt:new Date().toISOString(),storage:postgres?'isolated-postgres':'memory',assertionCount:assertions.length,assertions,uncaughtErrors:cdp.runtimeErrors},null,2)+'\n');}
  if(process.argv.includes('--application-billing')||process.argv.includes('--application-billing-only'))await checkApplicationBilling({cp,gateway,web,seeded,cdp,evaluate,waitFor,clickNav,clickExact,setInput,pressKey,setViewport,screenshot,login,check});
  console.log(`PASS ${assertions.length} browser assertions (${postgres?'isolated PostgreSQL':'memory'}; real API/CSV plus fault fixtures)`);
  console.log(`Screenshots: ${screenshotDir}`);
} catch (error) {
  try {
    if (cdp) {
      const body = await cdp.evaluate('document.body.innerText.slice(0,1500)');
      if (body) console.error(`Page text at failure:\n${body}`);
      await screenshot('failure.png');
    }
  } catch { /* keep the original failure */ }
  const diagnostics = children.map(child => child.diagnostic?.() ?? '').filter(Boolean).join('\n');
  if (diagnostics && process.env.DEBUG_WEB_CHECK === '1') console.error(diagnostics.slice(-6000));
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await stopAll();
}
