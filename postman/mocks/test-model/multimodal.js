const credentialRequests=[];
const {createHash}=require('node:crypto');
// Deterministic, local-only modality fixtures. No inference and no external calls.
const jobs=new Map(),stats={embeddings:0,rerank:0,image:0,asr:0,tts:0,video:0,polls:0};
const reply=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
module.exports=async function mediaMock(req,res){
  const path=new URL(req.url,'http://local').pathname;
  if(path==='/_test/multimodal-stats'){reply(res,stats);return true;}
  if(req.method==='GET'&&path==='/_test/credential-requests'){reply(res,credentialRequests);return true;}
  const recordCredential=kind=>{credentialRequests.push({kind,hash:createHash('sha256').update(String(req.headers.authorization??'')).digest('hex')});if(credentialRequests.length>500)credentialRequests.shift();};
  const cancellation=path.match(/^\/v1\/videos\/([^/]+)\/cancel$/);
  if(req.method==='POST'&&cancellation){const job=jobs.get(cancellation[1]);if(!job){reply(res,{error:'missing'},404);return true;}recordCredential('cancel');job.cancelled=true;reply(res,{id:cancellation[1],status:'cancelled'});return true;}
  if(req.method==='GET'&&['/v1/models','/v2/models','/api/v3/models'].includes(path)){reply(res,{object:'list',data:['test-model','test-embeddings','test-rerank','test-image','test-asr','test-tts','test-video'].map(id=>({id,object:'model'}))});return true;}
  if(req.method==='GET'&&/^\/(v1\/videos|api\/v3\/contents\/generations\/tasks)\//.test(path)){
    const id=path.split('/').filter(Boolean).at(path.endsWith('/content')?-2:-1),job=jobs.get(id);if(!job){reply(res,{error:'missing'},404);return true;}
    if(path.endsWith('/content')){res.writeHead(200,{'content-type':'video/mp4'});res.end(Buffer.from('local-video-fixture'));return true;}
    recordCredential('poll');if(job.cancelled){reply(res,{id,status:'cancelled'});return true;}
    stats.polls++;job.polls++;const done=job.polls>=2;reply(res,{id,status:done?'completed':'in_progress',progress:done?100:50,...(done&&!job.unknown?{seconds:job.seconds}:{}),url:'https://example.org/fixture.mp4'});return true;
  }
  const kind={'/v1/embeddings':'embeddings','/v1/rerank':'rerank','/v2/rerank':'rerank','/v1/images/generations':'image','/v1/audio/transcriptions':'asr','/v1/audio/speech':'tts','/v1/videos':'video','/v1/videos/generations':'video','/api/v3/contents/generations/tasks':'video'}[path];
  if(req.method!=='POST'||!kind)return false;
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks),multipart=String(req.headers['content-type']).startsWith('multipart/');
  const body=multipart?Object.fromEntries(await(new Request('http://mock',{method:'POST',headers:{'content-type':req.headers['content-type']},body:raw})).formData()):JSON.parse(raw.toString());
  recordCredential(kind);stats[kind]++;res.setHeader('x-request-id','media-upstream-'+req.headers['x-request-id']);
  if(body.model!=='test-'+kind){reply(res,{error:'physical model mapping mismatch'},400);return true;}
  if(body.test_scenario==='reset'){req.socket.destroy();return true;}
  if(kind==='embeddings')reply(res,{object:'list',model:body.model,data:[{object:'embedding',index:0,embedding:[0.1,0.2,0.3]}],usage:{prompt_tokens:12,total_tokens:12}});
  if(kind==='rerank')reply(res,{results:[{index:0,relevance_score:0.9}],meta:{billed_units:{search_units:1}}});
  if(kind==='image')reply(res,{created:0,data:Array.from({length:Number(body.n??1)},()=>({b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='}))});
  if(kind==='asr'){if(!multipart||!(body.file instanceof Blob)){reply(res,{error:'multipart audio required'},400);return true;}reply(res,{text:'本地语音识别测试',...(body.test_scenario==='unknown'?{}:{duration:2.5})});}
  if(kind==='tts'){res.writeHead(200,{'content-type':'audio/wav'});const wav=Buffer.alloc(44+32000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);res.end(wav);}
  if(kind==='video'){const id='vendor-'+require('node:crypto').randomUUID();jobs.set(id,{polls:0,seconds:Number(body.seconds??body.duration??5),unknown:body.test_scenario==='unknown'});reply(res,{id,status:'queued'});}
  return true;
};
