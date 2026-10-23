import assert from 'node:assert/strict';
import test from 'node:test';
import {definitelyNotSent} from '../dist/connection-failure.js';
test('only connection establishment failures prove that no upstream request was sent',()=>{
  assert.equal(definitelyNotSent({cause:{code:'ECONNREFUSED'}}),true);
  assert.equal(definitelyNotSent({cause:{errors:[{code:'ECONNREFUSED'},{code:'ENOTFOUND'}]}}),true);
  assert.equal(definitelyNotSent({cause:{errors:[{code:'ECONNREFUSED'},{code:'ECONNRESET'}]}}),false);
  for(const value of [{cause:{code:'ECONNRESET'}},{cause:{code:'UND_ERR_SOCKET'}},new Error('fetch failed'),{name:'AbortError'},null])assert.equal(definitelyNotSent(value),false);
});
