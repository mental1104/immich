import { Injectable } from '@nestjs/common';
import { compareSync, hash } from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash, createPublicKey, createVerify, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

@Injectable()
/** 提供密码、令牌和内容摘要；文件摘要只读并支持调用方取消。 */
export class CryptoRepository {
  randomUUID(): string {
    return randomUUID();
  }

  randomBytes(size: number) {
    return randomBytes(size);
  }

  hashBcrypt(data: string | Buffer, saltOrRounds: string | number) {
    return hash(data, saltOrRounds);
  }

  compareBcrypt(data: string | Buffer, encrypted: string) {
    return compareSync(data, encrypted);
  }

  hashSha256(value: string) {
    return createHash('sha256').update(value).digest();
  }

  verifySha256(value: string, encryptedValue: string, publicKey: string) {
    const publicKeyBuffer = Buffer.from(publicKey, 'base64');
    const cryptoPublicKey = createPublicKey({
      key: publicKeyBuffer,
      type: 'spki',
      format: 'pem',
    });

    const verifier = createVerify('SHA256');
    verifier.update(value);
    verifier.end();
    const encryptedValueBuffer = Buffer.from(encryptedValue, 'base64');
    return verifier.verify(cryptoPublicKey, encryptedValueBuffer);
  }

  hashSha1(value: string | Buffer): Buffer {
    return createHash('sha1').update(value).digest();
  }

  /**
   * 流式读取完整文件的 SHA-1；取消和提前关闭均报错，不能留下永不完成的摘要任务。
   * @param filepath 只读文件路径，兼容现有 Buffer 路径调用方。
   * @param options 可选取消信号；省略时保留既有无限时长读取策略。
   * @returns 完整文件摘要；读取失败、取消或未到 EOF 就关闭时拒绝。
   */
  async hashFile(filepath: string | Buffer, options?: { signal: AbortSignal }): Promise<Buffer> {
    options?.signal.throwIfAborted();
    const hash = createHash('sha1');
    const stream = createReadStream(filepath, options);
    // async iterator 会传播 premature close，并在退出时销毁流，避免只监听 end 遗漏终态。
    const read = (async () => {
      for await (const chunk of stream) {
        hash.update(chunk);
      }
      return hash.digest();
    })();
    const signal = options?.signal;
    if (!signal) return read;
    let onAbort!: () => void;
    try {
      return await Promise.race([
        read,
        new Promise<never>((_resolve, reject) => {
          // 内核读取可能尚未返回；此处只销毁只读流并结束调用，不允许迟到摘要继续触发发布。
          onAbort = () => {
            stream.destroy();
            reject(signal.reason);
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  randomBytesAsText(bytes: number) {
    return randomBytes(bytes).toString('base64').replaceAll(/\W/g, '');
  }

  signJwt(payload: string | object | Buffer, secret: string, options?: jwt.SignOptions): string {
    // eslint-disable-next-line import-x/no-named-as-default-member
    return jwt.sign(payload, secret, { algorithm: 'HS256', ...options });
  }

  verifyJwt<T = any>(token: string, secret: string): T {
    // eslint-disable-next-line import-x/no-named-as-default-member
    return jwt.verify(token, secret, { algorithms: ['HS256'] }) as T;
  }
}
