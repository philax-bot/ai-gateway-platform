import {describe,it,expect} from 'vitest';
import {usagePeriodWindow,reportIsoTime,reportLocalTime} from './report-period.js';
describe('workspace reporting windows',()=>{
  it('resolves month, year and leap boundaries in Shanghai regardless of host timezone',()=>{
    const now=new Date('2026-01-01T00:00:00Z');
    expect(usagePeriodWindow('today',now)).toEqual({from:'2025-12-31T16:00:00.000Z',to:now.toISOString()});
    expect(usagePeriodWindow('yesterday',now)).toEqual({from:'2025-12-30T16:00:00.000Z',to:'2025-12-31T16:00:00.000Z'});
    expect(usagePeriodWindow('previousMonth',now)).toEqual({from:'2025-11-30T16:00:00.000Z',to:'2025-12-31T16:00:00.000Z'});
    expect(usagePeriodWindow('previousMonth',new Date('2024-03-01T02:00:00Z')).from).toBe('2024-01-31T16:00:00.000Z');
    expect(usagePeriodWindow('last7',now).from).toBe('2025-12-25T16:00:00.000Z');
    expect(reportIsoTime('2026-01-01T08:00')).toBe(now.toISOString());
    expect(reportLocalTime(now)).toBe('2026-01-01T08:00');
  });
});
