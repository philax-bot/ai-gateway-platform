// Development only: authenticate access to the all-in-one's loopback Kubernetes API.
// The relay shares Higress's network namespace; it never executes container commands.
const http=require('node:http'),https=require('node:https'),{timingSafeEqual}=require('node:crypto');
const {inspectRuntime}=require('./runtime-readiness.cjs');
const expected=Buffer.from('Bearer '+process.env.API_TOKEN);
http.createServer((req,res)=>{
  const actual=Buffer.from(req.headers.authorization||'');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){res.writeHead(401);res.end('{}');return;}
  if(req.url==='/health'){res.end('{}');return;}
  const readiness=/^\/runtime\/ready\/(atlas-[a-f0-9]{32})$/.exec(req.url);
  if(req.method==='GET'&&readiness){void inspectRuntime(readiness[1]).then(value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));});return;}
  if(!['GET','POST','PUT'].includes(req.method)||!/^\/apis\/(networking\.k8s\.io\/v1|networking\.higress\.io\/v1|extensions\.higress\.io\/v1alpha1)\/namespaces\/higress-system\/(ingresses|mcpbridges|wasmplugins)(\/(atlas-[a-z0-9-]+|default))?$/.test(req.url)||(req.method==='PUT'&&!req.url.endsWith('/mcpbridges/default')&&!req.url.endsWith('/wasmplugins/atlas-ai-proxy'))){res.writeHead(403);res.end('{}');return;}
  // TLS exception is confined to the bundled self-signed API on the same loopback.
  const upstream=https.request({hostname:'127.0.0.1',port:18443,path:req.url,method:req.method,rejectUnauthorized:false,headers:{'content-type':'application/json'}},response=>{res.writeHead(response.statusCode,{'content-type':'application/json'});response.pipe(res);});
  upstream.setTimeout(4500,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end('{}');});
  req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
}).listen(19090,'0.0.0.0');

// A private SSH stream-local reverse forward reaches the Windows loopback fixture.
// No Windows listener is exposed to the VM or LAN.
if(process.env.LOCAL_MODEL_RELAY==='true')http.createServer((req,res)=>{
  const upstream=http.request({socketPath:'/host-relay/model.sock',method:req.method,path:req.url,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end('{}');});req.on('aborted',()=>upstream.destroy());res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});req.pipe(upstream);
}).listen(8111,'127.0.0.1');
