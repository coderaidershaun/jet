import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReveal } from './throttle.js';

function manualClock() {
  let now = 0;
  let timers = [];
  return {
    now: () => now,
    after(fn, ms) {
      const timer = { fn, at: now + ms };
      timers.push(timer);
      return () => { timers = timers.filter((t) => t !== timer); };
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
    },
  };
}

function deferredRender() {
  const calls = [];
  return {
    calls,
    render(text) {
      return new Promise((resolve) => calls.push({ text, resolve: (html) => resolve(html) }));
    },
  };
}

const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

test('an older render never overwrites newer text, and an absolute reveal hold delays pending text and completion', async () => {
  {
    const clock = manualClock();
    const renderer = deferredRender();
    const painted = [];
    const reveal = createReveal({ render: renderer.render, paint: (html) => painted.push(html), clock });

    reveal.text('a');
    await clock.advance(0);
    assert.deepEqual(renderer.calls.map((c) => c.text), ['a']);
    renderer.calls[0].resolve('<A>');
    await flush();
    assert.deepEqual(painted, ['<A>']);

    await clock.advance(10);
    reveal.text('ab');
    await clock.advance(10);
    reveal.text('abc');
    await clock.advance(29);
    assert.equal(renderer.calls.length, 1, 'nothing renders inside the 50 ms window');
    await clock.advance(1);
    assert.deepEqual(renderer.calls.map((c) => c.text), ['a', 'abc'], 'one trailing call carries the latest text');

    await clock.advance(50);
    reveal.text('abcd');
    await clock.advance(50);
    assert.deepEqual(renderer.calls.map((c) => c.text), ['a', 'abc', 'abcd']);
    renderer.calls[2].resolve('<ABCD>');
    await flush();
    renderer.calls[1].resolve('<ABC>');
    await flush();
    assert.deepEqual(painted, ['<A>', '<ABCD>'], 'the older answer arrived late and was dropped');

    reveal.text('abcde');
    reveal.end();
    await clock.advance(200);
    assert.equal(renderer.calls.length, 3, 'nothing renders after the reply ended');
  }
  {
    const clock = manualClock();
    const renderer = deferredRender();
    const painted = [];
    const reveal = createReveal({ render: renderer.render, paint: (html) => painted.push(html), clock });

    reveal.text('before mood');
    reveal.holdUntil(300);
    await clock.advance(10);
    reveal.text('Hi');
    await clock.advance(289);
    assert.equal(renderer.calls.length, 0, 'text is held back while Jet reacts');
    await clock.advance(1);
    assert.deepEqual(renderer.calls.map((c) => c.text), ['Hi']);

    await clock.advance(60);
    reveal.text('Hi there');
    await clock.advance(0);
    assert.equal(renderer.calls.length, 2, 'later text is not held again');
    reveal.holdUntil(500);
    renderer.calls[1].resolve('<late>');
    await flush();
    assert.deepEqual(painted, [], 'a render in flight cannot bypass an extended hold');
    let finished = false;
    reveal.holdUntil(600);
    reveal.finish(() => { finished = true; });
    await clock.advance(239);
    assert.equal(finished, false);
    await clock.advance(1);
    assert.equal(finished, true);
    reveal.holdUntil(1000);
    reveal.finish(() => { throw new Error('cancelled completion ran'); });
    reveal.end();
    await clock.advance(1000);
  }
});
