// Tests that each sign-in refusal says what to do next and that sign-in returns to the page first asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAddress, refusalMessage } from './answer.js';

test('each refusal of a sign-in says what to do next, and a wait says when to try again', () => {
  const wrong = refusalMessage({ status: 401, kind: 'wrongPassword' });
  assert.equal(wrong.field, 'password');
  assert.match(wrong.text, /email and password don’t match/);
  assert.match(refusalMessage({ status: 429, kind: 'tooManyFailures', retryAfter: '840' }).text, /try again in 14 minutes/);
  assert.match(refusalMessage({ status: 429, kind: 'tooManyFailures', retryAfter: '61' }).text, /try again in 2 minutes/);
  assert.match(refusalMessage({ status: 429, kind: 'tooManyFailures', retryAfter: '45' }).text, /try again in 45 seconds/);
  assert.match(refusalMessage({ status: 429, kind: 'tooManyFailures', retryAfter: null }).text, /try again in a few minutes/);
  assert.match(refusalMessage({ status: 403, kind: 'crossSite' }).text, /Jet’s own address/);
  assert.match(refusalMessage({ status: 0, kind: 'network' }).text, /can’t reach Jet/);
  assert.match(refusalMessage({ status: 500, kind: 'io' }).text, /HTTP 500/);
});

test('after signing in the page goes back to the page first asked for, but never off Jet', () => {
  const jet = 'https://jet.example';
  assert.equal(nextAddress('?next=%2Fapps%2Fquanty%2F%3Fa%3D1%23top', jet), '/apps/quanty/?a=1#top');
  assert.equal(nextAddress('', jet), '/');
  const away = ['//evil.example/', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '\\\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/signin/'];
  for (const next of away) assert.equal(nextAddress('?next=' + encodeURIComponent(next), jet), '/', JSON.stringify(next));
});
