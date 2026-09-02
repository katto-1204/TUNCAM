import type { Grade, SampleType } from '@/lib/dataset';

export type GradeTier = 'Export/Sashimi' | 'Planta' | 'Local';

export type Determinant = {
  id: string;
  sampleType: SampleType;
  grade: Grade;
  tier: GradeTier;
  category: string;
  text: string;
};

const tierForGrade = (grade: Grade): GradeTier => {
  if (grade === 'A') return 'Export/Sashimi';
  if (grade === 'B') return 'Planta';
  if (grade === 'C') return 'Local';
  return 'Local';
};

function buildDeterminants(
  sampleType: SampleType,
  grade: Grade,
  entries: { category: string; text: string }[],
): Determinant[] {
  const code = sampleType === 'Sashibo Core' ? 'SC' : 'TC';
  const tier = tierForGrade(grade);
  return entries.map((entry, index) => ({
    id: `${code}-${grade}-${entry.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`,
    sampleType,
    grade,
    tier,
    category: entry.category,
    text: entry.text,
  }));
}

const SHARED_A = [
  { category: 'Meat color', text: 'Consistent, deep/bright red or cherry-red, single uniform hue, no patchiness' },
  { category: 'Translucency', text: 'Glossy, shiny, translucent look' },
  { category: 'Fat distribution', text: 'Even, well-marbled, no patchy clumping' },
  { category: 'Bloodline', text: 'Darker red than surrounding meat, never black/brown' },
  { category: 'Texture', text: 'Firm to touch, no mushiness/soft spot' },
  { category: 'Yaki (burn)', text: 'Minimal/negligible only' },
];

const SHARED_B = [
  { category: 'Meat color', text: 'Two-tone gradient (max 2 dominant hues), decent red but lacking full clarity' },
  { category: 'Fat distribution', text: 'Moderate, less marbling than A, not fully even' },
  { category: 'Bloodline', text: 'Slightly duller but not fully discolored' },
  { category: 'Texture', text: 'Reasonably firm, minor softness acceptable' },
  { category: 'Yaki (burn)', text: 'Present, moderate, still under 1 inch' },
];

const SHARED_C = [
  { category: 'Meat color', text: '3+ dominant hues (rainbow spread), greyish/brown/black discoloration present' },
  { category: 'Fat distribution', text: 'Uneven, patchy, scattered clumps' },
  { category: 'Bloodline', text: 'Black or brown — disqualifying' },
  { category: 'Texture', text: 'Mushy/soft spot present' },
  { category: 'Yaki (burn)', text: 'Exceeds 1 inch — auto-disqualifier regardless of color grade' },
];

const SASHIBO_A_SKIN = { category: 'Skin condition', text: 'Clean, no puncture/scratch/discoloration' };
const SASHIBO_B_SKIN = { category: 'Skin condition', text: 'Minor blemish acceptable, not heavily damaged' };
const SASHIBO_C_SKIN = { category: 'Skin condition', text: 'Visible damage, puncture, discoloration, or staining' };

export const DETERMINANTS: Record<SampleType, Record<Grade, Determinant[]>> = {
  'Tail-Cut': {
    A: buildDeterminants('Tail-Cut', 'A', SHARED_A),
    B: buildDeterminants('Tail-Cut', 'B', SHARED_B),
    C: buildDeterminants('Tail-Cut', 'C', SHARED_C),
    Invalid: buildDeterminants('Tail-Cut', 'Invalid', [
      { category: 'Sample validity', text: 'Sample unusable for grading — document the disqualifying region' },
    ]),
  },
  'Sashibo Core': {
    A: buildDeterminants('Sashibo Core', 'A', [...SHARED_A, SASHIBO_A_SKIN]),
    B: buildDeterminants('Sashibo Core', 'B', [...SHARED_B, SASHIBO_B_SKIN]),
    C: buildDeterminants('Sashibo Core', 'C', [...SHARED_C, SASHIBO_C_SKIN]),
    Invalid: buildDeterminants('Sashibo Core', 'Invalid', [
      { category: 'Sample validity', text: 'Sample unusable for grading — document the disqualifying region' },
    ]),
  },
};

export const GRADE_TIER_LABEL: Record<Grade, GradeTier | 'Invalid'> = {
  A: 'Export/Sashimi',
  B: 'Planta',
  C: 'Local',
  Invalid: 'Invalid',
};

/** Differential cues: present in higher grade but absent in lower */
export const DIFFERENTIAL_NOTES: Record<SampleType, { pair: string; note: string }[]> = {
  'Tail-Cut': [
    { pair: 'A vs B', note: 'A has single uniform hue + full translucency; B allows two-tone gradient and less even marbling.' },
    { pair: 'B vs C', note: 'B keeps bloodline non-black/brown and yaki under 1 inch; C has rainbow hues, black/brown bloodline, or yaki > 1 inch.' },
  ],
  'Sashibo Core': [
    { pair: 'A vs B', note: 'A requires clean skin and uniform cherry-red; B allows minor skin blemish and two-tone color.' },
    { pair: 'B vs C', note: 'B keeps moderate defects only; C shows skin damage, black/brown bloodline, mushy texture, or yaki > 1 inch.' },
  ],
};

export function determinantsFor(sampleType: SampleType, grade: Grade): Determinant[] {
  return DETERMINANTS[sampleType][grade] ?? [];
}

export function determinantsByCategory(sampleType: SampleType, grade: Grade) {
  const items = determinantsFor(sampleType, grade);
  const grouped: Record<string, Determinant[]> = {};
  for (const item of items) {
    grouped[item.category] = grouped[item.category] ?? [];
    grouped[item.category].push(item);
  }
  return grouped;
}

export function findDeterminant(id: string): Determinant | undefined {
  for (const type of Object.keys(DETERMINANTS) as SampleType[]) {
    for (const grade of Object.keys(DETERMINANTS[type]) as Grade[]) {
      const match = DETERMINANTS[type][grade].find((item) => item.id === id);
      if (match) return match;
    }
  }
  return undefined;
}
