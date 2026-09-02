export type ImageAdjustments = {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  warmth: number;
  sharpness: number;
  gamma: number;
};

export const IMAGE_ADJUSTMENTS_KEY = 'tuncam-image-adjustments-v1';

export const DEFAULT_IMAGE_ADJUSTMENTS: ImageAdjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  exposure: 0,
  warmth: 0,
  sharpness: 0,
  gamma: 1,
};

/** Tuned to approximate natural indoor inspection lighting */
export const HUMAN_EYE_PRESET: ImageAdjustments = {
  brightness: 108,
  contrast: 112,
  saturation: 110,
  exposure: 6,
  warmth: 12,
  sharpness: 18,
  gamma: 1.05,
};

export const INDOOR_WARM_PRESET: ImageAdjustments = {
  brightness: 105,
  contrast: 108,
  saturation: 105,
  exposure: 4,
  warmth: 28,
  sharpness: 10,
  gamma: 1.02,
};

export const BRIGHT_OVERHEAD_PRESET: ImageAdjustments = {
  brightness: 115,
  contrast: 118,
  saturation: 98,
  exposure: 12,
  warmth: -8,
  sharpness: 22,
  gamma: 0.98,
};

export function loadImageAdjustments(): ImageAdjustments {
  try {
    const raw = localStorage.getItem(IMAGE_ADJUSTMENTS_KEY);
    if (!raw) return DEFAULT_IMAGE_ADJUSTMENTS;
    return { ...DEFAULT_IMAGE_ADJUSTMENTS, ...JSON.parse(raw) as Partial<ImageAdjustments> };
  } catch {
    return DEFAULT_IMAGE_ADJUSTMENTS;
  }
}

export function saveImageAdjustments(adjustments: ImageAdjustments) {
  try {
    localStorage.setItem(IMAGE_ADJUSTMENTS_KEY, JSON.stringify(adjustments));
  } catch { /* ignore */ }
}

export function adjustmentsToCssFilter(adjustments: ImageAdjustments): string {
  const brightness = (adjustments.brightness + adjustments.exposure) / 100;
  const contrast = (adjustments.contrast + adjustments.sharpness * 0.15) / 100;
  const saturate = adjustments.saturation / 100;
  const hue = adjustments.warmth * 0.45;
  const sepia = Math.max(0, adjustments.warmth / 180);
  const gammaLift = adjustments.gamma !== 1 ? ` contrast(${((adjustments.gamma - 1) * 8 + 100) / 100})` : '';
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturate}) hue-rotate(${hue}deg) sepia(${sepia})${gammaLift}`;
}

export function isDefaultAdjustments(adjustments: ImageAdjustments) {
  return JSON.stringify(adjustments) === JSON.stringify(DEFAULT_IMAGE_ADJUSTMENTS);
}
