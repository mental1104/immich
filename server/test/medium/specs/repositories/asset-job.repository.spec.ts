import { Kysely } from 'kysely';
import { AssetFileType } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const consume = async <T>(generator: AsyncIterableIterator<T>) => {
  const values: T[] = await Array.fromAsync(generator);

  return values;
};

let defaultDatabase: Kysely<DB>;

// eslint-disable-next-line unicorn/no-unnecessary-parameters
const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetJobRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetJobRepository.name, () => {
  /** 已入库路径和备份暂存路径不增加分母；同路径在不同图库中是独立候选。 */
  it('counts only unregistered paths in the library intake denominator', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const libraryRepository = ctx.get(LibraryRepository);
    const libraryDto = { ownerId: user.id, name: 'Intake progress', importPaths: [], exclusionPatterns: [] };
    const library = await libraryRepository.create(libraryDto);
    const otherLibrary = await libraryRepository.create(libraryDto);
    const deletedLibrary = await libraryRepository.create(libraryDto);
    await libraryRepository.update(deletedLibrary.id, { deletedAt: new Date() });

    const originalPath = '/intake/imported.jpg';
    const backupOriginalPath = '/intake/version.jpg';
    await ctx.newAsset({ ownerId: user.id, libraryId: library.id, isExternal: true, originalPath, backupOriginalPath });

    const baseline = await sut.getMetadataExtractionProgress([]);
    const pendingPath = '/intake/pending.jpg';
    const pending = [
      { libraryId: library.id, path: originalPath },
      { libraryId: library.id, path: backupOriginalPath },
      { libraryId: library.id, path: pendingPath },
      { libraryId: otherLibrary.id, path: originalPath },
      { libraryId: deletedLibrary.id, path: pendingPath },
    ];
    const progress = await sut.getMetadataExtractionProgress(pending);
    expect(progress.pipeline.library).toMatchObject({
      completed: baseline.pipeline.library.completed,
      total: baseline.pipeline.library.total + 2,
      queued: 2,
    });
    expect(progress.total).toBe(baseline.total);

    // 导入任务可能在写入资产后仍处于运行状态，分母必须保持稳定。
    await ctx.newAsset({ ownerId: user.id, libraryId: library.id, isExternal: true, originalPath: pendingPath });
    const afterImport = await sut.getMetadataExtractionProgress(pending);
    expect(afterImport.pipeline.library).toMatchObject({
      completed: baseline.pipeline.library.completed + 1,
      total: progress.pipeline.library.total,
      queued: 1,
    });
  });

  describe('streamForThumbnailJob', () => {
    it('should work', async () => {
      const { sut } = setup();
      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it('should queue an asset with missing thumbnails', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(consume(stream)).resolves.toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should skip assets without missing thumbnails', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, thumbhash: Buffer.from('fake-thumbhash-buffer') });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should queue assets with a missing full size', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        thumbhash: Buffer.from('fake-thumbhash-buffer'),
        originalFileName: 'photo.cr2',
      });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should skip assets with after they have full size previews', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, thumbhash: Buffer.from('fake-thumbhash-buffer') });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.FullSize, path: 'fullsize.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should skip assets with web-compatible originals', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        thumbhash: Buffer.from('fake-thumbhash-buffer'),
        originalFileName: 'photo.jpg',
      });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });
  });

  describe('getForOcr', () => {
    it('should not return the edited preview file', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_edited.jpg',
        isEdited: true,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_unedited.jpg',
        isEdited: false,
      });

      const result = await sut.getForOcr(asset.id);

      expect(result).toEqual(
        expect.objectContaining({
          previewFile: 'preview_unedited.jpg',
        }),
      );
    });
  });
});
