import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import sharp from 'sharp';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { PhotoEditUploadDto } from 'src/dtos/photo-edit-advice.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetType, AssetVisibility, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { PhotoEditAdviceRepository, type PhotoEditVersion } from 'src/repositories/photo-edit-advice.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { PhotoCopilotService } from 'src/services/photo-copilot.service.js';
import { StackService } from 'src/services/stack.service.js';
import { requireAccess } from 'src/utils/access.js';
import { isWithinDirectory } from 'src/utils/iphone-backup.js';
import {
  type PhotoEditReport,
  measurePhotoEditImage,
  photoEditMarkdown,
  photoEditPlan,
  photoEditReport,
  photoEditReview,
  renderPhotoEdit,
} from 'src/utils/photo-edit-advice.js';

const planPrompt = `你是高标准摄影后期指导专家。先判断是否值得修和后期可救分 0–10，直说最大后期问题。
检查曝光、白平衡、层次、主体分离、背景、色彩与可恢复范围。只给一个主要后期方向和选择理由，只讲后期。
分别给 Lightroom 移动端、Snapseed、Photomator 三套工具步骤。按裁剪/校正、光线和白平衡、颜色、局部与细节、导出组织，
仅保留适用步骤。每步写具体工具、起始范围或方向以及画面检查点。Photomator 按其基本、白平衡、曲线、选择性颜色和局部选区工具，
Snapseed 按调整图片、局部、画笔等实际能力写。软件滑块刻度不能直接互换。给蒙版和曲线是否需要、目的及停止条件。
若不值得精修，给三套简短止损流。区分可改善与不可修。解释提供的 8 位亮度统计；预览不能证明 RAW 剩余动态范围。
render 字段只用于轻度自动效果图：crop 四边裁掉的百分比，exposure 为 EV，warmth 为 RGB 暖度近似（0 中性），
contrast 为相对增量（0 中性），saturation 为倍数（1 中性）。能保持的项目用中性值。禁止虚构已经使用局部工具。`;

const reviewPrompt = `你是高标准摄影后期指导专家。第 1 张是原片输入，第 2 张是当前手工上传的后期版本，
第 3 张若存在则是它的直接父版本。先评价当前是否可用，再说明相对原片和父版本有哪些改善、退步和修过头的地方。
从曝光、明暗层次、主体、色彩、裁剪和可见瑕疵出发，只给最值得改的下一项，尽量用上传者选择的后期软件给具体操作。
允许不同裁剪和风格，指出它们对视觉目标的影响。实际亮度统计由服务端提供，不能当作 RAW 的动态范围。`;

const imageFormats = { jpeg: 'jpg', png: 'png', webp: 'webp', tiff: 'tiff', heif: 'heic' } as const;
const imageMime = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
  heic: 'image/heic',
} as const;

/** 工作台文件只在受配置保护的目录发布，版本任务与 Codex 线程不写图库。 */
@Injectable()
export class PhotoEditAdviceService {
  private analysisTail = Promise.resolve();
  private analyzing = new Set<string>();
  private commits = new Map<string, Promise<PhotoEditVersion>>();

  /**
   * @param versions 版本索引及提交状态。
   * @param assets 原片归属和图库资产查询。
   * @param access Immich 原生逐资产权限。
   * @param libraries 外部扫描目录，工作台与其保持分离。
   * @param copilot 同一个隔离的 Codex 进程与媒体解析能力。
   * @param media 明确提交时的原生上传流程。
   * @param stacks 保留已有成员的原生叠放追加。
   */
  constructor(
    private versions: PhotoEditAdviceRepository,
    private assets: AssetRepository,
    private access: AccessRepository,
    private libraries: LibraryRepository,
    private copilot: PhotoCopilotService,
    private media: AssetMediaService,
    private stacks: StackService,
  ) {}

  /** @returns 工作台是否已设置独立目录；已保存版本可在模型暂停时继续访问。 */
  status() {
    return { enabled: Boolean(process.env.IMMICH_PHOTO_EDIT_DIR), analysisEnabled: this.copilot.status().enabled };
  }

  /** @param auth 登录用户。@returns 当前用户的工作台入口和仍可浏览的原片索引。 */
  async projects(auth: AuthDto) {
    return { ...this.status(), projects: this.status().enabled ? await this.versions.projects(auth.user.id) : [] };
  }

  /** @param auth 登录用户。@param assetId 待修原片。@returns 原片名与完整版本历史。 */
  async list(auth: AuthDto, assetId: string) {
    const source = await this.source(auth, assetId);
    const versions = await this.versions.list(auth.user.id, assetId);
    return { assetId, assetName: source.originalFileName, versions: versions.map((version) => this.view(version)) };
  }

  /** @param auth 登录用户。@param assetId 待修原片。@param id 版本 ID。@returns 版本与已完成报告，尚未生成时报告为空。 */
  async get(auth: AuthDto, assetId: string, id: string) {
    await this.source(auth, assetId);
    const version = await this.version(auth, assetId, id);
    const report =
      version.state === 'ready'
        ? photoEditReport.parse(JSON.parse(await readFile(path.join(this.directory(version), 'report.json'), 'utf8')))
        : null;
    return { ...this.view(version), report };
  }

  /** @param auth 登录用户。@param assetId 待修原片。@returns 已受理的新 Codex 版本。 */
  async generate(auth: AuthDto, assetId: string) {
    if (!this.copilot.status().enabled) throw new ServiceUnavailableException('Photo Copilot analysis is disabled');
    await this.validateRoot();
    const source = await this.source(auth, assetId);
    const row = await this.versions.create({
      id: randomUUID(),
      ownerId: auth.user.id,
      assetId,
      assetName: source.originalFileName,
      parentId: null,
      kind: 'codex',
      editor: null,
      filename: 'codex-preview.jpg',
      extension: 'jpg',
      note: '',
    });
    this.enqueue(auth, row);
    return this.view(row);
  }

  /**
   * @param auth 登录用户。@param assetId 待修原片。@param dto 软件、备注和父版本。
   * @param file 完整 multipart 图像，单文件大小由路由限制。
   * @returns 保存原始上传字节后的版本。分析失败也保留该版本及文件。
   */
  async upload(auth: AuthDto, assetId: string, dto: PhotoEditUploadDto, file?: Express.Multer.File) {
    await this.validateRoot();
    const source = await this.source(auth, assetId);
    if (dto.parentId) await this.version(auth, assetId, dto.parentId);
    if (!file?.size) throw new BadRequestException('An edited image file is required');
    const meta = await sharp(file.buffer, { limitInputPixels: 100_000_000 })
      .metadata()
      .catch(() => null);
    const format = meta?.format;
    const extension =
      format && Object.hasOwn(imageFormats, format) ? imageFormats[format as keyof typeof imageFormats] : undefined;
    if (!extension || (meta?.pages ?? 1) > 1 || (format === 'heif' && meta?.compression !== 'hevc')) {
      throw new BadRequestException('Upload a single JPEG, PNG, WebP, TIFF, or HEIC image');
    }
    const id = randomUUID();
    const assetName = source.originalFileName;
    const basename = sanitize(path.parse(file.originalname.replaceAll('\\', '/')).name).slice(0, 180);
    const filename = (basename || 'edited') + '.' + extension;
    const directory = this.directory({ ownerId: auth.user.id, id });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await this.preview(file.buffer, path.join(directory, 'preview.jpg'));
      await writeFile(path.join(directory, 'image.' + extension), file.buffer, { flag: 'wx', mode: 0o600 });
    } catch {
      await rm(directory, { recursive: true, force: true });
      throw new BadRequestException('The uploaded image could not be decoded or saved');
    }
    const row = await this.versions.create({
      id,
      ownerId: auth.user.id,
      assetId,
      assetName,
      parentId: dto.parentId ?? null,
      kind: 'upload',
      editor: dto.editor,
      filename,
      extension,
      note: dto.note ?? '',
    });
    if (this.copilot.status().enabled) this.enqueue(auth, row);
    return this.view(row);
  }

  /** @param auth 登录用户。@param assetId 待修原片。@param id 版本。@returns 重试后的状态，已有报告保留。 */
  async retry(auth: AuthDto, assetId: string, id: string) {
    if (!this.copilot.status().enabled) throw new ServiceUnavailableException('Photo Copilot analysis is disabled');
    await this.validateRoot();
    await this.source(auth, assetId);
    const version = await this.version(auth, assetId, id);
    if (version.state === 'ready' || this.analyzing.has(id)) return this.view(version);
    const pending = await this.versions.update(id, { state: 'pending' });
    this.enqueue(auth, pending);
    return this.view(pending);
  }

  /**
   * @param auth 登录用户。@param assetId 待修原片。@param id 手工上传的版本。
   * @returns 已发布的版本。重复点击、请求断线和重启复用同一原生资产 ID。
   */
  async commit(auth: AuthDto, assetId: string, id: string) {
    const source = await this.source(auth, assetId);
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: [assetId] });
    const version = await this.version(auth, assetId, id);
    if (version.kind !== 'upload') throw new BadRequestException('Only manually uploaded photos can enter the stack');
    if (version.committedAt) return this.view(version);
    let commit = this.commits.get(id);
    if (!commit) {
      commit = this.publish(auth, version, source.fileCreatedAt).finally(() => this.commits.delete(id));
      this.commits.set(id, commit);
    }
    return this.view(await commit);
  }

  /** @param auth 登录用户。@param assetId 待修原片。@param id 版本。@param file 文件用途。@returns 私有文件流。 */
  async file(auth: AuthDto, assetId: string, id: string, file: 'original' | 'preview' | 'image' | 'report') {
    await this.source(auth, assetId);
    const version = await this.version(auth, assetId, id);
    if (version.state !== 'ready' && (version.kind === 'codex' || file === 'report' || file === 'original')) {
      throw new NotFoundException('Photo edit result is not ready');
    }
    const inline = file === 'original' || file === 'preview';
    const name =
      file === 'original'
        ? 'original-input.jpg'
        : file === 'preview'
          ? 'preview.jpg'
          : file === 'report'
            ? 'report.md'
            : 'image.' + version.extension;
    const type = inline
      ? 'image/jpeg'
      : file === 'report'
        ? 'text/markdown; charset=utf-8'
        : imageMime[version.extension];
    const filename = path.join(this.directory(version), name);
    const info = await stat(filename).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException('Photo edit file is unavailable');
    return new StreamableFile(createReadStream(filename), {
      type,
      length: info.size,
      disposition: inline ? 'inline' : `attachment; filename="${name}"`,
    });
  }

  /** @param auth 登录用户。@param assetId 原片 ID。@returns 当前可访问且属于本人的图库照片。 */
  private async source(auth: AuthDto, assetId: string) {
    this.root();
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [assetId] });
    const asset = await this.assets.getById(assetId);
    if (
      !asset ||
      asset.ownerId !== auth.user.id ||
      asset.type !== AssetType.Image ||
      asset.deletedAt ||
      (asset.visibility !== AssetVisibility.Timeline && asset.visibility !== AssetVisibility.Archive)
    ) {
      throw new NotFoundException('Photo edit workbench requires an owned, visible photo');
    }
    return asset;
  }

  /** @param auth 登录用户。@param assetId 原片。@param id 版本。@returns 同一原片及所有者的版本。 */
  private async version(auth: AuthDto, assetId: string, id: string) {
    const result = await this.versions.get(auth.user.id, assetId, id);
    if (!result) throw new NotFoundException('Photo edit version not found');
    return result;
  }

  /** @returns 管理员指定的绝对目录，未配置时保持功能停用。 */
  private root(): string {
    const root = process.env.IMMICH_PHOTO_EDIT_DIR;
    if (!root || !path.isAbsolute(root))
      throw new ServiceUnavailableException('Configure an absolute IMMICH_PHOTO_EDIT_DIR');
    return path.resolve(root);
  }

  /** 检查实际路径和图库扫描路径是否重叠，拒绝将工作台写入媒体目录。 */
  private async validateRoot(): Promise<void> {
    const root = await realpath(this.root()).catch(() => null);
    const directory = root ? await stat(root).catch(() => null) : null;
    if (!root || !directory?.isDirectory()) {
      throw new ServiceUnavailableException('Photo edit storage directory is unavailable');
    }
    const libraries = await this.libraries.getAll();
    const inputs = [StorageCore.getMediaLocation(), ...libraries.flatMap(({ importPaths }) => importPaths)];
    const paths = await Promise.all(inputs.map((item) => realpath(item).catch(() => path.resolve(item))));
    if (paths.some((item) => isWithinDirectory(item, root) || isWithinDirectory(root, item))) {
      throw new ServiceUnavailableException('Photo edit storage must be separate from Immich media and import paths');
    }
  }

  /** @param version 已授权版本的用户与 UUID。@returns 工作台下的私有目录。 */
  private directory(version: Pick<PhotoEditVersion, 'ownerId' | 'id'>): string {
    return path.join(this.root(), version.ownerId, version.id);
  }

  /** @param version 数据库行。@returns Web 使用的字段及当前进程中是否正在排队或分析。 */
  private view({ ownerId: _ownerId, ...version }: PhotoEditVersion) {
    return { ...version, analyzing: this.analyzing.has(version.id) };
  }

  /** @param input 已授权图像或上传字节。@param target 工作台内 JPEG。生成统一定向的 sRGB 图供模型和浏览器使用。 */
  private async preview(input: string | Buffer, target: string): Promise<void> {
    await sharp(input, { limitInputPixels: 100_000_000 })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .jpeg({ quality: 93 })
      .toFile(target);
  }

  /** @param auth 任务所属用户。@param version 已持久化版本。单个后台分析顺序运行，关闭浏览器不取消。 */
  private enqueue(auth: AuthDto, version: PhotoEditVersion): void {
    if (this.analyzing.has(version.id)) return;
    this.analyzing.add(version.id);
    this.analysisTail = this.analysisTail.then(async () => {
      try {
        await this.analyze(auth, version);
        await this.versions.update(version.id, { state: 'ready' });
      } catch {
        await this.versions.update(version.id, { state: 'failed' }).catch(() => {});
      } finally {
        this.analyzing.delete(version.id);
      }
    });
  }

  /** @param auth 当前任务用户。@param version 目标版本。保存真实分析输入、报告和可选的 Codex 效果图。 */
  private async analyze(auth: AuthDto, version: PhotoEditVersion): Promise<void> {
    await this.source(auth, version.assetId);
    const directory = this.directory(version);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const input = path.join(directory, 'original-input.jpg');
    const original = await this.copilot.photoImage(auth, version.assetId);
    try {
      if (!original.path) throw new Error('No readable original image or preview');
      await this.preview(original.path, input);
    } finally {
      if (original.temporary && original.path) await unlink(original.path).catch(() => {});
    }

    const histogram = await measurePhotoEditImage(input);
    let report: PhotoEditReport;
    if (version.kind === 'codex') {
      const plan = await this.copilot.analyzePhoto(
        planPrompt,
        [input],
        { source: original.source, histogram },
        photoEditPlan,
      );
      await renderPhotoEdit(input, path.join(directory, 'image.jpg'), plan.render);
      await this.preview(path.join(directory, 'image.jpg'), path.join(directory, 'preview.jpg'));
      report = { kind: 'codex', source: original.source, original: histogram, plan };
    } else {
      const editedFile = path.join(directory, 'preview.jpg');
      const images = [input, editedFile];
      let parent = null;
      if (version.parentId) {
        const parentVersion = await this.version(auth, version.assetId, version.parentId);
        const parentFile = path.join(this.directory(parentVersion), 'preview.jpg');
        const info = await stat(parentFile).catch(() => null);
        if (info?.isFile() && (parentVersion.kind === 'upload' || parentVersion.state === 'ready')) {
          parent = await measurePhotoEditImage(parentFile);
          images.push(parentFile);
        }
      }
      const edited = await measurePhotoEditImage(editedFile);
      const review = await this.copilot.analyzePhoto(
        reviewPrompt,
        images,
        {
          source: original.source,
          original: histogram,
          parent,
          edited,
          editor: version.editor,
          note: version.note,
        },
        photoEditReview,
      );
      report = { kind: 'upload', source: original.source, original: histogram, parent, edited, review };
    }
    await writeFile(path.join(directory, 'report.md.tmp'), photoEditMarkdown(report), { mode: 0o600 });
    await writeFile(path.join(directory, 'report.json.tmp'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await rename(path.join(directory, 'report.md.tmp'), path.join(directory, 'report.md'));
    await rename(path.join(directory, 'report.json.tmp'), path.join(directory, 'report.json'));
  }

  /**
   * @param auth 已授权用户。@param version 已保存的手工版本。@param capturedAt 原片日期。
   * @returns 完成原生入库和叠放后保存提交时间。中断时保留工作台字节和原生隐藏资产供重试。
   */
  private async publish(auth: AuthDto, version: PhotoEditVersion, capturedAt: Date): Promise<PhotoEditVersion> {
    const sourcePath = path.join(this.directory(version), 'image.' + version.extension);
    const result = await this.media.importPhotoEdit(auth, version.id, sourcePath, version.filename, capturedAt);
    if (result.status === AssetMediaStatus.DUPLICATE) {
      throw new ConflictException('An identical photo already exists in Immich');
    }
    await this.stacks.appendPhotoEdit(auth, version.assetId, version.id);
    return this.versions.update(version.id, { committedAt: new Date() });
  }
}
