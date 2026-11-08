import compression from 'compression';
import express from 'express';
import { createHash } from 'node:crypto';
import { createServer, get } from 'node:http';
import { Writable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { ClientDisconnectedError, waitForDrain } from 'src/utils/response.js';

/** 只使用测试端口和合成JSONL；诊断压缩器监听器数量及响应关闭时的等待结果。 */
type CompressedFlow = {
  body: Buffer;
  expected: Buffer;
  encoding: string | undefined;
  drainCycles: number;
  retainedDrainListeners: number;
  error: unknown;
};

/** 无副作用的测试监听器；每个输出独立注册，供临时探针及既有所有者回调断言使用。 */
function ignoreEvent(): void {}

/** @param seed 合成数据种子。@returns 固定64KiB无私人内容的高熵载荷，确保真实压缩器产生多次背压。 */
function payload(seed: number): string {
  const bytes = Buffer.alloc(64 * 1024);
  let state = seed;
  for (let index = 0; index < bytes.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 255;
  }
  return bytes.toString('base64');
}

/**
 * 运行安装版本的Express压缩中间件与真实回环HTTP流，不接触生产端口、图库或数据库。
 * @param encoding 客户端协商的实际压缩方式。
 * @param termination 首次背压后正常继续、关闭或报错；正常路径由客户端缓慢读完。
 * @returns 解压前数据和监听器观测，所有临时socket和HTTP服务均在返回前关闭。
 */
async function compressedFlow(
  encoding: 'br' | 'gzip',
  termination: 'none' | 'close' | 'error' = 'none',
): Promise<CompressedFlow> {
  const lines = Array.from(
    { length: 24 },
    (_, index) => JSON.stringify({ id: index, payload: payload(index + 1) }) + '\n',
  );
  const expected = Buffer.from(lines.join(''));
  const writer = Promise.withResolvers<Pick<CompressedFlow, 'drainCycles' | 'retainedDrainListeners' | 'error'>>();
  const app = express();
  app.use(compression());
  // 与同步流相同的JSONL类型及默认压缩配置；只在测试中读取on()返回的实际drain发射器。
  app.get('/synthetic-jsonl', async (_request, response) => {
    response.type('application/jsonlines+json');
    let drainCycles = 0;
    let retainedDrainListeners = 0;
    let drainTarget: Writable | undefined;
    try {
      for (const line of lines) {
        if (response.write(line)) continue;
        drainCycles++;
        // 暂时注册后立即移除，仅取得compression返回的实际事件发射器。
        drainTarget = response.on('drain', ignoreEvent);
        drainTarget.off('drain', ignoreEvent);
        const waiting = waitForDrain(response);
        if (termination === 'close') {
          response.destroy();
        } else if (termination === 'error') {
          response.emit('error', new Error('Synthetic compressed response failure'));
        }
        await waiting;
        retainedDrainListeners = Math.max(retainedDrainListeners, drainTarget.listenerCount('drain'));
      }
      response.end();
      writer.resolve({ drainCycles, retainedDrainListeners, error: undefined });
    } catch (error) {
      retainedDrainListeners = Math.max(retainedDrainListeners, drainTarget?.listenerCount('drain') ?? 0);
      writer.resolve({ drainCycles, retainedDrainListeners, error });
      response.destroy();
    }
  });
  const server = createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic HTTP server has no TCP address');
    let body = Buffer.alloc(0);
    let contentEncoding: string | undefined;
    try {
      const incoming = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        get(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/synthetic-jsonl',
            headers: { 'Accept-Encoding': encoding },
          },
          resolve,
        ).once('error', reject);
      });
      contentEncoding = incoming.headers['content-encoding'];
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Synthetic response produced a non-buffer chunk');
        chunks.push(chunk);
        // 有意放慢消费，覆盖压缩输入背压与HTTP输出背压的实际衔接。
        await setTimeout(1);
      }
      body = Buffer.concat(chunks);
    } catch (error) {
      if (termination === 'none') throw error;
    }
    return { body, expected, encoding: contentEncoding, ...(await writer.promise) };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('waitForDrain', () => {
  /** 普通Writable背压只在真实drain后成功，注册的监听器全部回收。 */
  it('waits for a writable drain and removes its listeners', async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const waiting = waitForDrain(stream);
    stream.emit('drain');
    await waiting;
    for (const event of ['drain', 'close', 'error']) expect(stream.listenerCount(event)).toBe(0);
    stream.destroy();
  });

  /** 已经断开的响应不能挂到下一个永不发生的drain。 */
  it('rejects an already destroyed writable', async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    stream.destroy();
    await expect(waitForDrain(stream)).rejects.toBeInstanceOf(ClientDisconnectedError);
    for (const event of ['drain', 'close', 'error']) expect(stream.listenerCount(event)).toBe(0);
  });

  /** 错误保留原始对象，避免把真实I/O失败误归为成功或断开。 */
  it('propagates a writable error and cleans every listener', async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const error = new Error('Synthetic write failure');
    const waiting = waitForDrain(stream);
    stream.emit('error', error);
    await expect(waiting).rejects.toBe(error);
    for (const event of ['drain', 'close', 'error']) expect(stream.listenerCount(event)).toBe(0);
    stream.destroy();
  });

  /** 等待期间关闭的普通输出也立即拒绝，不能仅覆盖注册前已经destroy的情况。 */
  it('rejects when a plain writable closes during the wait', async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const waiting = waitForDrain(stream);
    stream.destroy();
    await expect(waiting).rejects.toBeInstanceOf(ClientDisconnectedError);
    for (const event of ['drain', 'close', 'error']) expect(stream.listenerCount(event)).toBe(0);
  });

  /** 后续close/error不改变已完成的等待，也不删除调用者自己的错误监听器。 */
  it('cleans idempotently without removing another owner error listener', async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    // 模拟调用者已有的错误处理，waitForDrain只能回收自己的回调。
    stream.on('error', ignoreEvent);
    const waiting = waitForDrain(stream);
    stream.emit('drain');
    await waiting;
    stream.emit('close');
    stream.emit('error', new Error('Synthetic later failure'));
    await expect(waiting).resolves.toBeUndefined();
    expect(stream.listenerCount('drain')).toBe(0);
    expect(stream.listenerCount('close')).toBe(0);
    expect(stream.listeners('error')).toEqual([ignoreEvent]);
    stream.destroy();
  });

  /** 使用真实Brotli/Gzip和慢消费证明流能完成，且每次等待不会向压缩器遗留drain监听器。 */
  it.each(['br', 'gzip'] as const)(
    'finishes slow %s JSONL without retaining compressor drain listeners',
    async (encoding) => {
      const result = await compressedFlow(encoding);
      expect(result.encoding).toBe(encoding);
      const decoded = encoding === 'br' ? brotliDecompressSync(result.body) : gunzipSync(result.body);
      expect(createHash('sha256').update(decoded).digest()).toEqual(
        createHash('sha256').update(result.expected).digest(),
      );
      expect(result.error).toBeUndefined();
      expect(result.drainCycles).toBeGreaterThan(10);
      expect(result.retainedDrainListeners).toBe(0);
    },
    10_000,
  );

  /** 响应在实际压缩等待期间关闭时及时拒绝，并从正确的压缩器移除残留监听器。 */
  it.each(['br', 'gzip'] as const)(
    'rejects a closed %s response and removes compressor drain listeners',
    async (encoding) => {
      const result = await compressedFlow(encoding, 'close');
      expect(result.drainCycles).toBe(1);
      expect(result.error).toBeInstanceOf(ClientDisconnectedError);
      expect(result.retainedDrainListeners).toBe(0);
    },
    10_000,
  );

  /** 压缩响应报错后保留真实失败，同时从被转发的drain目标回收所有本次回调。 */
  it.each(['br', 'gzip'] as const)(
    'propagates a %s response error and removes compressor drain listeners',
    async (encoding) => {
      const result = await compressedFlow(encoding, 'error');
      expect(result.drainCycles).toBe(1);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error).toMatchObject({ message: 'Synthetic compressed response failure' });
      expect(result.retainedDrainListeners).toBe(0);
    },
    10_000,
  );
});
