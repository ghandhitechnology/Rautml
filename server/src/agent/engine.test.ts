import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { windowTurns } from './engine.js';

// The default budget is 400k chars (RAUTML_CONTEXT_CHAR_BUDGET unset here);
// tests build turns sized against it.
const BUDGET = 400_000;

describe('context windowing', () => {
  it('keeps transcripts under the budget verbatim (same array, same objects)', () => {
    const turns: any[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ];
    assert.equal(windowTurns(turns), turns);
  });

  it('shrinks the oldest tool results first, newest turns stay verbatim', () => {
    const oldResult = { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(300_000) };
    const midResult = { role: 'tool', tool_call_id: 'c2', content: 'y'.repeat(300_000) };
    const turns: any[] = [
      { role: 'user', content: 'start' },
      oldResult,
      midResult,
      { role: 'assistant', content: 'recent answer' },
    ];
    const out = windowTurns(turns);
    assert.equal(out.length, 4);
    // 600k of results over a 400k budget: the oldest is stubbed, and eliding
    // just the oldest already brings the total back under budget.
    assert.ok(out[1].content.length <= 2_000);
    assert.equal(out[2], midResult);
    assert.ok(out[1].content.includes('[…truncated…]'));
    // The cached transcript objects are never mutated.
    assert.equal(oldResult.content.length, 300_000);
    assert.equal(midResult.content.length, 300_000);
  });

  it('elides old tool-call arguments with valid JSON when results are not enough', () => {
    const bigArgs = JSON.stringify({ path: 'assets/a.html', content: 'h'.repeat(500_000) });
    const turns: any[] = [
      { role: 'user', content: 'build me a page' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_file', arguments: bigArgs } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ];
    const out = windowTurns(turns);
    assert.equal(out.length, 3);
    const elided = out[1].tool_calls[0].function.arguments;
    assert.ok(elided.length < bigArgs.length);
    assert.doesNotThrow(() => JSON.parse(elided));
    // Original untouched.
    assert.equal(turns[1]!.tool_calls![0]!.function.arguments, bigArgs);
  });

  it('drops the oldest turns last, always keeping the newest two', () => {
    const turns: any[] = [
      { role: 'user', content: 'a'.repeat(300_000) },
      { role: 'assistant', content: 'b'.repeat(300_000) },
      { role: 'user', content: 'c'.repeat(300_000) },
      { role: 'assistant', content: 'd'.repeat(300_000) },
    ];
    const out = windowTurns(turns);
    // 1.2M chars with nothing elidable: whole turns drop off the front, but
    // the newest two always survive even though they still exceed the budget.
    assert.equal(out.length, 2);
    assert.equal(out[0], turns[2]);
    assert.equal(out[1], turns[3]);
  });
});
