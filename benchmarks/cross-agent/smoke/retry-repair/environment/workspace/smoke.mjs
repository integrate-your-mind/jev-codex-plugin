import assert from 'node:assert/strict';import {retryDelay} from './solution.mjs';assert.equal(retryDelay({status:200,attempt:0,nowMs:0}),null);console.log('smoke passed');
