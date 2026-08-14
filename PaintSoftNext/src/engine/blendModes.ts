/**
 * The separable blend modes from the W3C compositing spec — the set every illustration
 * tool shares and the set that maps cleanly onto PSD's own blend keys.
 *
 * Order matters: the index is what the blending shader switches on, so entries may be
 * appended but never reordered.
 */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
] as const;

export type LayerBlendMode = (typeof BLEND_MODES)[number];

export const BLEND_MODE_LABELS: Record<LayerBlendMode, string> = {
  normal: '通常',
  multiply: '乗算',
  screen: 'スクリーン',
  overlay: 'オーバーレイ',
  darken: '比較（暗）',
  lighten: '比較（明）',
  'color-dodge': '覆い焼き',
  'color-burn': '焼き込み',
  'hard-light': 'ハードライト',
  'soft-light': 'ソフトライト',
  difference: '差の絶対値',
  exclusion: '除外',
};

/** PSD's four-character blend keys, for export. */
export const PSD_BLEND_KEYS: Record<LayerBlendMode, string> = {
  normal: 'norm',
  multiply: 'mul ',
  screen: 'scrn',
  overlay: 'over',
  darken: 'dark',
  lighten: 'lite',
  'color-dodge': 'div ',
  'color-burn': 'idiv',
  'hard-light': 'hLit',
  'soft-light': 'sLit',
  difference: 'diff',
  exclusion: 'smud',
};

export function blendModeIndex(mode: LayerBlendMode): number {
  const index = BLEND_MODES.indexOf(mode);
  return index < 0 ? 0 : index;
}

export function isBlendMode(value: unknown): value is LayerBlendMode {
  return typeof value === 'string' && (BLEND_MODES as readonly string[]).includes(value);
}
