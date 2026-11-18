import {describe,expect,it} from 'vitest';
import {callErrorFilter,describeCallError} from './call-errors.js';

describe('call error descriptions',()=>{
  it('names upstream status and timeout families without inventing a cause',()=>{
    expect(describeCallError('upstream_http_502')).toEqual({label:'上游 HTTP 502',known:true});
    expect(describeCallError('upstream_first_byte_timeout')).toEqual({label:'上游首字节超时',known:true});
    expect(describeCallError('upstream_idle_timeout')).toEqual({label:'上游空闲超时',known:true});
    expect(describeCallError('upstream_total_timeout')).toEqual({label:'上游总时限超时',known:true});
  });
  it('reports a missing or unrecognised code as unknown instead of guessing',()=>{
    expect(describeCallError(null)).toEqual({label:'错误码未采集',known:false});
    expect(describeCallError('')).toEqual({label:'错误码未采集',known:false});
    expect(describeCallError('vendor_specific_thing')).toEqual({label:'vendor_specific_thing',known:false});
    expect(describeCallError('constructor')).toEqual({label:'constructor',known:false});
  });
  it('builds the only supported drill-down filter and keeps missing states explicit',()=>{
    const window={from:'2026-01-01T00:00:00.000Z',to:'2026-01-01T00:05:00.000Z'};
    expect(callErrorFilter({serviceId:'svc',modelId:'model',outcome:'upstream_error',errorCode:'upstream_http_502'},window))
      .toEqual({from:window.from,to:window.to,modelId:'model',outcome:'upstream_error',serviceId:'svc',errorCode:'upstream_http_502'});
    expect(callErrorFilter({serviceId:null,modelId:'model',outcome:'timeout',errorCode:null},{from:null,to:null}))
      .toEqual({modelId:'model',outcome:'timeout',serviceMissing:'true',errorCodeMissing:'true'});
  });
});
