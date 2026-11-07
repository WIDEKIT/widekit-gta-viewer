import type { DrawableData, PaintSlot } from '../shared/model';

/**
 * GTA's compiled YFT does not retain the Sollumz `[PAINT:N]` display tag.
 * Keep the original-tag mapping here, keyed by vehicle. The compiled model
 * loses the Sollumz tag, so this is the source of truth for the web viewer.
 */
interface PaintBinding {
  readonly slot: PaintSlot;
  /** The compiled shader identity.  Names such as `vehicle_paint4` are GTA
   * shader variants, not the Sollumz `[PAINT:N]` tag, so the slot is always
   * declared explicitly here. */
  readonly shader: string;
  readonly diffuse: string;
}

interface PaintManifest {
  /** Exact source-material signatures recorded from Sollumz. */
  readonly materials: readonly PaintBinding[];
}

const PAINT_MANIFESTS: Record<string, PaintManifest> = {
  widekitevom: {
    // These are the authored Sollumz tags, not inferred from shader names or
    // their order in a YFT. The shader table can differ across LODs/children.
    materials: [
      { slot: 1, shader: 'vehicle_paint4', diffuse: 'blank' },
      { slot: 1, shader: 'vehicle_shuts', diffuse: 'vehicle_generic_doorshut' },
      { slot: 2, shader: 'vehicle_paint1', diffuse: 'vehicle_generic_smallspecmap' },
      { slot: 2, shader: 'vehicle_badges', diffuse: 'vehicle_generic_detail_stitch' },
      { slot: 4, shader: 'vehicle_tire', diffuse: 'vehicle_generic_smallspecmap' },
    ],
  },
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

export function applyPaintManifest(drawable: DrawableData, vehicleName = drawable.name): DrawableData {
  const manifest = PAINT_MANIFESTS[manifestKey(vehicleName)];
  if (!manifest) return drawable;
  return {
    ...drawable,
    shaders: drawable.shaders.map((shader) => {
      const shaderName = shader.name.toLowerCase();
      const diffuse = shader.diffuse?.toLowerCase() ?? '';
      const paintSlot = manifest.materials.find((binding) =>
        binding.shader === shaderName && binding.diffuse === diffuse
      )?.slot;
      return paintSlot === undefined ? shader : { ...shader, paintSlot };
    }),
  };
}

export function paintSlots(drawable: DrawableData | undefined): PaintSlot[] {
  if (!drawable) return [];
  const drawables = [drawable, ...(drawable.fragmentChildren ?? []).flatMap((child) => child.drawable ? [child.drawable] : [])];
  return [...new Set(drawables.flatMap((entry) => entry.shaders.flatMap((shader) => shader.paintSlot === undefined ? [] : [shader.paintSlot])))]
    .sort((a, b) => a - b) as PaintSlot[];
}
