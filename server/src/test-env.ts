/**
 * Give every Node test worker its own database before application modules load.
 * Without this preload, parallel suites can race over the developer's live
 * server/data/rautml.db and trigger the corruption quarantine path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const testDataDir = mkdtempSync(path.join(tmpdir(), 'rautml-test-worker-'));
process.env.RAUTML_DATA_DIR = testDataDir;

process.once('exit', () => {
  try {
    rmSync(testDataDir, { recursive: true, force: true });
  } catch {
    // The operating system can clean up a stranded test directory later.
  }
});
