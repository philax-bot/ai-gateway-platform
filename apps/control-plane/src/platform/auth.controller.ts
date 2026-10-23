import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SessionGuard, sessionToken, type UserRequest } from './session.guard';

@Controller('/api/v1/auth')
export class AuthController {
  constructor(private readonly auth:AuthService){}
  @Get('/bootstrap') bootstrap(){return this.auth.bootstrapStatus();}
  @Post('/setup') @HttpCode(200) setup(@Body() body:Record<string,unknown>,@Req() request:UserRequest){return this.auth.setup(body,request.ip);}
  @Post('/login') @HttpCode(200)
  async login(@Body() body:Record<string,unknown>,@Req() request:UserRequest,@Res({passthrough:true}) reply:{header(name:string,value:string):unknown}){
    const result=await this.auth.login(body,request.ip);
    reply.header('set-cookie',`signal_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);
    return {member:result.member};
  }
  @Get('/me') @UseGuards(SessionGuard) me(@Req() request:UserRequest){return this.auth.publicMember(request.actor);}
  @Post('/logout') @HttpCode(200) @UseGuards(SessionGuard)
  async logout(@Req() request:UserRequest,@Res({passthrough:true}) reply:{header(name:string,value:string):unknown}){
    reply.header('set-cookie','signal_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return this.auth.logout(sessionToken(request));
  }
}
