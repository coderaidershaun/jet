import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFollow } from './scroll.js';

const at = (distanceFromBottom) => ({ scrollTop: 1000 - distanceFromBottom, clientHeight: 500, scrollHeight: 1500 });

test('the thread follows only within 80 px of the bottom, and a send always follows', () => {
  const follow = createFollow();
  assert.equal(follow.following, true, 'a new thread follows');

  follow.onScroll(at(80));
  assert.equal(follow.following, true);
  assert.equal(follow.jumpVisible, false);

  follow.onScroll(at(81));
  assert.equal(follow.following, false);
  assert.equal(follow.jumpVisible, true);

  follow.onSend();
  assert.equal(follow.following, true);

  follow.onScroll(at(400));
  follow.onScroll(at(0));
  assert.equal(follow.following, true, 'scrolling back to the bottom resumes following');
});
