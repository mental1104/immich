import { QueueName, type AssetResponseDto, type QueueResponseDto } from '@immich/sdk';
import { getPipelineAncestors, getPipelineState, pipelineNodes, pipelineEdges } from '$lib/utils/asset-pipeline';

const metadata = pipelineNodes.find(({ queue }) => queue === QueueName.MetadataExtraction)!;
const busyQueue = {
  name: QueueName.MetadataExtraction,
  isPaused: false,
  statistics: { active: 5, waiting: 20, paused: 0, delayed: 0, completed: 999, failed: 0 },
} as QueueResponseDto;

describe('asset processing graph', () => {
  it('never substitutes global queue activity for an asset task state', () => {
    const asset = { taskStatuses: [{ taskName: 'metadata-extraction', status: 'completed' }] } as AssetResponseDto;
    expect(getPipelineState(metadata, busyQueue, asset)).toBe('completed');
    expect(getPipelineState(metadata, busyQueue, { taskStatuses: [] } as unknown as AssetResponseDto)).toBe('unknown');
  });

  it('preserves recorded history when a feature is currently disabled', () => {
    const asset = { taskStatuses: [{ taskName: 'metadata-extraction', status: 'skipped' }] } as AssetResponseDto;
    expect(getPipelineState(metadata, busyQueue, asset, true)).toBe('skipped');
    expect(getPipelineState(metadata, busyQueue, undefined, true)).toBe('disabled');
  });

  it('does not interpret an empty queue or retained completed jobs as library completion', () => {
    expect(
      getPipelineState(metadata, { ...busyQueue, statistics: { ...busyQueue.statistics, active: 0, waiting: 0 } }),
    ).toBe('idle');
  });

  it('highlights the selected branch without including parallel analysis or RAW pairing', () => {
    const path = getPipelineAncestors(QueueName.FacialRecognition);
    expect(path.has(QueueName.FaceDetection)).toBe(true);
    expect(path.has(QueueName.ThumbnailGeneration)).toBe(true);
    expect(path.has(QueueName.MetadataExtraction)).toBe(true);
    expect(path.has(QueueName.Ocr)).toBe(false);
    expect(path.has(QueueName.SmartSearch)).toBe(false);
    expect(path.has(QueueName.NikonPairing)).toBe(false);
  });

  it('keeps disabled categories out of the graph and has no dependency cycles', () => {
    const nodes = new Set<QueueName>(pipelineNodes.map(({ queue }) => queue));
    expect(nodes.has(QueueName.VideoConversion)).toBe(false);
    expect(nodes.has(QueueName.Migration)).toBe(false);
    expect(nodes.has(QueueName.StorageTemplateMigration)).toBe(false);
    for (const edge of pipelineEdges) {
      expect(nodes.has(edge.from) && nodes.has(edge.to)).toBe(true);
      expect(getPipelineAncestors(edge.from).has(edge.to)).toBe(false);
    }
  });
});
