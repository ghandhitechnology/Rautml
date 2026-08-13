import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregateReports,
  classifyWindowSeconds,
  emptyUsageSnapshot,
  getUsageSnapshot,
  normalizeProvider,
  parseClaudeUsage,
  parseOpenRouterCredits,
  parseOpenRouterKey,
  parseWhamUsage,
} from './usage.js';

describe('WHAM window classification', () => {
  it('treats a 5-hour primary as fiveHour and a 7-day secondary as weekly', () => {
    const parsed = parseWhamUsage({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1_787_000_000 },
        secondary_window: { used_percent: 18, limit_window_seconds: 604_800, reset_at: 1_787_500_000 },
      },
    });
    assert.equal(parsed.plan, 'plus');
    assert.deepEqual(parsed.fiveHour, { usedPercent: 42, resetAt: 1_787_000_000_000 });
    assert.deepEqual(parsed.weekly, { usedPercent: 18, resetAt: 1_787_500_000_000 });
  });

  it('does not call a weekly-only primary window a 5-hour limit', () => {
    const parsed = parseWhamUsage({
      plan_type: 'prolite',
      rate_limit: {
        primary_window: {
          used_percent: 15,
          limit_window_seconds: 604_800,
          reset_after_seconds: 453_377,
          reset_at: 1_787_035_689,
        },
        secondary_window: null,
      },
    });
    assert.equal(parsed.fiveHour, undefined);
    assert.equal(parsed.weekly?.usedPercent, 15);
    assert.equal(parsed.weekly?.resetAt, 1_787_035_689_000);
  });

  it('classifies nearby window lengths', () => {
    assert.equal(classifyWindowSeconds(18_000), 'fiveHour');
    assert.equal(classifyWindowSeconds(604_800), 'weekly');
    assert.equal(classifyWindowSeconds(16_200), 'fiveHour');
    assert.equal(classifyWindowSeconds(3_600), null);
  });
});

describe('Claude usage parsing', () => {
  it('accepts utilization as a 0–100 percent', () => {
    const parsed = parseClaudeUsage({
      five_hour: { utilization: 6, resets_at: '2026-08-13T12:00:00Z' },
      seven_day: { utilization: 22.4, resets_at: '2026-08-16T08:00:00Z' },
    });
    assert.equal(parsed.fiveHour?.usedPercent, 6);
    assert.equal(parsed.weekly?.usedPercent, 22.4);
    assert.equal(parsed.fiveHour?.resetAt, Date.parse('2026-08-13T12:00:00Z'));
  });

  it('accepts utilization as a 0–1 fraction', () => {
    const parsed = parseClaudeUsage({
      five_hour: { utilization: 0.42, resets_at: '2026-08-13T12:00:00Z' },
      seven_day: { utilization: 0.61, resets_at: '2026-08-16T08:00:00Z' },
    });
    assert.equal(parsed.fiveHour?.usedPercent, 42);
    assert.equal(parsed.weekly?.usedPercent, 61);
  });
});

describe('OpenRouter balance parsing', () => {
  it('computes remaining account credits from purchased credits and usage', () => {
    assert.deepEqual(
      parseOpenRouterCredits({ data: { total_credits: 100.5, total_usage: 25.75 } }),
      { remaining: 74.75, used: 25.75, total: 100.5, scope: 'account' },
    );
  });

  it('uses the current API key allowance when account credits are unavailable', () => {
    assert.deepEqual(
      parseOpenRouterKey({ data: { limit: 100, limit_remaining: 74.5, usage: 25.5 } }),
      { remaining: 74.5, used: 25.5, total: 100, scope: 'key' },
    );
  });

  it('does not invent a balance for an unlimited key', () => {
    assert.equal(parseOpenRouterKey({ data: { limit: null, limit_remaining: null, usage: 25.5 } }), undefined);
  });
});

describe('provider aggregation', () => {
  it('maps CLIProxyAPI aliases onto Rautml provider ids', () => {
    assert.equal(normalizeProvider('codex'), 'codex');
    assert.equal(normalizeProvider('xai'), 'grok-build');
    assert.equal(normalizeProvider('kimi'), 'kimi-code');
    assert.equal(normalizeProvider('gemini'), 'gemini-cli');
  });

  it('keeps the most-used window when a provider has several accounts', () => {
    const providers = aggregateReports([
      {
        provider: 'codex',
        name: 'a',
        accountKey: 'a',
        plan: 'plus',
        fiveHour: { usedPercent: 10, resetAt: 1 },
        weekly: { usedPercent: 40, resetAt: 2 },
      },
      {
        provider: 'codex',
        name: 'b',
        accountKey: 'b',
        fiveHour: { usedPercent: 80, resetAt: 3 },
        weekly: { usedPercent: 12, resetAt: 4 },
      },
    ]);
    assert.equal(providers.length, 1);
    assert.equal(providers[0]!.id, 'codex');
    assert.equal(providers[0]!.accounts, 2);
    assert.equal(providers[0]!.fiveHour?.usedPercent, 80);
    assert.equal(providers[0]!.weekly?.usedPercent, 40);
    assert.equal(providers[0]!.plan, 'plus');
  });
});

describe('cached snapshot', () => {
  it('starts empty so a first GET never blocks on a live fetch', () => {
    const snapshot = getUsageSnapshot();
    assert.ok(Array.isArray(snapshot.providers));
    assert.equal(typeof snapshot.updatedAt, 'number');
    assert.deepEqual(emptyUsageSnapshot(), { providers: [], updatedAt: 0 });
  });
});
