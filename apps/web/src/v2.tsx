import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { UI_DESIGNS, type UiDesign } from './ui-mode';

export type IconName =
  | 'home' | 'spark' | 'wallet' | 'inbox' | 'userPlus' | 'folder' | 'grid'
  | 'chip' | 'users' | 'key' | 'activity' | 'list' | 'checklist' | 'sliders'
  | 'bell' | 'search' | 'logout' | 'signal' | 'menu' | 'eye' | 'eyeOff' | 'chart';

const iconPaths: Record<IconName, ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.5V21h13V9.5" /><path d="M9.5 21v-6h5v6" /></>,
  spark: <><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" /><path d="m18.5 16 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" /></>,
  wallet: <><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M3 10h18" /><path d="M16 15h2" /></>,
  inbox: <><path d="M4 13h5l2 3h2l2-3h5" /><path d="M5 4h14l2 9v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3Z" /></>,
  userPlus: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3 2.5-5 6-5 1.4 0 2.6.3 3.6.9" /><path d="M18 8v6M15 11h6" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  chip: <><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3 2.5-5 6-5s6 2 6 5" /><path d="M16 5a3 3 0 0 1 0 6" /><path d="M18 15c2 .7 3 2.3 3 5" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11.5 11.5 8-8M16.5 6.5l2 2M14.5 8.5l2 2" /></>,
  activity: <path d="M3 12h4l2-6 4 12 2-6h6" />,
  list: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
  checklist: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17" /></>,
  sliders: <><path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  chart: <><path d="M4 21V10M10 21V4M16 21v-7M22 21H2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  logout: <><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5" /><path d="m14 8 4 4-4 4M8 12h10" /></>,
  signal: <><path d="M5 19V10M12 19V4M19 19v-6" /></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  eye: <><path d="M2.5 12S6 5.75 12 5.75 21.5 12 21.5 12 18 18.25 12 18.25 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M4 4l16 16" /><path d="M10.4 6.05A10 10 0 0 1 12 5.75c6 0 9.5 6.25 9.5 6.25a17.6 17.6 0 0 1-3.3 4.05" /><path d="M6.5 8.1A17.4 17.4 0 0 0 2.5 12S6 18.25 12 18.25c1.35 0 2.6-.32 3.7-.85" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>;
}

export function navIcon(id: string): IconName {
  return ({
    overview: 'home', usage:'chart', leaderboard:'signal', 'cockpit-light':'chart', 'cockpit-tech':'signal', 'cockpit-beacon':'grid', home: 'home', onboarding: 'userPlus', online: 'spark', agent:'spark',
    quota: 'wallet', approvals: 'inbox', projects: 'folder', applications: 'grid',
    catalog:'chip', models: 'chip', pools:'grid', capacity:'sliders', members: 'users', keys: 'key', monitoring: 'activity',
    safety:'checklist', calls: 'list', reviews: 'checklist', settings: 'sliders', notifications: 'bell',
  } as Record<string, IconName>)[id] ?? 'grid';
}

export function SignalMark() {
  return <span className="v2-logo" aria-hidden="true"><Icon name="signal" size={22} /></span>;
}

/* Order and set of designs come from UI_DESIGNS — the same list the pre-paint
   script in index.html mirrors — so a new design is added in one place. Labels
   live here, and a design without a label fails the type check instead of
   rendering an empty button. */
const designLabels: Record<UiDesign, { label: string; title: string }> = {
  azure: { label: '蓝灰', title: '切换到蓝灰版审核界面（左栏 + 标签页，新版设计与组件）' },
  beacon: { label: '信标', title: '切换到 Beacon 信标版（暖白画布 + 深墨主卡）' },
  sidebar: { label: '左栏', title: '切换到左栏主菜单 + 顶部标签页' },
  next: { label: '顶栏', title: '切换到顶部导航界面' },
  classic: { label: '经典', title: '切换到经典深色界面' },
};

export function DesignSwitch({ mode, onChange, className }: { mode: UiDesign; onChange: (mode: UiDesign) => void; className?: string }) {
  return <div className={`design-switch ${className ?? ''}`} role="group" aria-label="界面版本" title="切换界面版本，选择会被记住">
    <span className="design-switch-label">界面</span>
    {UI_DESIGNS.map(design => <button key={design} type="button" aria-pressed={mode === design} className={mode === design ? 'selected' : ''} title={designLabels[design].title} onClick={() => onChange(design)}>{designLabels[design].label}</button>)}
  </div>;
}

export interface V2HeaderProps {
  actorName: string;
  workspaceName: string;
  admin: boolean;
  isOps: boolean;
  page: string;
  primary: string[];
  secondary: string[];
  modelManagement?: string[];
  secondaryLabel: string;
  labels: Record<string, string>;
  unread: number;
  mode: UiDesign;
  onModeChange: (mode: UiDesign) => void;
  onNavigate: (page: string) => void;
  onSwitchSpace: (operations: boolean) => void;
  onSearch: () => void;
  onNotifications: () => void;
  onLogout: () => void;
}

export function V2Header({ actorName, workspaceName, admin, isOps, page, primary, secondary, modelManagement=[], secondaryLabel, labels, unread, mode, onModeChange, onNavigate, onSwitchSpace, onSearch, onNotifications, onLogout }: V2HeaderProps) {
  const initial = Array.from(actorName.trim())[0] ?? '·';
  return <header className="v2-header">
    <div className="v2-header-top">
      <button type="button" className="v2-brand" onClick={() => onNavigate(isOps ? 'overview' : 'home')} aria-label="返回工作台首页">
        <SignalMark />
        <span className="v2-brand-text"><b>Signal Atlas</b><small>企业 AI 资源运营</small></span>
      </button>
      <nav className="v2-primary" aria-label="主导航">
        {primary.map(item => <button type="button" key={item} className={page === item ? 'active' : ''} aria-current={page === item ? 'page' : undefined} onClick={() => onNavigate(item)}><Icon name={navIcon(item)} size={16} /><span>{labels[item]}</span></button>)}
      </nav>
      <div className="v2-actions">
        <button type="button" className="v2-search" onClick={onSearch} aria-label="搜索页面" title="搜索页面（Ctrl+K）"><Icon name="search" size={16} /><span>搜索</span><kbd>Ctrl K</kbd></button>
        <button type="button" className={`v2-icon-button ${page === 'notifications' ? 'active' : ''}`} onClick={onNotifications} aria-label={unread ? `通知，${unread} 条未读` : '通知'} title="通知"><Icon name="bell" size={18} />{unread > 0 && <span className="v2-badge">{unread > 99 ? '99+' : unread}</span>}</button>
        <DesignSwitch mode={mode} onChange={onModeChange} />
        <div className="v2-user">
          <span className="v2-avatar" aria-hidden="true">{initial}</span>
          <span className="v2-user-name">{actorName}</span>
          <button type="button" className="v2-icon-button" onClick={onLogout} aria-label="退出登录" title="退出登录"><Icon name="logout" size={17} /></button>
        </div>
      </div>
    </div>
    <div className="v2-header-sub">
      <div className="v2-workspace">
        {admin ? <div className="v2-segmented" role="group" aria-label="工作空间">
          <button type="button" className={isOps ? 'selected' : ''} aria-pressed={isOps} onClick={() => onSwitchSpace(true)}>运营空间</button>
          <button type="button" className={!isOps ? 'selected' : ''} aria-pressed={!isOps} onClick={() => onSwitchSpace(false)}>个人空间</button>
        </div> : <span className="v2-space-static">个人空间</span>}
        <span className="v2-org">企业 · {workspaceName}</span>
      </div>
      {modelManagement.length>0&&<nav className="v2-secondary" aria-label="模型管理"><span className="v2-secondary-label" aria-hidden="true">模型管理</span>{modelManagement.map(item=><button type="button" key={item} className={page===item?'active':''} aria-current={page===item?'page':undefined} onClick={()=>onNavigate(item)}>{labels[item]}</button>)}</nav>}
      <nav className="v2-secondary" aria-label={secondaryLabel}>
        <span className="v2-secondary-label" aria-hidden="true">{secondaryLabel}</span>
        {secondary.map(item => <button type="button" key={item} className={page === item ? 'active' : ''} aria-current={page === item ? 'page' : undefined} onClick={() => onNavigate(item)}>{labels[item]}</button>)}
      </nav>
    </div>
    <div className="v2-ruler" aria-hidden="true" />
  </header>;
}

export interface PaletteItem { id: string; label: string; group: string; icon: IconName }

export function CommandPalette({ open, items, onClose, onSelect }: { open: boolean; items: PaletteItem[]; onClose: () => void; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null), restoreRef = useRef<HTMLElement | null>(null);
  const filtered = items.filter(item => `${item.label} ${item.group} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = [...new Set(filtered.map(item => item.group))];
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    setQuery(''); setIndex(0);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => { window.clearTimeout(timer); document.body.style.overflow = overflow; restoreRef.current?.focus?.(); };
  }, [open]);
  useEffect(() => { setIndex(0); }, [query]);
  const activeId = filtered[index]?.id;
  useEffect(() => { if (open && activeId) document.getElementById(`palette-option-${activeId}`)?.scrollIntoView({ block: 'nearest' }); }, [activeId, open]);
  if (!open) return null;
  const choose = (id: string) => { onClose(); onSelect(id); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(current => Math.min(current + 1, filtered.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => Math.max(current - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); const item = filtered[index]; if (item) choose(item.id); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'Tab') { event.preventDefault(); }
  };
  let position = -1;
  return <div className="palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="palette" role="dialog" aria-modal="true" aria-label="搜索页面">
      <div className="palette-input">
        <Icon name="search" size={19} />
        <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="搜索页面，例如：额度、审批、密钥" aria-label="搜索页面" aria-controls="palette-list" aria-activedescendant={filtered[index] ? `palette-option-${filtered[index].id}` : undefined} autoComplete="off" />
        <kbd>Esc</kbd>
      </div>
      <div className="palette-list" id="palette-list" role="listbox" aria-label="页面结果">
        {groups.map(group => <div key={group}>
          <div className="palette-group">{group}</div>
          {filtered.filter(item => item.group === group).map(item => { position += 1; const active = position === index; return <div key={item.id} id={`palette-option-${item.id}`} role="option" aria-selected={active} className={`palette-option ${active ? 'active' : ''}`} onMouseMove={() => setIndex(filtered.indexOf(item))} onClick={() => choose(item.id)}>
            <span className="palette-icon"><Icon name={item.icon} size={17} /></span>
            <span>{item.label}</span>
            {active && <span className="palette-hint">↵ 打开</span>}
          </div>; })}
        </div>)}
        {!filtered.length && <p className="palette-empty">没有匹配的页面。试试“额度”“审批”或“模型”。</p>}
      </div>
      <div className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span><span className="palette-footer-end">Ctrl K 随时唤起</span></div>
    </div>
  </div>;
}
