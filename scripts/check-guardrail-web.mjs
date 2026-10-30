import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
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

const root=process.cwd(),directory=await realpath(process.argv[2]);assert.ok(directory.startsWith(await realpath(resolve(root,'.runtime'))+sep+'guardrail-'));
const session=JSON.parse(await readFile(resolve(directory,'session.json'),'utf8'));assert.match(session.web,/^http:\/\/127\.0\.0\.1:\d+$/);
const output=resolve(root,'docs/validation/guardrail-2026-10-30');await mkdir(output,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms)),checks=[],report={success:false,checks};
const check=(value,label)=>{assert.ok(value,label);checks.push(label);};let chrome,cdp;
const evaluate=expression=>cdp.evaluate(expression);
async function waitFor(expression){for(let i=0;i<150;i++){try{if(await evaluate(expression))return;}catch{}await pause(100);}throw Error('browser condition timed out: '+expression);}
const click=async label=>{await waitFor(`!![...document.querySelectorAll('button,a,summary')].find(e=>e.getClientRects().length&&!e.disabled&&e.textContent.replace(/\\s+/g,' ').trim()===${JSON.stringify(label)})`);return evaluate(`(()=>{const e=[...document.querySelectorAll('button,a,summary')].find(e=>e.getClientRects().length&&e.textContent.replace(/\s+/g,' ').trim()===${JSON.stringify(label)});if(!e)throw Error('missing button '+${JSON.stringify(label)});e.focus();e.click();return true;})()`);};
async function input(label,value){return evaluate(`(()=>{const l=[...document.querySelectorAll('dialog[open] label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(label)}));const e=l&&(document.getElementById(l.htmlFor)||l.querySelector('input,textarea,select'));if(!e)throw Error('missing field '+${JSON.stringify(label)});const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement:e.tagName==='SELECT'?HTMLSelectElement:HTMLInputElement;Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true;})()`);}
async function key(key,shift=false){for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:key==='Escape'?27:9,modifiers:shift?8:0});await pause(80);}
async function screenshot(name){await pause(300);const {data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(resolve(output,name+'.png'),Buffer.from(data,'base64'));}
async function viewport(width,height){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<760});await pause(300);}
async function login(role){await cdp.send('Page.navigate',{url:session.web+'/?ui=beacon'});await waitFor(`!!document.querySelector('input[autocomplete="username"]')`);const a=session.accounts[role];await evaluate(`(()=>{for(const [s,v]of ${JSON.stringify([['input[autocomplete="username"]',a.directoryId],['#login-password',a.password]])}){const e=document.querySelector(s);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));}})()`);await click('登录');await waitFor(`document.body.innerText.includes(${JSON.stringify(a.name)})`);await pause(300);}
async function logout(){check(await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&(/退出/.test(e.getAttribute('aria-label')||e.title||'')||e.textContent.trim()==='退出登录'));if(!e)return false;e.click();return true;})()`),'logout control present');await waitFor(`!!document.querySelector('input[autocomplete="username"]')`);}
async function configure(mode){await click('调整策略');await waitFor(`!!document.querySelector('dialog[open]')`);await evaluate(`(()=>{const l=[...document.querySelectorAll('dialog[open] label')].find(l=>l.textContent.trim()===${JSON.stringify(mode)});l.querySelector('input[type=radio]').click();})()`);await input('变更原因','合成数据浏览器验收');await click('核对策略影响');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);check(await evaluate(`document.querySelector('dialog:last-of-type').innerText.includes('仅影响后续准入')`),'server preview explains safety and billing impact');await screenshot('policy-preview-1440');await click('确认执行');await waitFor(`!document.querySelector('dialog[open]')`);await waitFor(`document.body.innerText.includes('输入安全策略已保存')`);await waitFor(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='规则试测'&&!b.disabled)`);}
try{
  const port=await freePort();chrome=spawn(process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions',`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${resolve(directory,'chrome-profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let target;for(let i=0;i<100;i++){try{target=(await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())).find(t=>t.type==='page');if(target)break;}catch{}await pause(100);}assert.ok(target);cdp=await connectCdp(target.webSocketDebuggerUrl);await cdp.send('Network.clearBrowserCookies');await cdp.send('Runtime.enable');await cdp.send('Page.enable');await viewport(1440,1000);
  await login('operator');await click('安全围栏');await waitFor(`document.body.innerText.includes('输入安全策略')`);if(!await evaluate(`document.body.innerText.includes('当前未启用输入防护')`))await configure('关闭');check(await evaluate(`document.body.innerText.includes('当前未启用输入防护')`),'initial policy explicitly off');await screenshot('initial-1440');
  await configure('仅记录');check(await evaluate(`document.body.innerText.includes('仅记录')`),'observe policy saved through UI');
  await click('规则试测');await waitFor(`!!document.querySelector('dialog[open]')`);await input('合成测试文本','合成号码 13800138000');await click('检查合成文本');await waitFor(`!document.querySelector('dialog[open]')&&document.body.innerText.includes('命中 1 条')`);check(true,'synthetic trial returns rule identifiers');await screenshot('trial-1440');
  await configure('拦截');await logout();await login('employee');check(!await evaluate(`!![...document.querySelectorAll('nav button')].find(e=>e.textContent.includes('安全围栏'))`),'employee has no safety administration navigation');await click('在线使用');await waitFor(`!!document.querySelector('textarea')`);
  await evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'合成号码 13800138000');e.dispatchEvent(new Event('input',{bubbles:true}));const t=document.querySelector('input[type=number]');if(t){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(t,'32');t.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await waitFor(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='发送'&&!b.disabled)`);await click('发送');await waitFor(`document.body.innerText.includes('输入被企业安全策略拦截')`);check(await evaluate(`document.body.innerText.includes('未发送给模型，未扣费')&&document.body.innerText.includes('请求编号')`),'employee sees safety rejection and zero fee');await screenshot('blocked-1440');
  await viewport(390,844);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'mobile blocked page no overflow');await screenshot('blocked-390');await viewport(1440,1000);
  await evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'POC_BASIC');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await waitFor(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='发送'&&!b.disabled)`);await click('发送');await waitFor(`document.body.innerText.includes('POC_BEGIN')`);check(true,'normal employee request completes through Higress');
  await logout();await login('operator');await click('安全围栏');await waitFor(`document.body.innerText.includes('已拦截')`);check(await evaluate(`document.body.innerText.includes('preset-phone')`),'operator sees event identifiers');await screenshot('events-1440');
  for(const mode of ['azure','sidebar','next','classic','beacon']){await cdp.send('Page.navigate',{url:session.web+'/?ui='+mode});await waitFor(`window.location.search==='?ui='+${JSON.stringify(mode)}&&document.readyState==='complete'`);await waitFor(`document.body.innerText.includes('让同事开始使用 AI')`);await pause(500);await click('安全围栏');await waitFor(`document.body.innerText.includes('输入安全策略')`);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),mode+' desktop no overflow');await click('调整策略');await waitFor(`!!document.querySelector('dialog[open]')`);await evaluate(`(()=>{const d=document.querySelector('dialog[open]'),a=[...d.querySelectorAll('button,input,select,textarea,[tabindex]')].filter(e=>!e.disabled&&e.tabIndex>=0&&e.getClientRects().length);a.at(-1).focus();})()`);await key('Tab');check(await evaluate(`document.querySelector('dialog[open]').contains(document.activeElement)`),mode+' Tab stays in modal');await key('Tab',true);check(await evaluate(`document.querySelector('dialog[open]').contains(document.activeElement)`),mode+' Shift+Tab stays in modal');await key('Escape');await waitFor(`!document.querySelector('dialog[open]')`);check(await evaluate(`document.activeElement.textContent==='调整策略'`),mode+' Escape restores opener');await screenshot('shell-'+mode+'-1440');}
  await viewport(390,844);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'mobile safety page no overflow');await screenshot('events-390');await click('调整策略');await waitFor(`!!document.querySelector('dialog[open]')`);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'mobile policy editor no overflow');await screenshot('policy-390');await key('Escape');await viewport(1440,1000);
  await configure('关闭');check(await evaluate(`document.body.innerText.includes('当前未启用输入防护')`),'policy can be disabled from UI');check(cdp.runtimeErrors.length===0,'no browser runtime exceptions');report.success=true;
}catch(error){report.error=error.message;try{report.page=await evaluate('document.body.innerText.slice(-5000)');await screenshot('failure');}catch{}process.exitCode=1;}
finally{await cdp?.close();if(chrome?.exitCode===null){chrome.kill();await Promise.race([new Promise(r=>chrome.once('exit',r)),pause(2000)]);}await writeFile(resolve(output,'browser.json'),JSON.stringify(report,null,2)+'\n');if(report.success)await writeFile(resolve(directory,process.env.GUARDRAIL_MANUAL_FINISH==='true'?'browser-ready.json':'finish.json'),JSON.stringify({success:true,checks}));console.log(JSON.stringify({success:report.success,checks:checks.length,error:report.error,output}));}
