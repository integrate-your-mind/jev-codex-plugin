import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redactText} from '../src/redact.js';

test('tool-result text redacts JSON tokens and signed download credentials', () => {
  const input = JSON.stringify({token: 'synthetic-session-value', input_tokens: 123,
    url: 'https://example.invalid/file?sig=synthetic-signature&x-amz-credential=synthetic-credential&part=1'});
  const result = redactText(input);
  assert.equal(result.includes('synthetic-session-value'), false);
  assert.equal(result.includes('synthetic-signature'), false);
  assert.equal(result.includes('synthetic-credential'), false);
  assert.match(result, /input_tokens":123/);
  assert.match(result, /part=1/);
});
