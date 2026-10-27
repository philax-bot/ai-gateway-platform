import { useEffect, useRef, type Ref } from 'react';
import { DesignSwitch, Icon, navIcon } from './v2';
import type { UiDesign } from './ui-mode';
import type { NavEntry, OpenTab } from './v3';

/* Atlas Blue shell: the same left-menu + page-tabs navigation as the v3 shell,
   rebuilt so the operators' primary surfaces read as a blue-gray control desk.
   Structure lives here; every visual rule lives in design-v4.css. */

interface TopBarProps {
  actorName: string;
  admin: boolean;
  isOps: boolean;
  notificationsActive: boolean;
  unread: number;
  mode: UiDesign;
  onModeChange: (mode: UiDesign) => void;
  onNavigateHome: () => void;
  onSwitchSpace: (operations: boolean) => void;
  onSearch: () => void;
  onNotifications: () => void;
  onLogout: () => void;
  menuOpen: boolean;
  onMenu: () => void;
  menuButtonRef: Ref<HTMLButtonElement>;
  covered?: boolean;
}

export function V4TopBar({ actorName, admin, isOps, notificationsActive, unread, mode, onModeChange, onNavigateHome, onSwitchSpace, onSearch, onNotifications, onLogout, menuOpen, onMenu, menuButtonRef, covered }: TopBarProps) {
  const initial = Array.from(actorName.trim())[0] ?? '·';
  return <header className="v4-topbar" inert={covered ? true : undefined}>
    <div className="v4-topbar-inner">
      <button type="button" className="v4-menu-button" ref={menuButtonRef} onClick={onMenu} aria-label="打开主菜单" aria-expanded={menuOpen} aria-controls="v4-sidebar"><Icon name="menu" size={18} /></button>
      <button type="button" className="v4-brand" onClick={onNavigateHome} aria-label="返回工作台首页">
        <span className="v4-mark" aria-hidden="true"><Icon name="signal" size={18} /></span>
        <span className="v4-brand-text"><b>Signal Atlas</b><small>企业 AI 资源运营</small></span>
      </button>
      <span className="v4-topbar-divider" aria-hidden="true" />
      {admin
        ? <div className="v4-space" role="group" aria-label="平台空间">
          <button type="button" className={isOps ? 'active' : ''} aria-pressed={isOps} aria-label="运营空间" onClick={() => onSwitchSpace(true)}>运营<span className="v4-space-suffix">空间</span></button>
          <button type="button" className={!isOps ? 'active' : ''} aria-pressed={!isOps} aria-label="个人空间" onClick={() => onSwitchSpace(false)}>个人<span className="v4-space-suffix">空间</span></button>
        </div>
        : <span className="v4-space-static">个人空间</span>}
      <div className="v4-topbar-actions">
        <button type="button" className="v4-search" onClick={onSearch} aria-label="搜索页面" title="搜索页面（Ctrl+K）"><Icon name="search" size={15} /><span className="search-label">搜索</span><kbd>Ctrl K</kbd></button>
        <button type="button" className={`v4-icon-button ${notificationsActive ? 'active' : ''}`} onClick={onNotifications} aria-label={unread ? `通知，${unread} 条未读` : '通知'} title="通知"><Icon name="bell" size={17} />{unread > 0 && <span className="v4-badge">{unread > 99 ? '99+' : unread}</span>}</button>
        <DesignSwitch mode={mode} onChange={onModeChange} className="v4-top-switch" />
        <div className="v4-user">
          <span className="v4-avatar" aria-hidden="true">{initial}</span>
          <span className="v4-user-name">{actorName}</span>
          <button type="button" className="v4-icon-button" onClick={onLogout} aria-label="退出登录" title="退出登录"><Icon name="logout" size={16} /></button>
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
  secondaryLabel: string;
  badges: Record<string, number>;
  mode: UiDesign;
  onModeChange: (mode: UiDesign) => void;
  onNavigate: (page: string) => void;
  open: boolean;
  onClose: () => void;
  drawer?: boolean;
}

export function V4Sidebar({ workspaceName, isOps, page, primary, secondary, secondaryLabel, badges, mode, onModeChange, onNavigate, open, onClose, drawer }: SidebarProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  const go = (id: string) => { onNavigate(id); onClose(); };
  const item = (entry: NavEntry) => {
    const count = badges[entry.id] ?? 0;
    return <button type="button" key={entry.id} className={`v4-nav-item ${page === entry.id ? 'active' : ''}`} aria-current={page === entry.id ? 'page' : undefined} onClick={() => go(entry.id)}>
      <Icon name={navIcon(entry.id)} size={17} />
      <span>{entry.label}</span>
      {count > 0 && <span className={`v4-nav-badge ${entry.id === 'reviews' ? 'is-alert' : ''}`} aria-label={`${count} 项待处理`}>{count > 99 ? '99+' : count}</span>}
    </button>;
  };
  const modal = !!drawer && open;
  const designNote = mode === 'beacon' ? '信标版审核界面' : '蓝灰版审核界面';
  return <aside id="v4-sidebar" className={`v4-sidebar ${open ? 'open' : ''}`} aria-label="主菜单" role={modal ? 'dialog' : undefined} aria-modal={modal || undefined}>
    <div className="v4-side-top">
      <div className="v4-context">
        <span className="v4-context-eyebrow">企业工作空间</span>
        <b>{workspaceName}</b>
        <small><i aria-hidden="true" />{isOps ? '运营空间' : '个人空间'}</small>
      </div>
      <button type="button" className="v4-close" ref={closeRef} onClick={onClose} aria-label="关闭主菜单">×</button>
    </div>
    <div className="v4-nav-label">{isOps ? '运营空间' : '个人空间'}</div>
    <nav className="v4-nav" aria-label="主导航">{primary.map(item)}</nav>
    <div className="v4-nav-label">{secondaryLabel}</div>
    <nav className="v4-nav" aria-label={secondaryLabel}>{secondary.map(item)}</nav>
    <div className="v4-sidebar-footer">
      <span className="v4-side-note">{designNote} · 界面选择会被记住</span>
      <DesignSwitch mode={mode} onChange={onModeChange} className="v4-side-switch" />
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

export function V4PageTabs({ tabs, page, labelFor, pinnedPage, onActivate, onClose }: TabBarProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reveal = () => activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    window.addEventListener('resize', reveal);
    return () => window.removeEventListener('resize', reveal);
  }, [page, tabs.length]);
  return <div className="v4-tabbar">
    <div className="v4-tabbar-inner">
      <div className="v4-tabs" aria-label="打开的页面">
        {tabs.map(tab => {
          const active = tab.page === page, pinned = tab.page === pinnedPage;
          return <div key={tab.page} ref={active ? activeRef : undefined} className={`v4-tab ${active ? 'active' : ''}`}>
            <button type="button" className="v4-tab-select" aria-current={active ? 'page' : undefined} onClick={() => onActivate(tab)} title={labelFor(tab.page)}>
              <Icon name={navIcon(tab.page)} size={14} /><span>{labelFor(tab.page)}</span>
            </button>
            {!pinned && <button type="button" className="v4-tab-close" onClick={() => onClose(tab.page)} aria-label={`关闭${labelFor(tab.page)}`} title={`关闭${labelFor(tab.page)}`}>×</button>}
          </div>;
        })}
      </div>
    </div>
  </div>;
}
