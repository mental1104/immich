import { QueueName, type AssetResponseDto, type QueueResponseDto } from '@immich/sdk';

export type PipelineQueue =
  | QueueName.Library
  | QueueName.MetadataExtraction
  | QueueName.ThumbnailGeneration
  | QueueName.NikonPairing
  | QueueName.SmartSearch
  | QueueName.FaceDetection
  | QueueName.Ocr
  | QueueName.DuplicateDetection
  | QueueName.FacialRecognition;
export type PipelineNode = { queue: PipelineQueue; x: number; y: number; taskName?: string };
export type PipelineEdge = { from: QueueName; to: QueueName; conditional?: boolean };
export const PIPELINE_NODE_WIDTH = 190;
export const PIPELINE_NODE_HEIGHT = 118;
export const PIPELINE_WIDTH = 1280;
export const PIPELINE_HEIGHT = 610;

// 表示新资源的自动触发关系；单项重扫不要求重新经过前置节点。
export const pipelineNodes: PipelineNode[] = [
  { queue: QueueName.Library, x: 24, y: 220 },
  { queue: QueueName.MetadataExtraction, x: 234, y: 220, taskName: 'metadata-extraction' },
  { queue: QueueName.ThumbnailGeneration, x: 444, y: 220, taskName: 'thumbnail-generation' },
  { queue: QueueName.NikonPairing, x: 444, y: 430 },
  { queue: QueueName.SmartSearch, x: 654, y: 40 },
  { queue: QueueName.FaceDetection, x: 654, y: 220, taskName: 'face-detection' },
  { queue: QueueName.Ocr, x: 654, y: 400 },
  { queue: QueueName.DuplicateDetection, x: 864, y: 40 },
  { queue: QueueName.FacialRecognition, x: 864, y: 220 },
];

export const pipelineEdges: PipelineEdge[] = [
  { from: QueueName.Library, to: QueueName.MetadataExtraction },
  { from: QueueName.MetadataExtraction, to: QueueName.ThumbnailGeneration },
  { from: QueueName.MetadataExtraction, to: QueueName.NikonPairing, conditional: true },
  { from: QueueName.ThumbnailGeneration, to: QueueName.SmartSearch },
  { from: QueueName.ThumbnailGeneration, to: QueueName.FaceDetection },
  { from: QueueName.ThumbnailGeneration, to: QueueName.Ocr },
  { from: QueueName.SmartSearch, to: QueueName.DuplicateDetection, conditional: true },
  { from: QueueName.FaceDetection, to: QueueName.FacialRecognition, conditional: true },
];

export type PipelineState =
  'completed' | 'queued' | 'running' | 'failed' | 'skipped' | 'unknown' | 'idle' | 'paused' | 'disabled' | 'present';

export function getPipelineState(
  node: PipelineNode,
  queue?: QueueResponseDto,
  asset?: AssetResponseDto,
  disabled = false,
): PipelineState {
  if (asset) {
    if (node.queue === QueueName.Library) {
      return 'present';
    }
    const task = asset.taskStatuses?.find(({ taskName }) => taskName === node.taskName);
    if (task && ['completed', 'queued', 'running', 'failed', 'skipped'].includes(task.status)) {
      return task.status as PipelineState;
    }
    return disabled ? 'disabled' : 'unknown';
  }
  if (disabled) {
    return 'disabled';
  }
  if (!queue) {
    return 'unknown';
  }
  if (queue.isPaused) {
    return 'paused';
  }
  if (queue.statistics.active > 0) {
    return 'running';
  }
  if (queue.statistics.waiting + queue.statistics.paused + queue.statistics.delayed > 0) {
    return 'queued';
  }
  return 'idle';
}

export function getPipelineAncestors(queue: QueueName): Set<QueueName> {
  const result = new Set<QueueName>([queue]);
  const pending = [queue];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const edge of pipelineEdges) {
      if (edge.to !== current || result.has(edge.from)) {
        continue;
      }

      result.add(edge.from);
      pending.push(edge.from);
    }
  }
  return result;
}
