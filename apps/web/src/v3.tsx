import { useEffect, useRef, type Ref } from 'react';
import { DesignSwitch, Icon, SignalMark, navIcon } from './v2';
import type { UiDesign } from './ui-mode';

export interface OpenTab { page: string; targetId: string | null }
export interface NavEntry { id: string; label: string }

interface PlatformBarProps {
  actorName: string;
  admin: boolean;
  isOps: boolean;
  page: string;
  unread: number;
  mode: UiDesign;
  onModeChange: (mode: UiDesign) => void;
  onNavigate: (page: string) => void;
  onSwitchSpace: (operations: boolean) => void;
  onSearch: () => void;
  onNotifications: () => void;
  onLogout: () => void;
  menuOpen: boolean;
  onMenu: () => void;
  menuButtonRef: Ref<HTMLButtonElement>;
  covered?: boolean;
}

export function V3PlatformBar({ actorName, admin, isOps, page, unread, mode, onModeChange, onNavigate, onSwitchSpace, onSearch, onNotifications, onLogout, menuOpen, onMenu, menuButtonRef, covered }: PlatformBarProps) {
  const initial = Array.from(actorName.trim())[0] ?? '·';
  return <header className="v3-platformbar" inert={covered ? true : undefined}>
    <div className="v3-platformbar-inner">
      <button type="button" className="v3-menu-button" ref={menuButtonRef} onClick={onMenu} aria-label="打开主菜单" aria-expanded={menuOpen} aria-controls="v3-sidebar"><Icon name="menu" size={19} /></button>
      <button type="button" className="v2-brand v3-top-brand" onClick={() => onNavigate(isOps ? 'overview' : 'home')} aria-label="返回工作台首页">
        <SignalMark />
        <span className="v2-brand-text"><b>Signal Atlas</b><small>企业 AI 资源运营</small></span>
      </button>
      {admin ? <div className="v3-platform-tabs" role="group" aria-label="平台空间">
        <button type="button" className={isOps ? 'active' : ''} aria-pressed={isOps} aria-label="运营空间" onClick={() => onSwitchSpace(true)}>运营<span className="v3-platform-suffix">空间</span></button>
        <button type="button" className={!isOps ? 'active' : ''} aria-pressed={!isOps} aria-label="个人空间" onClick={() => onSwitchSpace(false)}>个人<span className="v3-platform-suffix">空间</span></button>
      </div> : <span className="v3-platform-static">个人<span className="v3-platform-suffix">空间</span></span>}
      <div className="v3-platform-actions">
        <button type="button" className="v2-search v3-top-search" onClick={onSearch} aria-label="搜索页面" title="搜索页面（Ctrl+K）"><Icon name="search" size={16} /><span>搜索</span><kbd>Ctrl K</kbd></button>
        <button type="button" className={`v2-icon-button ${page === 'notifications' ? 'active' : ''}`} onClick={onNotifications} aria-label={unread ? `通知，${unread} 条未读` : '通知'} title="通知"><Icon name="bell" size={18} />{unread > 0 && <span className="v2-badge">{unread > 99 ? '99+' : unread}</span>}</button>
        <DesignSwitch mode={mode} onChange={onModeChange} className="v3-top-switch" />
        <div className="v2-user">
          <span className="v2-avatar" aria-hidden="true">{initial}</span>
          <span className="v2-user-name">{actorName}</span>
          <button type="button" className="v2-icon-button" onClick={onLogout} aria-label="退出登录" title="退出登录"><Icon name="logout" size={17} /></button>
        </div>
      </div>
    </div>
  </header>;
}

interface SidebarProps {
  workspaceName: string;
  isOps: boolean;
  page: string;
  primary: NavEntry[];
  secondary: NavEntry[];
  modelManagement?: NavEntry[];
  secondaryLabel: string;
  mode: UiDesign;
  onModeChange: (mode: UiDesign) => void;
  onNavigate: (page: string) => void;
  open: boolean;
  onClose: () => void;
  drawer?: boolean;
}

export function V3Sidebar({ workspaceName, isOps, page, primary, secondary, modelManagement=[], secondaryLabel, mode, onModeChange, onNavigate, open, onClose, drawer }: SidebarProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  const go = (id: string) => { onNavigate(id); onClose(); };
  const item = (entry: NavEntry) => <button type="button" key={entry.id} className={`v3-nav-item ${page === entry.id ? 'active' : ''}`} aria-current={page === entry.id ? 'page' : undefined} onClick={() => go(entry.id)}>
    <Icon name={navIcon(entry.id)} size={17} /><span>{entry.label}</span>
  </button>;
  const modal = !!drawer && open;
  return <aside id="v3-sidebar" className={`v3-sidebar ${open ? 'open' : ''}`} aria-label="主菜单" role={modal ? 'dialog' : undefined} aria-modal={modal || undefined}>
    <div className="v3-side-top">
      <div className="v3-side-context">
        <span className="v3-side-eyebrow">企业工作空间</span>
        <b>{workspaceName}</b>
        <small>{isOps ? '运营空间' : '个人空间'}</small>
      </div>
      <button type="button" className="v3-close" ref={closeRef} onClick={onClose} aria-label="关闭主菜单">×</button>
    </div>
    <div className="v3-nav-label">{isOps ? '运营' : '个人'}</div>
    <nav className="v3-nav" aria-label="主导航">{primary.map(item)}</nav>
    {modelManagement.length>0&&<><div className="v3-nav-label">模型管理</div><nav className="v3-nav" aria-label="模型管理">{modelManagement.map(item)}</nav></>}
    <div className="v3-nav-label">{secondaryLabel}</div>
    <nav className="v3-nav" aria-label={secondaryLabel}>{secondary.map(item)}</nav>
    <div className="v3-sidebar-footer">
      <DesignSwitch mode={mode} onChange={onModeChange} className="v3-side-switch" />
    </div>
  </aside>;
}

interface TabBarProps {
  tabs: OpenTab[];
  page: string;
  labelFor: (id: string) => string;
  pinnedPage: string;
  onActivate: (tab: OpenTab) => void;
  onClose: (page: string) => void;
}

export function V3TabBar({ tabs, page, labelFor, pinnedPage, onActivate, onClose }: TabBarProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reveal = () => activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    window.addEventListener('resize', reveal);
    return () => window.removeEventListener('resize', reveal);
  }, [page, tabs.length]);
  return <div className="v3-tabbar">
    <div className="v3-tabbar-inner">
      <div className="v3-tabs" aria-label="打开的页面">
        {tabs.map(tab => {
          const active = tab.page === page, pinned = tab.page === pinnedPage;
          return <div key={tab.page} ref={active ? activeRef : undefined} className={`v3-tab ${active ? 'active' : ''}`}>
            <button type="button" className="v3-tab-select" aria-current={active ? 'page' : undefined} onClick={() => onActivate(tab)} title={labelFor(tab.page)}>
              <Icon name={navIcon(tab.page)} size={15} /><span>{labelFor(tab.page)}</span>
            </button>
            {!pinned && <button type="button" className="v3-tab-close" onClick={() => onClose(tab.page)} aria-label={`关闭${labelFor(tab.page)}`} title={`关闭${labelFor(tab.page)}`}>×</button>}
          </div>;
        })}
      </div>
    </div>
  </div>;
}
