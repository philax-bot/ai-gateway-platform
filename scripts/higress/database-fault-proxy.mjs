import {createServer,connect} from 'node:net';
/** Interrupt only this test control plane's PostgreSQL TCP connections. */
export async function databaseFaultProxy(connectionString){
 const target=new URL(connectionString),sockets=new Set();let blocked=false,interrupted=0;
 const server=createServer(client=>{
  if(blocked){client.destroy();return;}
  const upstream=connect({host:target.hostname,port:Number(target.port||5432)});sockets.add(client);sockets.add(upstream);
  const close=()=>{sockets.delete(client);sockets.delete(upstream);client.destroy();upstream.destroy();};
  client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);client.pipe(upstream);upstream.pipe(client);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address=new URL(connectionString);address.hostname='127.0.0.1';address.port=String(server.address().port);
 return {connectionString:address.toString(),block(){blocked=true;interrupted+=sockets.size/2;for(const socket of sockets)socket.destroy();},restore(){blocked=false;},snapshot:()=>({blocked,interruptedConnections:interrupted}),close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
