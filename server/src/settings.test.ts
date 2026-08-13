import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { applyManagedEnv } from './managed-env.js';
import {
  PERSONALIZATION_MAX_CHARS,
  parseEnvText,
  readPersonalization,
  upsertEnvText,
  writeKeys,
  writePersonalization,
} from './settings.js';

describe('managed API environment', () => {
  it('lets saved values replace exported shell keys', () => {
    const environment: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: 'shell-key',
      PORT: '5175',
    };
    applyManagedEnv({ OPENROUTER_API_KEY: 'saved-key', PORT: '9999' }, environment);
    assert.deepEqual(environment, { OPENROUTER_API_KEY: 'saved-key', PORT: '5175' });
  });

  it('keeps an explicit saved removal from reverting to an exported key', () => {
    const environment: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: 'shell-key' };
    applyManagedEnv({ OPENROUTER_API_KEY: '' }, environment);
    assert.equal(environment.OPENROUTER_API_KEY, undefined);
  });
});

describe('writeKeys', () => {
  it('serializes concurrent saves so neither drops the other’s key', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'rautml-settings-'));
    const previous = {
      envPath: process.env.RAUTML_ENV_PATH,
      openRouter: process.env.OPENROUTER_API_KEY,
      firecrawl: process.env.FIRECRAWL_API_KEY,
    };
    process.env.RAUTML_ENV_PATH = path.join(dir, '.env');
    try {
      await Promise.all([
        writeKeys({ OPENROUTER_API_KEY: 'sk-or-first' }),
        writeKeys({ FIRECRAWL_API_KEY: 'fc-second' }),
      ]);
      const parsed = parseEnvText(await fs.readFile(process.env.RAUTML_ENV_PATH, 'utf8'));
      assert.equal(parsed.OPENROUTER_API_KEY, 'sk-or-first');
      assert.equal(parsed.FIRECRAWL_API_KEY, 'fc-second');
    } finally {
      restoreEnv('RAUTML_ENV_PATH', previous.envPath);
      restoreEnv('OPENROUTER_API_KEY', previous.openRouter);
      restoreEnv('FIRECRAWL_API_KEY', previous.firecrawl);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('env file upsert', () => {
  it('updates a managed key in place without touching its neighbours', () => {
    const before = [
      '# Rautml configuration',
      'OPENROUTER_API_KEY=sk-or-old',
      '',
      '# research',
      'FIRECRAWL_API_KEY=fc-keep-me',
      'SOME_OTHER_TOOL_TOKEN=leave-this-alone',
      '',
    ].join('\n');

    const after = upsertEnvText(before, { OPENROUTER_API_KEY: 'sk-or-new' });

    assert.equal(
      after,
      [
        '# Rautml configuration',
        'OPENROUTER_API_KEY=sk-or-new',
        '',
        '# research',
        'FIRECRAWL_API_KEY=fc-keep-me',
        'SOME_OTHER_TOOL_TOKEN=leave-this-alone',
        '',
      ].join('\n'),
    );
  });

  it('appends a key that is not present yet instead of duplicating one', () => {
    const after = upsertEnvText('OPENROUTER_API_KEY=sk-or-1\n', { FIRECRAWL_API_KEY: 'fc-1' });
    assert.equal(after, 'OPENROUTER_API_KEY=sk-or-1\n\nFIRECRAWL_API_KEY=fc-1\n');
    // Writing the same key twice must not grow the file.
    const again = upsertEnvText(after, { FIRECRAWL_API_KEY: 'fc-2' });
    assert.equal(again, 'OPENROUTER_API_KEY=sk-or-1\n\nFIRECRAWL_API_KEY=fc-2\n');
  });

  it('creates the file content from empty', () => {
    assert.equal(upsertEnvText('', { OPENROUTER_API_KEY: 'sk-or-1' }), 'OPENROUTER_API_KEY=sk-or-1\n');
  });

  it('clears a key with a tombstone so an exported value cannot return', () => {
    const after = upsertEnvText('OPENROUTER_API_KEY=sk-or-1\nFIRECRAWL_API_KEY=fc-1\n', {
      OPENROUTER_API_KEY: '   ',
    });
    assert.equal(after, 'OPENROUTER_API_KEY=\nFIRECRAWL_API_KEY=fc-1\n');
  });

  it('adds a tombstone when clearing a key absent from the file', () => {
    assert.equal(upsertEnvText('', { OPENROUTER_API_KEY: '' }), 'OPENROUTER_API_KEY=\n');
  });

  it('collapses pre-existing duplicates of a key it rewrites', () => {
    const after = upsertEnvText('OPENROUTER_API_KEY=a\nFIRECRAWL_API_KEY=fc\nOPENROUTER_API_KEY=b\n', {
      OPENROUTER_API_KEY: 'c',
    });
    assert.equal(after, 'OPENROUTER_API_KEY=c\nFIRECRAWL_API_KEY=fc\n');
  });

  it('handles `export` prefixes and surrounding whitespace', () => {
    const after = upsertEnvText('export FIRECRAWL_API_KEY = fc-old\n', { FIRECRAWL_API_KEY: 'fc-new' });
    assert.equal(after, 'FIRECRAWL_API_KEY=fc-new\n');
  });

  it('quotes values that would otherwise be misparsed', () => {
    const after = upsertEnvText('', { FIRECRAWL_API_KEY: 'has space #and hash' });
    assert.equal(after, 'FIRECRAWL_API_KEY="has space #and hash"\n');
  });

  it('ignores variables it does not manage', () => {
    const before = 'PORT=5175\n';
    assert.equal(upsertEnvText(before, { PORT: '9999' } as Record<string, string>), before);
  });

  it('preserves CRLF line endings', () => {
    const after = upsertEnvText('OPENROUTER_API_KEY=a\r\n', { OPENROUTER_API_KEY: 'b' });
    assert.equal(after, 'OPENROUTER_API_KEY=b\r\n');
  });
});

describe('env file parsing', () => {
  it('reads plain, quoted, exported, and commented values', () => {
    const parsed = parseEnvText(
      [
        '# a comment',
        'OPENROUTER_API_KEY=sk-or-1',
        'FIRECRAWL_API_KEY="has space"',
        "BROWSERBASE_API_KEY='single'",
        'export BROWSERBASE_PROJECT_ID = proj-1   # trailing note',
        'not a key line',
      ].join('\n'),
    );
    assert.deepEqual(parsed, {
      OPENROUTER_API_KEY: 'sk-or-1',
      FIRECRAWL_API_KEY: 'has space',
      BROWSERBASE_API_KEY: 'single',
      BROWSERBASE_PROJECT_ID: 'proj-1',
    });
  });

  it('round-trips a value written by upsertEnvText', () => {
    const value = 'has space #and hash';
    const parsed = parseEnvText(upsertEnvText('', { FIRECRAWL_API_KEY: value }));
    assert.equal(parsed.FIRECRAWL_API_KEY, value);
  });
});

describe('personalization', () => {
  it('round-trips through the settings table and trims', () => {
    writePersonalization({ designPreferences: '  I like diagrams.  ', aboutMe: 'Physicist.' });
    assert.deepEqual(readPersonalization(), {
      designPreferences: 'I like diagrams.',
      aboutMe: 'Physicist.',
    });
  });

  it('leaves an omitted field untouched', () => {
    writePersonalization({ designPreferences: 'Keep it simple.', aboutMe: 'Physicist.' });
    writePersonalization({ aboutMe: 'Historian.' });
    assert.deepEqual(readPersonalization(), {
      designPreferences: 'Keep it simple.',
      aboutMe: 'Historian.',
    });
  });

  it('caps each field so a pasted essay cannot eat the context window', () => {
    writePersonalization({ aboutMe: 'x'.repeat(PERSONALIZATION_MAX_CHARS + 500) });
    assert.equal(readPersonalization().aboutMe.length, PERSONALIZATION_MAX_CHARS);
    writePersonalization({ designPreferences: '', aboutMe: '' });
  });
});
