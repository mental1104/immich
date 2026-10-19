import { AssetTypeEnum, MediaResolution } from '@immich/sdk';

export const mediaCategories = [
  {
    id: 'phone-video',
    flag: 'isPhoneVideo',
    title: 'phone_videos',
    description: 'phone_videos_description',
    type: AssetTypeEnum.Video,
  },
  {
    id: 'screenshot',
    flag: 'isScreenshot',
    title: 'screenshots',
    description: 'screenshots_description',
    type: AssetTypeEnum.Image,
  },
  {
    id: 'delta-screenshot',
    flag: 'isDeltaScreenshot',
    title: 'delta_screenshots',
    description: 'delta_screenshots_description',
    type: AssetTypeEnum.Image,
  },
  {
    id: 'steam-screenshot',
    flag: 'isSteamScreenshot',
    title: 'steam_screenshots',
    description: 'steam_screenshots_description',
    type: AssetTypeEnum.Image,
  },
  {
    id: 'switch-screenshot',
    flag: 'isSwitchScreenshot',
    title: 'switch_screenshots',
    description: 'switch_screenshots_description',
    type: AssetTypeEnum.Image,
  },
  {
    id: '3ds-screenshot',
    flag: 'isNintendo3dsScreenshot',
    title: '3ds_screenshots',
    description: '3ds_screenshots_description',
    type: AssetTypeEnum.Image,
  },
] as const;

export type MediaCategory = (typeof mediaCategories)[number]['id'];

export const resolutionPresets = [
  { value: MediaResolution.$720P, label: '720P', dimensions: '1280 × 720' },
  { value: MediaResolution.$1080P, label: '1080P', dimensions: '1920 × 1080' },
  { value: MediaResolution.$2K, label: '2K / QHD', dimensions: '2560 × 1440' },
  { value: MediaResolution.$4K, label: '4K', dimensions: '3840 × 2160 / 4096 × 2160' },
] as const;
