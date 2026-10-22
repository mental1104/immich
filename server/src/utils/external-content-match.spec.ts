import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashExternalContentFile, isReusableExternalContentHash } from 'src/utils/external-content-match.js';

describe('external content matching', () => {
  it('hashes the original bytes without modifying the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'immich-content-match-'));
    const filename = join(root, 'sample.bin');
    const contents = Buffer.from('same bytes across imported and uploaded assets');
    try {
      await writeFile(filename, contents);
      const expected = createHash('sha1').update(contents).digest('hex');
      expect(await hashExternalContentFile(filename)).toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale and malformed cached hashes', () => {
    const stat = { size: 100, mtimeMs: 1234 } as import('node:fs').Stats;
    const valid = { sha1: 'a'.repeat(40), size: 100, mtimeMs: 1234, published: false };
    expect(isReusableExternalContentHash(valid, stat)).toBe(true);
    expect(isReusableExternalContentHash({ ...valid, size: 101 }, stat)).toBe(false);
    expect(isReusableExternalContentHash({ ...valid, sha1: 'bad' }, stat)).toBe(false);
    expect(isReusableExternalContentHash(undefined, stat)).toBe(false);
  });
});
