import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function connect(url){
  const socket=new WebSocket(url);await new Promise((done,fail)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',fail,{once:true});});
  let sequence=0;const pending=new Map(),errors=[],listeners=new Map();
  socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails?.text??'browser exception');for(const listener of listeners.get(m.method)??[])listener(m.params);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  return {send,errors,on:(event,listener)=>{const list=listeners.get(event)??[];list.push(listener);listeners.set(event,list);},close:()=>socket.close(),evaluate:async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;}};
}
export async function verifyAgentBrowser({root,directory,cp,gw,web,password,children,report,check}){
  const chrome=process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe';if(!existsSync(chrome))throw Error('Chrome not found');
  const vite=resolve(root,'apps/web/node_modules/vite/bin/vite.js'),dist=resolve(directory,'web'),env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('VITE_'))),VITE_CONTROL_PLANE_URL:cp,VITE_GATEWAY_URL:gw,VITE_REVIEW_MODE:'true',VITE_REVIEW_STORAGE:'memory'};
  const build=spawn(process.execPath,[vite,'build','--outDir',dist,'--emptyOutDir'],{cwd:resolve(root,'apps/web'),env,windowsHide:true,stdio:'ignore'});children.push(build);await new Promise((done,fail)=>build.once('exit',c=>c===0?done():fail(Error('isolated web build failed'))));
  const preview=spawn(process.execPath,[vite,'preview','--host','127.0.0.1','--port',new URL(web).port,'--strictPort','--outDir',dist],{cwd:resolve(root,'apps/web'),env,windowsHide:true,stdio:'ignore'});children.push(preview);
  let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(web)).ok;if(ready)break;}catch{}await pause(100);}if(!ready)throw Error('web preview failed');
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const debugPort=server.address().port;await new Promise(r=>server.close(r));
  const browser=spawn(chrome,['--headless=new',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${resolve(directory,'chrome-profile')}`,'--no-first-run','--no-default-browser-check','--disable-gpu','--hide-scrollbars','--remote-allow-origins=*','--window-size=1440,1000','about:blank'],{windowsHide:true,stdio:'ignore'});children.push(browser);
  let page;for(let i=0;i<100;i++){try{page=(await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(p=>p.type==='page');if(page)break;}catch{}await pause(100);}if(!page)throw Error('owned Chrome did not start');
  const cdp=await connect(page.webSocketDebuggerUrl),evaluate=expression=>cdp.evaluate(expression);
  const wait=async(expression,ms=15000)=>{const until=Date.now()+ms;while(Date.now()<until){if(await evaluate(expression).catch(()=>false))return;await pause(100);}throw Error('browser condition timed out: '+expression);};
  const click=text=>evaluate(`(()=>{const el=[...document.querySelectorAll('button')].find(e=>!e.closest('[hidden]')&&e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!el)return false;el.click();return true;})()`);
  const fill=(selector,value,tag='HTMLInputElement')=>evaluate(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>!e.closest('[hidden]')&&e.getClientRects().length);if(!el)return false;Object.getOwnPropertyDescriptor(${tag}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  const key=async(key,shift=false)=>{const params={key,code:key,windowsVirtualKeyCode:key==='Escape'?27:key==='Tab'?9:0,modifiers:shift?8:0};await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',...params});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',...params});await pause(100);};
  const viewport=async(width,height)=>{await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<760});await pause(200);};
  const output=resolve(root,'docs/validation/octop-bridge-2026-10-28/screenshots');await mkdir(output,{recursive:true});
  const screenshot=async name=>{await pause(200);const {data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(resolve(output,name),Buffer.from(data,'base64'));};
  const noOverflow=()=>evaluate('document.documentElement.scrollWidth<=window.innerWidth+1');
  try{
    await cdp.send('Runtime.enable');await cdp.send('Page.enable');await viewport(1440,1000);await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});
    await wait('!!document.querySelector("input[autocomplete=username]")');await fill('input[autocomplete=username]','managed-bob');await fill('#login-password',password);await click('登录');
    await wait('!!document.querySelector("#v4-sidebar")');check(await click('在线 Agent'),'personal navigation opens online Agent');await wait('document.body.innerText.includes("当前会话")');
    await screenshot('agent-empty-1440.png');check(await noOverflow(),'Beacon desktop Agent has no page overflow');
    await fill('textarea','Reply MANAGED_OK','HTMLTextAreaElement');await click('发送任务');await wait('document.body.innerText.includes("MANAGED_OK")');await wait('document.body.innerText.includes("任务已结束")');check(true,'browser cookie bridges a real Octop chat without a second login');
    await screenshot('agent-reply-1440.png');
    await fill('textarea','retained draft','HTMLTextAreaElement');await click('我的额度');await click('在线 Agent');check(await evaluate('[...document.querySelectorAll("textarea")].some(e=>!e.closest("[hidden]")&&e.value==="retained draft")'),'tab navigation retains Agent draft');
    await click('停止 Agent');await wait('!!document.querySelector("dialog[open]")');check(await evaluate('document.querySelector("dialog[open]").innerText.includes("吊销")'),'stop confirmation explains Key impact');
    await key('Tab');await key('Tab',true);check(await evaluate('!!document.activeElement.closest("dialog[open]")'),'Tab and Shift+Tab stay in confirmation dialog');await key('Escape');await wait('!document.querySelector("dialog[open]")');check(await evaluate('document.activeElement.textContent.includes("停止 Agent")'),'Escape restores focus to stop action');
    await click('停止 Agent');await wait('!!document.querySelector("dialog[open]")');await click('确认操作');await wait('document.body.innerText.includes("Agent 已停止")');check(!await evaluate('document.body.innerText.includes("当前会话")'),'stop removes composer');await screenshot('agent-stopped-1440.png');
    await click('重新启动');await wait('document.body.innerText.includes("当前会话")',90000);check(true,'UI restarts the owned Octop runtime');await click('轮换专用密钥');await click('确认操作');await wait('document.body.innerText.includes("专用密钥已更新")',90000);check(true,'UI rotates the dedicated Key');
    await fill('textarea','BRIDGE_SLOW','HTMLTextAreaElement');await click('发送任务');await wait('document.body.innerText.includes("SLOW_STARTED")');check(await click('取消任务'),'UI exposes cancellation during a turn');await wait('document.body.innerText.includes("已请求取消")');await pause(1500);
    for(const shell of ['azure','sidebar','next','classic','beacon']){
      await cdp.send('Page.navigate',{url:web+'/?ui='+shell});await wait(`document.documentElement.dataset.ui===${JSON.stringify(shell==='sidebar'?'next':shell)}&&document.documentElement.dataset.layout===${JSON.stringify(['beacon','azure'].includes(shell)?'sidebar':shell)}`);await wait('document.body.innerText.includes("开始使用")');await wait('[...document.querySelectorAll("button")].some(e=>e.textContent.trim()==="在线 Agent")');await click('在线 Agent');await wait('document.body.innerText.includes("当前会话")');check(await noOverflow(),`${shell} shell renders Agent without desktop overflow`);
    }
    await viewport(390,844);check(await noOverflow(),'390px Agent has no page overflow');await screenshot('agent-mobile-390.png');
    await viewport(1440,1000);
    // UI-only fault injection: runtime and authorization are separately checked through real APIs.
    await evaluate(`(()=>{window.agentOriginalFetch=window.fetch;window.agentUiFault='disabled';window.fetch=async function(input,init){if(String(input).endsWith('/agent-instances/self')&&window.agentUiFault){if(window.agentUiFault==='loading')await new Promise(r=>setTimeout(r,1000));if(window.agentUiFault==='error')return new Response(JSON.stringify({message:'test failure'}),{status:503,headers:{'content-type':'application/json'}});if(window.agentUiFault==='disabled')return new Response(JSON.stringify({enabled:false,instance:null}),{headers:{'content-type':'application/json'}});}return window.agentOriginalFetch(input,init);};return true;})()`);
    await click('刷新状态');await wait('document.body.innerText.includes("当前环境暂未开放")');check(true,'disabled state provides explanation and no launch action');await screenshot('agent-disabled-1440.png');
    await evaluate('window.agentUiFault="error"');await click('刷新状态');await wait('!!document.querySelector("[role=alert]")');check(true,'load error is visible and refresh remains available');
    await evaluate('window.agentUiFault="loading"');await click('刷新状态');await wait('document.body.innerText.includes("正在读取 Agent 状态")');check(true,'loading state is visible');await wait('document.body.innerText.includes("当前会话")');await evaluate('window.agentUiFault=null');
    check(cdp.errors.length===0,'browser has no uncaught JavaScript errors');report.browser={success:true,shells:['beacon','azure','sidebar','next','classic'],viewports:[[1440,1000],[390,844]],screenshots:'docs/validation/octop-bridge-2026-10-28/screenshots',faultInjection:['disabled','loading','503']};
  }catch(e){await screenshot('failure.png').catch(()=>{});throw e;}finally{cdp.close();}
}
