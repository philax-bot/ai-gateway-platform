import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/* Signal Atlas date field: one trigger + one calendar popover for every date and
   date-time value. It replaces native <input type="date"> / <input type="datetime-local">
   so the picker follows the theme, the keyboard contract and the timezone copy of the
   product instead of the browser's own calendar. */
export type DateMode = 'date' | 'datetime';
type Parts = { date: string; hour: number; minute: number };

const pad = (value: number) => String(value).padStart(2, '0');
const isoDate = (year: number, month: number, day: number) => `${year}-${pad(month + 1)}-${pad(day)}`;
const todayValue = () => { const now = new Date(); return isoDate(now.getFullYear(), now.getMonth(), now.getDate()); };
const split = (date: string) => { const [year, month, day] = date.split('-').map(Number); return { year, month: month - 1, day }; };
const parse = (value: string) => { const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value.trim()); return match ? { date: `${match[1]}-${match[2]}-${match[3]}`, hour: Number(match[4] ?? 0), minute: Number(match[5] ?? 0) } : null; };
const daysIn = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const hours = Array.from({ length: 24 }, (_, index) => index);
const minutes = Array.from({ length: 60 }, (_, index) => index);
function monthCells(year: number, month: number) {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7, cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= daysIn(year, month); day++) cells.push(isoDate(year, month, day));
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function DateField({ id, helpId, value, onChange, mode = 'date', required, compact, disabled, placeholder }: {
  id?: string; helpId?: string; value: string; onChange: (value: string) => void; mode?: DateMode; required?: boolean; compact?: boolean; disabled?: boolean; placeholder?: string;
}) {
  const generated = useId(), triggerId = id ?? generated, panelId = `${triggerId}-panel`, monthId = `${triggerId}-month`, dayId = (date: string) => `${triggerId}-${date}`;
  const rootRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null), panelRef = useRef<HTMLDivElement>(null), gridRef = useRef<HTMLDivElement>(null), guardRef = useRef<HTMLInputElement>(null), openedRef = useRef(false);
  const [open, setOpen] = useState(false), [placement, setPlacement] = useState<{ up: boolean; top?: number; right: boolean }>({ up: false, right: false }), [invalid, setInvalid] = useState(false);
  const [draft, setDraft] = useState<Parts>(() => parse(value) ?? { date: todayValue(), hour: 0, minute: 0 });
  const [view, setView] = useState(() => { const base = parse(value)?.date ?? todayValue(), parts = split(base); return { year: parts.year, month: parts.month }; });
  const [active, setActive] = useState(() => parse(value)?.date ?? todayValue());
  const today = todayValue(), selected = parse(value), marked = mode === 'datetime' ? draft.date : selected?.date, cells = monthCells(view.year, view.month);
  const valueText = selected ? (mode === 'datetime' ? `${selected.date} ${pad(selected.hour)}:${pad(selected.minute)}` : selected.date) : '';
  useEffect(() => { if (valueText) setInvalid(false); }, [valueText]);
  useEffect(() => { if (!open) return; const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); }; document.addEventListener('pointerdown', onPointer, true); return () => document.removeEventListener('pointerdown', onPointer, true); }, [open]);
  useEffect(() => { if (!open) return; const root = rootRef.current; if (!root) return; const onFocusOut = (event: FocusEvent) => { if (!root.contains(event.relatedTarget as Node | null)) setOpen(false); }; root.addEventListener('focusout', onFocusOut); return () => root.removeEventListener('focusout', onFocusOut); }, [open]);
  /* Keyboard contract: opening the panel moves focus to the active day; afterwards
     only an active-day change inside the grid moves focus. Focus on the month
     buttons or the time selects is never stolen. */
  useEffect(() => {
    if (!open) { openedRef.current = false; return; }
    const justOpened = !openedRef.current;
    openedRef.current = true;
    const frame = requestAnimationFrame(() => {
      const node = document.getElementById(dayId(active));
      if (!node) return;
      const focused = document.activeElement;
      const insideRoot = !!focused && !!rootRef.current?.contains(focused);
      const insideGrid = !!focused && !!gridRef.current?.contains(focused);
      if (!justOpened && insideRoot && !insideGrid) return;
      if (node !== focused) node.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, active]);
  function close(refocus = false) { setOpen(false); if (refocus) requestAnimationFrame(() => triggerRef.current?.focus()); }
  /* Placement is measured after the panel renders, so the real height (which changes
     between date and datetime) decides whether it fits below or above the trigger. */
  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = panelRef.current?.offsetHeight ?? (mode === 'datetime' ? 384 : 300);
    const boundary = triggerRef.current?.closest('.modal-body')?.getBoundingClientRect();
    const top = (boundary ? Math.max(boundary.top, 0) : 0) + 8, bottom = (boundary ? Math.min(boundary.bottom, window.innerHeight) : window.innerHeight) - 8;
    const down = rect.bottom + 6, above = rect.top - 6 - height, maxTop = bottom - height;
    let panelTop: number, up = false;
    if (down <= maxTop) panelTop = Math.max(down, top);
    else if (above >= top && rect.top - 6 <= bottom) { panelTop = above; up = true; }
    else panelTop = Math.min(Math.max(down <= maxTop ? down : above, top), Math.max(maxTop, top));
    setPlacement({ up, right: rect.right - 300 < 8, top: up || panelTop === down ? undefined : panelTop - rect.top });
  }, [open, mode, view.year, view.month]);
  function openPanel() {
    if (disabled) return;
    if (open) { close(); return; }
    const current = parse(value), parts = split(current?.date ?? todayValue()), now = new Date();
    setDraft(current ?? { date: todayValue(), hour: now.getHours(), minute: now.getMinutes() }); setActive(current?.date ?? todayValue()); setView({ year: parts.year, month: parts.month });
    setOpen(true);
  }
  function commit(date: string, hour: number, minute: number) { onChange(mode === 'datetime' ? `${date}T${pad(hour)}:${pad(minute)}` : date); close(true); }
  function pick(date: string) { if (mode === 'date') { commit(date, draft.hour, draft.minute); return; } setActive(date); setDraft(previous => ({ ...previous, date })); }
  function moveTo(date: string) { setActive(date); setView({ year: split(date).year, month: split(date).month }); }
  function step(delta: number, unit: 'day' | 'month') {
    const parts = split(active), base = new Date(parts.year, parts.month, parts.day);
    if (unit === 'day') base.setDate(base.getDate() + delta);
    else { base.setDate(1); base.setMonth(base.getMonth() + delta); base.setDate(Math.min(parts.day, daysIn(base.getFullYear(), base.getMonth()))); }
    moveTo(isoDate(base.getFullYear(), base.getMonth(), base.getDate()));
  }
  function panelKey(event: ReactKeyboardEvent) {
    const target = event.target as HTMLElement, key = event.key;
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (target instanceof HTMLSelectElement) return;
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') { event.preventDefault(); step(key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -7 : 7, 'day'); return; }
    if (key === 'PageUp' || key === 'PageDown') { event.preventDefault(); step(key === 'PageUp' ? -1 : 1, 'month'); return; }
    if ((key === 'Enter' || key === ' ') && target.dataset.day === 'true') { event.preventDefault(); pick(target.dataset.date!); }
  }
  return <div className={`date-field ${compact ? 'compact' : ''} ${invalid ? 'invalid' : ''}`} ref={rootRef}>
    <button type="button" id={triggerId} ref={triggerRef} className={`date-field-trigger ${valueText ? 'has-value' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-describedby={helpId} aria-required={required || undefined} aria-invalid={invalid || undefined} disabled={disabled} onClick={openPanel} onKeyDown={event => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); openPanel(); } }}>
      {valueText ? <span className="date-field-value">{valueText}</span> : <span className="date-field-placeholder">{placeholder ?? (mode === 'datetime' ? '选择日期与时间' : '选择日期')}</span>}
      <svg className="date-field-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><rect x="2" y="3.5" width="12" height="10.5" rx="2" /><path d="M2 6.5h12M5.5 2v3M10.5 2v3" /></svg>
    </button>
    {valueText && !disabled && <button type="button" className="date-field-clear" aria-label="清除日期" onClick={() => { onChange(''); close(); }}>×</button>}
    {/* Keeps native form validation for required date fields; an invalid submit is
        reported on the trigger instead of an invisible input. */}
    <input ref={guardRef} className="date-field-guard" tabIndex={-1} aria-hidden="true" required={required} value={valueText} onChange={() => { }} onInvalid={event => { event.preventDefault(); setInvalid(true); requestAnimationFrame(() => triggerRef.current?.focus()); }} />
    {invalid && <small className="date-field-error" role="alert">请选择{mode === 'datetime' ? '日期与时间' : '日期'}。</small>}
    {open && <div ref={panelRef} className={`date-panel ${placement.up ? 'is-up' : ''} ${placement.right ? 'is-right' : ''}`} style={placement.top === undefined ? undefined : { top: placement.top }} id={panelId} role="dialog" aria-modal="false" aria-labelledby={monthId} onKeyDown={panelKey}>
      <div className="date-panel-head">
        <button type="button" className="date-nav" aria-label="上个月" onClick={() => step(-1, 'month')}>‹</button>
        <span className="date-month-label" id={monthId}>{view.year} 年 {view.month + 1} 月</span>
        <button type="button" className="date-nav" aria-label="下个月" onClick={() => step(1, 'month')}>›</button>
      </div>
      <div className="date-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
      <div className="date-grid" ref={gridRef} role="grid" aria-labelledby={monthId}>
        {Array.from({ length: cells.length / 7 }, (_, week) => <div className="date-week" role="row" key={week}>
          {cells.slice(week * 7, week * 7 + 7).map((date, index) => date
            ? <span role="gridcell" key={date} aria-selected={date === marked}><button type="button" id={dayId(date)} data-day="true" data-date={date} tabIndex={date === active ? 0 : -1} className={`date-day ${date === today ? 'today' : ''} ${date === marked ? 'selected' : ''}`} onClick={() => pick(date)}>{Number(date.slice(8))}</button></span>
            : <span role="gridcell" key={`blank-${week}-${index}`} aria-hidden="true" />)}
        </div>)}
      </div>
      {mode === 'datetime' && <div className="date-time-row"><span>时间</span>
        <select aria-label="小时" value={draft.hour} onChange={event => setDraft(previous => ({ ...previous, hour: Number(event.target.value) }))}>{hours.map(hour => <option key={hour} value={hour}>{pad(hour)}</option>)}</select>
        <span aria-hidden="true">:</span>
        <select aria-label="分钟" value={draft.minute} onChange={event => setDraft(previous => ({ ...previous, minute: Number(event.target.value) }))}>{minutes.map(minute => <option key={minute} value={minute}>{pad(minute)}</option>)}</select>
        <span className="date-time-hint">24 小时</span>
      </div>}
      <div className="date-panel-foot">
        <button type="button" className="date-panel-action" disabled={!valueText} onClick={() => { onChange(''); close(true); }}>清除</button>
        <span className="date-panel-spacer" />
        <button type="button" className="date-panel-action" onClick={() => { if (mode === 'date') { commit(today, draft.hour, draft.minute); return; } const now = new Date(); setDraft({ date: today, hour: now.getHours(), minute: now.getMinutes() }); moveTo(today); }}>今天</button>
        {mode === 'datetime' && <button type="button" className="date-panel-confirm" onClick={() => commit(draft.date, draft.hour, draft.minute)}>确定</button>}
      </div>
    </div>}
  </div>;
}
