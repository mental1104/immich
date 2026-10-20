// 仅映射产品名与元数据型号别名；用户实际使用过的型号始终由鉴权后的图库建议接口提供。
const aliases = [
  { label: 'Insta360 GO 3S', models: ['Insta360 GO 3S'] },
  { label: 'Insta360 X5', models: ['Insta360 X5'] },
  { label: 'DJI Action 5 Pro', models: ['DJI OsmoAction5 Pro', 'AC004'] },
  { label: 'DJI Pocket 3', models: ['DJI OsmoPocket3', 'PP-101'] },
  { label: 'DJI Mini 4 Pro', models: ['DJI Mini4 Pro', 'FC8482'] },
] as const;

const normalizedModel = (model: string) => model.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

export function deviceLabel(model: string): string {
  return (
    aliases.find((device) => device.models.some((alias) => normalizedModel(alias) === normalizedModel(model)))?.label ??
    model
  );
}

export const isCameraMake = (make: string) => /^(nikon|canon|sony)(\s|$)/i.test(make.trim());
export const isCameraModel = (model: string) => /^(nikon\b|canon\b|sony\b|ilce-|ilca-|dsc-)/i.test(model.trim());
export const isCameraLens = (lens: string) =>
  /^(nikkor\b|nikon\b|af[- ]|canon\s+ef|ef[-\s0-9]|fe\s|e\s|sony\b|sigma\b|tamron\b)/i.test(lens.trim());

export function cameraLabel(model: string): string {
  return model
    .replace(/^NIKON Z5_2$/i, 'Nikon Z5 II')
    .replace(/^NIKON Z 6_2$/i, 'Nikon Z6 II')
    .replace(/^ILCE-7M4$/i, 'Sony α7 IV');
}

type DeviceOption = { label: string; models: string[]; group: 'iphone' | 'action' | 'other' };

export function deviceOptions(models: string[]) {
  const groups = new Map<string, DeviceOption>();
  for (const model of models) {
    if (!model.trim() || isCameraModel(model) || /^(lavf|replaykit)/i.test(model)) {
      continue;
    }
    const label = deviceLabel(model);
    const option: DeviceOption = groups.get(label) ?? {
      label,
      models: [],
      group: /^iphone/i.test(model) ? 'iphone' : /^(dji|insta360)/i.test(label) ? 'action' : 'other',
    };
    option.models.push(model);
    groups.set(label, option);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export function selectedDeviceLabel(models?: string[]) {
  return models?.length ? [...new Set(models.map((model) => deviceLabel(model)))].join(' / ') : undefined;
}
