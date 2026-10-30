const http=require('node:http'),net=require('node:net');
function admin(path){return new Promise((resolve,reject)=>{
 const req=http.get({hostname:'127.0.0.1',port:15000,path,timeout:1200},res=>{let raw='';res.on('data',chunk=>{raw+=chunk;if(raw.length>8*1024*1024)req.destroy(Error('admin_response_too_large'));});res.on('end',()=>{try{if(res.statusCode!==200)throw Error('admin_unavailable');resolve(JSON.parse(raw));}catch(error){reject(error);}});});
 req.on('timeout',()=>req.destroy(Error('admin_timeout')));req.on('error',reject);
});}
function tcp(address,port){return new Promise(resolve=>{
 if(!net.isIP(address)||!Number.isSafeInteger(port)||port<1||port>65535){resolve(false);return;}
 const socket=net.connect({host:address,port,timeout:700});let done=false;const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));
});}
/** Read-only, zero HTTP/model generation. Never returns endpoints or plugin configuration. */
async function inspectRuntime(name,{fetchAdmin=admin,connect=tcp}={}){
 if(!/^atlas-[a-f0-9]{32}$/.test(name))return {ready:false,code:'invalid_route'};
 try{
  const [routes,clusters]=await Promise.all([fetchAdmin('/config_dump?resource=dynamic_route_configs'),fetchAdmin('/clusters?format=json')]);
  const observed=(routes.configs??[]).flatMap(c=>c.route_config?.virtual_hosts??[]).flatMap(v=>v.routes??[]);
  const route=observed.find(r=>r.name===name&&r.match?.path===`/atlas/${name}/v1/chat/completions`);
  if(!route?.route?.cluster)return {ready:false,code:'route_missing'};
  if(!['responses','messages'].every(protocol=>observed.some(r=>r.name===name+'-'+protocol&&r.match?.path===`/atlas/${name}/v1/${protocol}`&&r.route?.cluster===route.route.cluster)))return {ready:false,code:'protocol_routes_missing'};
  const cluster=(clusters.cluster_statuses??[]).find(c=>c.name===route.route.cluster);
  if(!cluster)return {ready:false,code:'cluster_missing'};
  const endpoints=(cluster.host_statuses??[]).filter(h=>!h.health_status?.failed_active_health_check&&!h.health_status?.pending_dynamic_removal&&!['UNHEALTHY','DRAINING','TIMEOUT'].includes(h.health_status?.eds_health_status)).map(h=>h.address?.socket_address).filter(Boolean).slice(0,4);
  if(!endpoints.length)return {ready:false,code:'endpoints_missing'};
  const connected=await Promise.all(endpoints.map(endpoint=>connect(endpoint.address,endpoint.port_value)));
  return connected.some(Boolean)?{ready:true,code:'ready'}:{ready:false,code:'upstream_unreachable'};
 }catch{return {ready:false,code:'runtime_unavailable'};}
}
module.exports={inspectRuntime};
