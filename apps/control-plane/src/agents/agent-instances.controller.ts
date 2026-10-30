import {Body,Controller,Get,Header,HttpCode,Param,Post,Req,Res,UseGuards} from '@nestjs/common';
import type {ServerResponse} from 'node:http';
import {SessionGuard,sessionToken,type UserRequest} from '../platform/session.guard';
import {AgentInstancesService} from './agent-instances.service';
import {AgentChatService} from './agent-chat.service';
type StreamReply={raw:ServerResponse;hijack:()=>unknown;getHeaders:()=>Record<string,string|string[]|number|undefined>;code:(status:number)=>StreamReply;send:()=>unknown};

@Controller('/api/v1/platform/agent-instances')
@UseGuards(SessionGuard)
export class AgentInstancesController {
  constructor(private readonly instances:AgentInstancesService,private readonly chat:AgentChatService){}
  @Post('/self/chat') @HttpCode(200)
  async conversation(@Req() r:UserRequest,@Body() body:Record<string,unknown>,@Res() reply:StreamReply){
    const abort=new AbortController(),raw=reply.raw;
    const close=()=>abort.abort();raw.on('close',close);
    try{
      await this.chat.stream(r.actor.id,sessionToken(r),body,{signal:abort.signal,emit:event=>{
        if(raw.destroyed)return;
        if(!raw.headersSent){reply.hijack();raw.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no',...Object.fromEntries(Object.entries(reply.getHeaders()).filter(([k])=>k.toLowerCase().startsWith('access-control-')))});}
        if(!raw.write(`data: ${JSON.stringify(event)}\n\n`))abort.abort();
      }});
      if(!raw.headersSent)reply.code(204).send();else raw.end();
    }finally{raw.removeListener('close',close);}
  }
  @Get('/self') self(@Req() r:UserRequest){return this.instances.get(r.actor.id);}
  @Get('/:id') get(@Req() r:UserRequest,@Param('id') id:string){return this.instances.get(r.actor.id,id);}
  @Post('/self/ensure') @HttpCode(200)
  ensure(@Req() r:UserRequest,@Body() body:Record<string,unknown>){return this.instances.change(r.actor.id,'ensure',body);}
  @Post('/:id/rotate-key') @HttpCode(200)
  rotate(@Req() r:UserRequest,@Param('id') id:string,@Body() body:Record<string,unknown>){return this.instances.change(r.actor.id,'rotate',body,id);}
  @Post('/:id/stop') @HttpCode(200)
  stop(@Req() r:UserRequest,@Param('id') id:string,@Body() body:Record<string,unknown>){return this.instances.change(r.actor.id,'stop',body,id);}
  @Post('/:id/access') @HttpCode(200) @Header('Cache-Control','no-store')
  access(@Req() r:UserRequest,@Param('id') id:string){return this.instances.access(r.actor.id,id);}
}
