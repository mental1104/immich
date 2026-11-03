/**
 * 对显式配置的外部库检查、抽样或分批补算内容指纹。
 * 输入：status|sample|verify|backfill 和可选批量上限；数据库连接沿用 Server 环境变量。
 * 输出：仅不透明资产 ID、计数、字节和耗时，不输出原片名、路径、内容哈希或 EXIF。
 * 副作用：sample/backfill 仅更新该库资产的 contentChecksum；原片只读，其他模式不写数据库。
 */
import { Kysely, sql } from 'kysely';
import { readFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { getIphoneBackupConfig } from 'src/utils/iphone-backup.js';

/** Linux 进程 I/O 计数，用于区分缓存读取与实际设备读取；单位均为字节。 */
interface ReadIo {
  logicalBytes: number;
  diskBytes: number;
}

/** @returns 当前进程的逻辑和物理读取量；不支持 /proc 的环境返回零，不改变缓存状态。 */
async function readIo(): Promise<ReadIo> {
  const text = await readFile('/proc/self/io', 'utf8').catch(() => '');
  return {
    logicalBytes: Number(text.match(/^rchar:\s*(\d+)/m)?.[1] ?? 0),
    diskBytes: Number(text.match(/^read_bytes:\s*(\d+)/m)?.[1] ?? 0),
  };
}

/**
 * 执行一个有界批次；读取或校验失败时非零退出，已完成项可在下次批次中跳过。
 * @returns 检查或补算结束的 Promise；不修改原片，不执行队列或数据库迁移。
 */
async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'status';
  if (!['status', 'sample', 'verify', 'backfill'].includes(mode)) {
    throw new Error('Expected status, sample, verify, or backfill');
  }
  const limit = Number(process.argv[3] ?? (mode === 'backfill' ? 1000 : 24));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('Batch size must be between 1 and 10000');
  }
  const backup = getIphoneBackupConfig();
  if (!backup) {
    throw new Error('Configure the target iPhone backup library before running this command');
  }
  const { database } = new ConfigRepository().getEnv();
  const db = new Kysely<DB>(getKyselyConfig(database.config));
  try {
    const library = await db
      .selectFrom('library')
      .select('id')
      .where('id', '=', backup.libraryId)
      .where('deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
    const base = db
      .selectFrom('asset')
      .where('libraryId', '=', library.id)
      .where('isExternal', '=', true)
      .where('deletedAt', 'is', null)
      .where('isOffline', '=', false);
    if (mode === 'status') {
      const result = await base
        .select((eb) => [eb.fn.countAll().as('total'), eb.fn.count('contentChecksum').as('ready')])
        .executeTakeFirstOrThrow();
      console.info(
        JSON.stringify({
          event: 'fingerprint_status',
          libraryId: library.id,
          total: Number(result.total),
          ready: Number(result.ready),
          pending: Number(result.total) - Number(result.ready),
        }),
      );
      return;
    }

    // 抽样按扩展名轮转，既覆盖 HEIC/JPEG，也覆盖视频；正式补算按 UUID 稳定分页。
    const extension = sql<string>`lower(regexp_replace("asset"."originalFileName", '^.*[.]', ''))`;
    let query = base
      .select(['id', 'originalPath', 'contentChecksum'])
      .where('contentChecksum', mode === 'verify' ? 'is not' : 'is', null);
    if (mode !== 'backfill') {
      query = query.where(
        'id',
        'in',
        db
          .selectFrom('asset_exif')
          .select('assetId')
          .where('fileSizeInByte', '<=', 128 * 1024 ** 2),
      );
    }
    query =
      mode === 'backfill'
        ? query.orderBy('id')
        : query
            .orderBy(sql`row_number() over (partition by ${extension} order by "fileCreatedAt" desc, "id")`)
            .orderBy('id');
    const rows = await query.limit(limit).execute();
    const crypto = new CryptoRepository();
    const started = performance.now();
    const cpu = process.cpuUsage();
    const beforeIo = await readIo();
    const latencies: number[] = [];
    let completed = 0;
    let skipped = 0;
    let bytes = 0;

    for (const row of rows) {
      const before = await stat(row.originalPath);
      if (mode !== 'backfill' && before.size > 128 * 1024 ** 2) {
        skipped++;
        continue;
      }
      const itemStart = performance.now();
      const checksum = await crypto.hashFile(row.originalPath);
      const after = await stat(row.originalPath);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('Sample file changed while hashing');
      }
      if (mode === 'verify') {
        if (!row.contentChecksum?.equals(checksum)) {
          throw new Error('Stored fingerprint no longer matches the sample');
        }
      } else {
        // 只补空值；若另一个进程已经完成，保留其结果，不合并或替换任何资产。
        await db
          .updateTable('asset')
          .set({ contentChecksum: checksum })
          .where('id', '=', row.id)
          .where('libraryId', '=', library.id)
          .where('contentChecksum', 'is', null)
          .executeTakeFirstOrThrow();
      }
      const elapsedMs = performance.now() - itemStart;
      latencies.push(elapsedMs);
      bytes += before.size;
      completed++;
      console.info(
        JSON.stringify({
          event: mode === 'verify' ? 'fingerprint_verified' : 'fingerprint_prepared',
          assetId: row.id,
          bytes: before.size,
          elapsedMs: Math.round(elapsedMs),
        }),
      );
    }
    latencies.sort((a, b) => a - b);
    const elapsedMs = performance.now() - started;
    const cpuTime = process.cpuUsage(cpu);
    const afterIo = await readIo();
    console.info(
      JSON.stringify({
        event: 'fingerprint_batch_complete',
        mode,
        selected: rows.length,
        completed,
        skipped,
        bytes,
        elapsedMs: Math.round(elapsedMs),
        p50Ms: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
        p95Ms: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0,
        cpuMs: (cpuTime.user + cpuTime.system) / 1000,
        maxRssKiB: process.resourceUsage().maxRSS,
        logicalReadBytes: afterIo.logicalBytes - beforeIo.logicalBytes,
        diskReadBytes: afterIo.diskBytes - beforeIo.diskBytes,
        cacheState: 'uncontrolled',
      }),
    );
  } finally {
    await db.destroy();
  }
}

// 失败时只输出错误类型和代码，避免把底层 fs 异常中的私人原片路径写入验收日志。
main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'fingerprint_batch_failed',
      errorType: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'FAILED',
    }),
  );
  process.exitCode = 1;
});
