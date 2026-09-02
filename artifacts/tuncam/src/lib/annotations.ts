import type { Grade } from '@/lib/dataset';
import { findDeterminant } from '@/lib/determinants';

export type BboxAnnotation = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  determinantId: string;
  category: string;
  label: string;
  grade: Grade;
  tier: string;
};

const BBOX_PREFIX = 'bbox:v3:';

export function parseBboxAnnotations(annotations: string[] = []): BboxAnnotation[] {
  return annotations.flatMap((item) => {
    if (item.startsWith(BBOX_PREFIX)) {
      try {
        return [JSON.parse(item.slice(BBOX_PREFIX.length)) as BboxAnnotation];
      } catch {
        return [];
      }
    }
    if (item.startsWith('bbox:v2:')) {
      try {
        const legacy = JSON.parse(item.slice('bbox:v2:'.length)) as { id: string; x: number; y: number; w: number; h: number; label: string; grade: Grade };
        return [{
          id: legacy.id,
          x: legacy.x,
          y: legacy.y,
          w: legacy.w,
          h: legacy.h,
          determinantId: legacy.id,
          category: 'Legacy',
          label: legacy.label,
          grade: legacy.grade,
          tier: legacy.grade === 'A' ? 'Export/Sashimi' : legacy.grade === 'B' ? 'Planta' : 'Local',
        }];
      } catch {
        return [];
      }
    }
    if (item.startsWith('bbox:')) {
      const [x, y, w, h] = item.replace('bbox:', '').split(',').map(Number);
      if ([x, y, w, h].every((value) => Number.isFinite(value))) {
        return [{
          id: `legacy-${x}-${y}`,
          x, y, w, h,
          determinantId: `legacy-${x}-${y}`,
          category: 'Unlabeled',
          label: 'Unlabeled region',
          grade: 'B',
          tier: 'Planta',
        }];
      }
    }
    return [];
  });
}

export function serializeBboxAnnotation(box: BboxAnnotation) {
  return `${BBOX_PREFIX}${JSON.stringify(box)}`;
}

export function noteAnnotations(annotations: string[] = []) {
  return annotations.filter((item) => item.startsWith('note:') || (!item.startsWith('bbox:')));
}

export function hydrateBbox(box: BboxAnnotation): BboxAnnotation {
  const det = findDeterminant(box.determinantId);
  if (!det) return box;
  return {
    ...box,
    category: det.category,
    label: det.text,
    grade: det.grade,
    tier: det.tier,
  };
}
