import { CookieOptions, Response } from 'express';
import { Duration } from 'luxon';
import { Writable } from 'node:stream';
import { CookieResponse } from 'src/dtos/auth.dto.js';
import { ImmichCookie } from 'src/enum.js';

export class ClientDisconnectedError extends Error {}

/**
 * 等待一次已发生背压的写入恢复；响应关闭或出错时拒绝，并只回收本次注册的监听器。
 * @param response write() 已返回 false 的输出；压缩中间件可以将 drain 注册转发至内部流。
 * @returns drain 后完成；断开时抛 ClientDisconnectedError，其它错误保留原对象。
 */
export const waitForDrain = (response: Writable) =>
  new Promise<void>((resolve, reject) => {
    let drainTarget = response;
    /** 从实际注册的发射器清理，不能假定 compression 转发后的 drain 仍属于 response。 */
    const cleanup = () => {
      drainTarget.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };

    /** 手动实现一次性完成，使清理作用于 on() 返回的真实压缩流。 */
    const onDrain = () => {
      cleanup();
      resolve();
    };

    /** 客户端断开不能继续等一个不会到达的 drain。 */
    const onClose = () => {
      cleanup();
      reject(new ClientDisconnectedError());
    };

    /** @param error 输出本身报告的错误，不将其改写成普通断开。 */
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    response.once('close', onClose);
    response.once('error', onError);
    // EventEmitter.once() 固定返回原 response；compression.on('drain') 才返回实际压缩器。
    drainTarget = response.on('drain', onDrain);

    // 关闭事件可能早于注册；此路径也必须移除刚注册到压缩器上的回调。
    if (response.destroyed) {
      onClose();
    }
  });

export const respondWithCookie = <T>(res: Response, body: T, { isSecure, values }: CookieResponse) => {
  const defaults: CookieOptions = {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: isSecure,
    maxAge: Duration.fromObject({ days: 400 }).toMillis(),
  };

  const cookieOptions: Record<ImmichCookie, CookieOptions> = {
    [ImmichCookie.AuthType]: defaults,
    [ImmichCookie.AccessToken]: defaults,
    [ImmichCookie.MaintenanceToken]: { ...defaults, maxAge: Duration.fromObject({ days: 1 }).toMillis() },
    [ImmichCookie.OAuthState]: defaults,
    [ImmichCookie.OAuthCodeVerifier]: defaults,
    // no httpOnly so that the client can know the auth state
    [ImmichCookie.IsAuthenticated]: { ...defaults, httpOnly: false },
    [ImmichCookie.SharedLinkToken]: { ...defaults, maxAge: Duration.fromObject({ days: 1 }).toMillis() },
  };

  for (const { key, value } of values) {
    const options = cookieOptions[key];
    res.cookie(key, value, options);
  }

  return body;
};

export const respondWithoutCookie = <T>(res: Response, body: T, cookies: ImmichCookie[]) => {
  for (const cookie of cookies) {
    res.clearCookie(cookie);
  }

  return body;
};
