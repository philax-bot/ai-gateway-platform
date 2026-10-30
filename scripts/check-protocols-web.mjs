import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,realpath,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {freePort} from './lib/higress-runtime.mjs';
async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const runtimeErrors = [];
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve: done, reject: fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`));
      else done(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'runtime exception');
    }
  });
  return {
    runtimeErrors,
    send(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP command timeout: '+method));},15000);
        pending.set(id, { resolve:value=>{clearTimeout(timer);resolve(value);}, reject:error=>{clearTimeout(timer);reject(error);} });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed');
      return result.result.value;
    },
    close() { socket.close(); return Promise.resolve(); },
  };
}

const root=process.cwd(),directory=resolve(process.argv[2]),session=JSON.parse(await readFile(resolve(directory,'session.json'),'utf8')),output=resolve(root,'docs/validation/protocols-2026-10-30'),profile=resolve(directory,'protocol-browser-'+randomUUID());
const report={success:false,checks:[]},pause=ms=>new Promise(r=>setTimeout(r,ms));let chrome,cdp;
const check=(v,l)=>{assert.ok(v,l);report.checks.push(l);};
const evaluate=e=>cdp.evaluate(e);
async function waitFor(e){for(let n=0;n<200;n++){if(await evaluate(e))return;await pause(100);}throw Error('browser condition not met: '+e);}
async function click(text){await waitFor(`!![...document.querySelectorAll('button,summary')].find(e=>e.getClientRects().length&&!e.disabled&&e.textContent.trim()===${JSON.stringify(text)})`);await evaluate(`(()=>{const e=[...document.querySelectorAll('button,summary')].find(e=>e.getClientRects().length&&!e.disabled&&e.textContent.trim()===${JSON.stringify(text)});e.focus();e.click();})()`);}
async function key(value){for(const type of['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:value,code:value,windowsVirtualKeyCode:value==='Escape'?27:9});await pause(100);}
async function viewport(width,height=1000){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<760});await pause(250);}
async function screenshot(name){const{data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(resolve(output,name+'.png'),Buffer.from(data,'base64'));}
async function navigateCatalog(){if(!await evaluate(`!![...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()==='模型目录')`))await click('配置与排查');await click('模型目录');await waitFor(`document.body.innerText.includes('模型选型与开放范围')`);}
async function openConfiguration(){await click('模型配置');await waitFor(`document.body.innerText.includes('模型准备')`);const label=await evaluate(`[...document.querySelectorAll('summary')].find(e=>e.textContent.startsWith('管理已有配置'))?.textContent`);if(label&&!await evaluate(`[...document.querySelectorAll('summary')].find(e=>e.textContent.startsWith('管理已有配置'))?.parentElement.open`))await click(label);}
try{
 await mkdir(output,{recursive:true});const port=await freePort();chrome=spawn(process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-extensions',`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});let target;for(let n=0;n<100;n++){try{target=(await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())).find(t=>t.type==='page');if(target)break;}catch{}await pause(100);}assert.ok(target);cdp=await connectCdp(target.webSocketDebuggerUrl);await cdp.send('Runtime.enable');await cdp.send('Page.enable');await viewport(1440);
 await cdp.send('Page.navigate',{url:session.web+'/?ui=beacon'});await waitFor(`!!document.querySelector('input[autocomplete="username"]')`);await evaluate(`(()=>{for(const[s,v]of ${JSON.stringify([['input[autocomplete="username"]',session.accounts.operator.directoryId],['#login-password',session.accounts.operator.password]])}){const e=document.querySelector(s);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));}})()`);await click('登录');await waitFor(`document.body.innerText.includes('配置与排查')`);await navigateCatalog();const first=await evaluate(`[...document.querySelectorAll('table button')].find(e=>e.getClientRects().length)?.textContent`);await click(first);await waitFor(`!!document.querySelector('dialog[open]')`);
 check(await evaluate(`document.querySelector('dialog').innerText.includes('此入口不支持 · Chat 适配')`),'catalog distinguishes unsupported native endpoint from Chat adaptation');check(await evaluate(`document.querySelector('dialog').innerText.includes('Responses / Messages')`),'catalog lists all three implemented protocol entries');await screenshot('catalog-detail-1440');await key('Escape');
 await openConfiguration();check(await evaluate(`document.body.innerText.includes('Responses 原生基础通过 0/1')`),'service displays current per-model native probe counts');await screenshot('service-1440');await click('验证记录');await waitFor(`!!document.querySelector('dialog[open]')`);await click('逐模型 / 协议明细');await waitFor(`document.querySelector('dialog[open]')?.innerText.includes('Chat Completions')`);
 check(await evaluate(`document.querySelector('dialog').innerText.includes('Responses')&&document.querySelector('dialog').innerText.includes('Messages')`),'diagnostic detail includes each protocol and support state');await key('Tab');check(await evaluate(`document.querySelector('dialog').contains(document.activeElement)`),'diagnostic Tab remains inside dialog');await screenshot('probe-detail-1440');await key('Escape');
 await click('验证连接');await waitFor(`document.body.innerText.includes('最近一次连接验证')&&![...document.querySelectorAll('button')].some(e=>e.textContent==='正在验证…')`);await click('查看逐协议诊断');await waitFor(`document.querySelector('dialog[open]')?.innerText.includes('Chat Completions')`);check(await evaluate(`document.querySelector('dialog table tbody').rows.length===3`),'clicking verification tests and displays exactly three protocols per mapping');await key('Escape');
 await click('编辑服务与价格');await waitFor(`!!document.querySelector('dialog[open]')`);await click('协议入口路径（按需调整）');check(await evaluate(`document.querySelector('dialog').innerText.includes('Responses 路径（可选）')&&document.querySelector('dialog').innerText.includes('Messages 路径（可选）')`),'service editor exposes same-authority protocol path overrides');await screenshot('protocol-path-editor-1440');await key('Escape');
 for(const mode of['azure','sidebar','next','classic','beacon']){await cdp.send('Page.navigate',{url:session.web+'/?ui='+mode});await waitFor(`document.readyState==='complete'&&!!document.querySelector('button[aria-current="page"]')`);await navigateCatalog();check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),mode+' catalog has no page overflow');await click(first);await waitFor(`!!document.querySelector('dialog[open]')`);await key('Tab');check(await evaluate(`document.querySelector('dialog').contains(document.activeElement)`),mode+' detail keyboard focus contained');await key('Escape');check(await evaluate(`!document.querySelector('dialog[open]')&&document.activeElement.textContent===${JSON.stringify(first)}`),mode+' Escape returns to opener');}
 await viewport(390,844);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'390 catalog has no page overflow');await click(first);await waitFor(`!!document.querySelector('dialog[open]')`);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'390 protocol detail has no page overflow');await screenshot('catalog-detail-390');await key('Escape');await openConfiguration();check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'390 service configuration has no page overflow');await screenshot('service-390');check(cdp.runtimeErrors.length===0,'no browser runtime errors');report.success=true;await writeFile(resolve(directory,'finish.json'),JSON.stringify(report));
}catch(e){report.error=e.message;try{report.page=await evaluate('document.body.innerText.slice(-3000)');await screenshot('browser-failure');}catch{}process.exitCode=1;await writeFile(resolve(directory,'finish.json'),JSON.stringify(report));}
finally{await cdp?.close();if(chrome?.exitCode===null){chrome.kill();await Promise.race([new Promise(r=>chrome.once('exit',r)),pause(2000)]);}await writeFile(resolve(output,'browser.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({success:report.success,checks:report.checks.length,error:report.error}));}
