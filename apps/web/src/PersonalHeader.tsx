import {useEffect,useRef,useState} from 'react';
import {Modal} from './components';
import {DesignSwitch,Icon,navIcon} from './v2';
import type {NavEntry} from './v3';
import type {UiDesign} from './ui-mode';

interface Props {
  actorName:string;workspaceName:string;admin:boolean;page:string;unread:number;
  primary:NavEntry[];secondary:NavEntry[];mode:UiDesign;
  onModeChange:(mode:UiDesign)=>void;onNavigate:(page:string)=>void;
  onOperations:()=>void;onLogout:()=>void;onSearch:()=>void;
}

export function PersonalHeader({actorName,workspaceName,admin,page,unread,primary,secondary,mode,onModeChange,onNavigate,onOperations,onLogout,onSearch}:Props){
  const [menu,setMenu]=useState(false),moreRef=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{const more=moreRef.current;if(more&&!more.contains(event.target as Node))more.open=false;};
    const blur=(event:FocusEvent)=>{const more=moreRef.current;if(more&&!more.contains(event.target as Node))more.open=false;};
    const resize=()=>{if(window.innerWidth>900)setMenu(false);};
    document.addEventListener('pointerdown',outside);document.addEventListener('focusin',blur);window.addEventListener('resize',resize);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',blur);window.removeEventListener('resize',resize);};
  },[]);
  function go(id:string){if(moreRef.current?.open){moreRef.current.open=false;moreRef.current.querySelector('summary')?.focus();}setMenu(false);onNavigate(id);}
  const item=(entry:NavEntry)=><button type="button" key={entry.id} className="personal-nav-link" aria-current={page===entry.id?'page':undefined} onClick={()=>go(entry.id)}><Icon name={navIcon(entry.id)} size={17}/><span>{entry.label}</span></button>;
  return <>
    <header className="personal-header">
      <div className="personal-toolbar">
        <button type="button" className="personal-brand" onClick={()=>go('home')} aria-label="返回开始使用"><span className="personal-mark"><Icon name="signal" size={20}/></span><span><b>Signal Atlas</b><small title={workspaceName}>{workspaceName} · 个人空间</small></span></button>
        <div className="personal-tools">
          {admin&&<button type="button" className="ghost personal-space" onClick={onOperations}>运营空间</button>}
          <button type="button" className="personal-tool personal-search" onClick={onSearch} aria-label="搜索页面" title="搜索页面（Ctrl+K）"><Icon name="search"/></button>
          <button type="button" className="personal-tool" aria-current={page==='notifications'?'page':undefined} onClick={()=>go('notifications')} aria-label={unread?`通知，${unread} 条未读`:'通知'} title="通知"><Icon name="bell"/>{unread>0&&<span className="personal-unread" aria-hidden="true">{unread>99?'99+':unread}</span>}</button>
          <DesignSwitch mode={mode} onChange={onModeChange} className="personal-design"/>
          <span className="personal-user" title={actorName}>{actorName}</span>
          <button type="button" className="personal-tool" onClick={onLogout} aria-label="退出登录" title="退出登录"><Icon name="logout"/></button>
          <button type="button" className="personal-tool personal-menu-button" onClick={()=>setMenu(true)} aria-label="打开主菜单" aria-haspopup="dialog" aria-expanded={menu}><Icon name="menu"/></button>
        </div>
      </div>
      <div className="personal-navigation">
        <nav className="personal-primary" aria-label="主导航">{primary.map(item)}</nav>
        <details className="personal-more" ref={moreRef} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}>
          <summary className={secondary.some(e=>e.id===page)?'is-current':undefined}>更多<span aria-hidden="true">⌄</span></summary>
          <nav aria-label="工具与协作">{secondary.map(item)}</nav>
        </details>
      </div>
    </header>
    {menu&&<Modal title="个人空间菜单" onClose={()=>setMenu(false)}>
      <p className="secondary">{actorName} · {workspaceName}</p>
      <nav className="personal-mobile-nav" aria-label="主导航">{primary.map(item)}</nav>
      <p className="eyebrow">工具与协作</p><nav className="personal-mobile-nav" aria-label="工具与协作">{secondary.map(item)}</nav>
      <div className="personal-mobile-tools"><DesignSwitch mode={mode} onChange={onModeChange}/>{admin&&<button type="button" className="ghost" onClick={()=>{setMenu(false);onOperations();}}>进入运营空间</button>}</div>
    </Modal>}
  </>;
}
