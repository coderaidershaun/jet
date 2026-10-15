import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, createFollowing } from './following.js';

test('a list at the top counts nothing; scrolled away it counts what was appended since, and the badge says so', () => {
  const following = createFollowing(['system', 'orders']);
  assert.equal(following.isFollowing('system'), true, 'a list starts out following');

  following.scrolled('system', 0, 50);
  following.scrolled('system', 1, 51);
  assert.equal(following.unseen('system', 52), 0, 'a pixel off the top is still the top, and rows that arrive there are seen');

  following.scrolled('system', 40, 52);
  assert.equal(following.unseen('system', 52), 0, 'nothing is new at the moment the reader leaves the top');
  assert.equal(badgeText(following.unseen('system', 57)), '5 new');

  following.scrolled('system', 80, 60);
  assert.equal(following.unseen('system', 60), 8, 'scrolling further away keeps the count from where the reader left');
  following.scrolled('system', 1.5, 61);
  assert.equal(following.unseen('system', 61), 9, 'just over a pixel is still away');
  assert.equal(following.unseen('system', 10), 0, 'a count that went back (rows started over) is never negative');

  following.scrolled('system', 1, 62);
  assert.equal(badgeText(following.unseen('system', 70)), '', 'back at the top, the badge is gone');
});

test('following again after the badge, each channel on its own', () => {
  const following = createFollowing(['system', 'orders', 'trades']);
  following.scrolled('orders', 90, 20);
  following.scrolled('trades', 50, 7);
  assert.equal(following.isFollowing('system'), true, 'scrolling one list leaves the others following');

  following.follow('orders', 25);
  assert.equal(following.isFollowing('orders'), true, 'the badge brings the list back to following');
  assert.equal(following.unseen('trades', 9), 2, 'another list that is away keeps its own count');

  following.scrolled('orders', 12, 31);
  assert.equal(following.unseen('orders', 34), 3, 'leaving the top again counts from there, not from before the jump');
});
