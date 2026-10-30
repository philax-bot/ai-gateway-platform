import {Body,Controller,Get,Header,HttpCode,Param,Post,Req,UseGuards} from '@nestjs/common';
import {SessionGuard,sessionToken,type UserRequest} from '../platform/session.guard';
import {LocalOctopImportService} from './local-octop-import.service';

@Controller('/api/v1/platform/local-octop/imports')
export class LocalOctopImportController {
  constructor(private readonly imports:LocalOctopImportService){}
  @Post() @HttpCode(200) @Header('Cache-Control','no-store') @UseGuards(SessionGuard)
  create(@Req() r:UserRequest,@Body() body:Record<string,unknown>){return this.imports.create(r.actor.id,sessionToken(r),body);}
  @Get('/:id') @Header('Cache-Control','no-store') @UseGuards(SessionGuard)
  status(@Req() r:UserRequest,@Param('id') id:string){return this.imports.status(r.actor.id,id);}
  @Post('/claim') @HttpCode(200) @Header('Cache-Control','no-store')
  claim(@Body() body:Record<string,unknown>){return this.imports.claim(body);}
  @Post('/complete') @HttpCode(200) @Header('Cache-Control','no-store')
  complete(@Body() body:Record<string,unknown>){return this.imports.complete(body);}
}
