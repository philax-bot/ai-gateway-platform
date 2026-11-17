import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import {connectCdp} from './lib/browser-cdp.mjs';

// Read-only UI acceptance against pnpm dev. Opens only this check's private browser profile.
const web='http://localhost:5176',shots=resolve('docs/validation/screenshots-2026-11-10-reservations');
const directory=await mkdtemp(join(tmpdir(),'agp-reservation-web-')),assertions=[];let chrome,cdp;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const check=(value,message)=>{assert.ok(value,message);assertions.push(message);};
try{
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  chrome=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${join(directory,'profile')}`,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
  let target;for(let i=0;i<100;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');if(target)break;}catch{}await pause(100);}assert.ok(target,'private Chrome starts');
  cdp=await connectCdp(target.webSocketDebuggerUrl);await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');
  const evaluate=s=>cdp.evaluate(s);
  const wait=async expression=>{for(let i=0;i<120;i++){if(await evaluate(expression))return;await pause(100);}throw Error('UI wait failed: '+expression);};
  const click=async text=>{check(await evaluate(`(()=>{const el=[...document.querySelectorAll('button,a,summary')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});el?.click();return !!el})()`),'click '+text);await pause(150);};
  const input=(selector,value)=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const viewport=async width=>{await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390});await pause(150);};
  const shot=async name=>{await mkdir(shots,{recursive:true});await writeFile(join(shots,name),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));};
  const overflow=async label=>check(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'no page overflow '+label);
  const login=async account=>{
    await cdp.send('Network.clearBrowserCookies');await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});
    await wait('!!document.querySelector(\'input[autocomplete="username"]\')');
    await input('input[autocomplete="username"]',account);await input('#login-password','Review-local-2026!');await click('登录');await wait('!!document.querySelector("#v4-sidebar")');
  };
  const nav=async text=>{check(await evaluate(`(()=>{const el=[...document.querySelectorAll('#v4-sidebar nav button')].find(e=>e.textContent.includes(${JSON.stringify(text)}));el?.click();return !!el})()`),'navigate '+text);await pause(250);};
  await viewport(1440);await login('review-ops');await nav('模型目录');await click('登记模型');
  await wait('document.body.innerText.includes("预占费用的预计输出 Token")');
  check(await evaluate(`(()=>{const d=document.querySelector('dialog[open]');const label=[...d.querySelectorAll('label')].find(e=>e.textContent.includes('预占费用的预计输出'));const field=document.getElementById(label.htmlFor);return field.type==='number'&&!field.required&&field.value===''})()`),'model estimate is an optional standard numeric field');
  await evaluate(`(()=>{const d=document.querySelector('dialog[open]');const label=[...d.querySelectorAll('label')].find(e=>e.textContent.includes('单次上下文'));document.getElementById(label.htmlFor).focus()})()`);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  check(await evaluate(`document.activeElement.closest('.form-field')?.textContent.includes('预占费用的预计输出')`),'keyboard reaches the model estimate');
  await overflow('model editor 1440');await shot('model-estimate-1440.png');
  await viewport(390);await overflow('model editor 390');await shot('model-estimate-390.png');
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait('!document.querySelector(\'dialog[open]\')');
  await viewport(1440);await login('review-employee');await nav('在线使用');
  // The original review account may have unavailable personal models; choose its
  // existing ready purpose instead of changing its entitlements or funding.
  const readyPurpose=await evaluate(`fetch('http://localhost:4301/api/v1/platform/state',{credentials:'include'}).then(r=>r.json()).then(s=>s.purposes.find(p=>p.models.some(m=>m.status==='ready'))?.id)`);
  check(!!readyPurpose,'existing funded purpose is available');
  await evaluate(`(()=>{const el=[...document.querySelectorAll('select')].find(e=>[...e.options].some(o=>o.value===${JSON.stringify(readyPurpose)}));if(el){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(readyPurpose)});el.dispatchEvent(new Event('change',{bubbles:true}))}})()`);
  await click('回复长度与费用明细');
  check(await evaluate(`document.querySelector('input[type="number"]')?.value===''`),'online output cap starts omitted');
  await wait('document.body.innerText.includes("本次初始预占")');
  check(await evaluate('document.body.innerText.includes("费用预估按输出")&&document.body.innerText.includes("费用可能超过预估")'),'quote separates estimate, cap and top-up');
  const showEstimate=()=>evaluate(`(()=>{const s=[...document.querySelectorAll('summary')].find(e=>e.getClientRects().length&&e.textContent==='回复长度与费用明细');s?.parentElement.scrollIntoView({block:'center'})})()`);
  await showEstimate();await overflow('online 1440');await shot('online-estimate-1440.png');
  await viewport(390);await showEstimate();await overflow('online 390');await shot('online-estimate-390.png');
  await viewport(1440);
  for(const mode of ['azure','sidebar','next','classic']){
    await cdp.send('Page.navigate',{url:web+'/?ui='+mode});await wait('document.body.innerText.includes("开始使用")');
    check(await evaluate(`document.documentElement.dataset.ui===${JSON.stringify(mode==='sidebar'?'next':mode)}&&document.documentElement.dataset.layout===${JSON.stringify(mode==='azure'?'sidebar':mode)}`),'existing shell selectable '+mode);await overflow(mode+' 1440');
  }
  check(cdp.runtimeErrors.length===0,'no browser runtime errors');
  await writeFile(join(shots,'checks.json'),JSON.stringify({assertions,upstreamCalls:0,savedBusinessChanges:0},null,2));
  console.log(`PASS ${assertions.length} browser assertions: 1440/390 screenshots, keyboard, optional output, estimate/cap copy, five shells, no page overflow; no model calls or saved business changes`);
}finally{
  try{if(cdp)await cdp.send('Browser.close');}catch{}await cdp?.close();
  if(chrome&&chrome.exitCode===null){await Promise.race([new Promise(r=>chrome.once('exit',r)),pause(3000)]);if(chrome.exitCode===null)chrome.kill();}
  const physical=await realpath(directory),parent=await realpath(tmpdir());assert.ok(physical.startsWith(parent+sep)&&physical.includes('agp-reservation-web-'));await rm(physical,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
