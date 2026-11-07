import type { DrawableData, PaintSlot } from '../shared/model';

/**
 * GTA's compiled YFT does not retain the Sollumz `[PAINT:N]` display tag.
 * Keep the original-tag mapping here, keyed by vehicle, and never infer it
 * from the runtime shader name: a single shader can represent any paint slot.
 */
const PAINT_MANIFESTS: Record<string, ReadonlyMap<number, PaintSlot>> = {
  widekitevom: new Map<number, PaintSlot>([
    [2, 1],
    [8, 1],
    [18, 2],
    [19, 2],
    [6, 4],
  ]),
};

function manifestKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^pack:\//, '')
    .replace(/\.(?:yft|ydr|ydd)$/i, '')
    .replace(/_(?:hi|med|low|vlow)$/i, '')
    .replace(/\s*\(damaged\)$/i, '')
    .replace(/[^a-z0-9]/g, '');
}

export function applyPaintManifest(drawable: DrawableData): DrawableData {
  const bindings = PAINT_MANIFESTS[manifestKey(drawable.name)];
  if (!bindings) return drawable;
  return {
    ...drawable,
    shaders: drawable.shaders.map((shader, index) => {
      const paintSlot = bindings.get(index);
      return paintSlot === undefined ? shader : { ...shader, paintSlot };
    }),
  };
}

export function paintSlots(drawable: DrawableData | undefined): PaintSlot[] {
  if (!drawable) return [];
  return [...new Set(drawable.shaders.flatMap((shader) => shader.paintSlot === undefined ? [] : [shader.paintSlot]))]
    .sort((a, b) => a - b) as PaintSlot[];
}
