import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

/** @returns 可手动控制且不持有真实文件描述符的文件流，故意不实现信号处理。 */
function newControlledFileStream() {
  const stream = new PassThrough();
  return Object.assign(stream, {
    bytesRead: 0,
    path: '/synthetic',
    pending: false,
    close: () => stream.destroy(),
  });
}

/** 文件系统没有完成关闭回调时，调用方仍能取消只读摘要，迟到结果不会被发布。 */
it('cancels a read whose source ignores the abort signal', async () => {
  const stream = newControlledFileStream();
  vi.mocked(createReadStream).mockReturnValueOnce(stream);
  await expect(
    new CryptoRepository().hashFile('/synthetic', { signal: AbortSignal.timeout(20) }),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(stream.destroyed).toBe(true);
});

/** 只有 close、没有 end 的读取必须报错，防止旧实现留下永不完成的 Promise。 */
it('rejects a source that closes before EOF', async () => {
  const stream = newControlledFileStream();
  vi.mocked(createReadStream).mockReturnValueOnce(stream);
  const result = new CryptoRepository().hashFile('/synthetic');
  const failure = expect(result).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
  stream.destroy();
  await failure;
});

/** 校验取消信号不改变正常文件摘要，并使已取消的读取明确失败。 */
it('hashes complete files and rejects cancelled reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'immich-file-hash-'));
  const file = path.join(root, 'synthetic.bin');
  const bytes = Buffer.alloc(1024 * 1024, 17);
  const repository = new CryptoRepository();
  try {
    await writeFile(file, bytes);
    expect(await repository.hashFile(file)).toEqual(createHash('sha1').update(bytes).digest());
    await expect(repository.hashFile(file, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(await repository.hashFile(file)).toEqual(createHash('sha1').update(bytes).digest());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
