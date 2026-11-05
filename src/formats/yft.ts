import { ResourceReader } from './reader';
import { readRsc7 } from './rsc7';
import { readDrawable, DrawableOptions } from './drawable';
import type { DrawableData, FragmentChildData } from '../shared/model';

const ROOT = 0x50000000;

/**
 * Pointers to every fragDrawable in a fragment: main, named array, and
 * others referenced from the root (e.g. the damaged model), with names.
 */
export function fragmentDrawables(r: ResourceReader): { ptr: number; name: string }[] {
  const fragName = (r.string(r.ptr(ROOT + 0x58)) ?? '').replace(/^pack:\//i, '');
  const mainPtr = r.ptr(ROOT + 0x30);
  const out: { ptr: number; name: string }[] = [];
  const seen = new Set<number>();
  const add = (ptr: number, name: string) => {
    if (!r.isValid(ptr) || seen.has(ptr)) return;
    seen.add(ptr);
    out.push({ ptr, name });
  };
  add(mainPtr, fragName || 'fragment');

  // Named drawable array (e.g. alternative parts of some props).
  const arrayPtr = r.ptr(ROOT + 0x38);
  const namesPtr = r.ptr(ROOT + 0x40);
  const count = r.u32(ROOT + 0x48);
  if (r.isValid(arrayPtr) && count > 0 && count < 256) {
    for (let i = 0; i < count; i++) {
      const name = r.isValid(namesPtr) ? r.string(r.ptr(namesPtr + i * 8)) : undefined;
      add(r.ptr(arrayPtr + i * 8), name || `${fragName} [${i}]`);
    }
  }

  // Other fragDrawables referenced from the root (the damaged model on vehicles).
  // They're recognised by sharing the main drawable's vtable value.
  if (r.isValid(mainPtr)) {
    const vft = r.u32(mainPtr);
    for (let o = 0x60; o < 0x130; o += 8) {
      const p = r.ptr(ROOT + o);
      if (!r.isValid(p) || seen.has(p)) continue;
      try {
        if (r.u32(p) === vft && r.isValid(r.ptr(p + 0x50))) add(p, `${fragName} (damaged)`);
      } catch {
        // Not a drawable.
      }
    }
  }
  return out;
}

/**
 * Parses a .yft fragment (vehicles, breakable props). Returns the main
 * drawable first, then any extra drawables the fragment carries (the damaged
 * model, and the named drawable array used by some props).
 */
export function parseYft(file: Uint8Array, opts: DrawableOptions): DrawableData[] {
  const r = new ResourceReader(readRsc7(file));
  return fragmentDrawables(r).map(({ ptr, name }, index) => {
    const d = readDrawable(r, ptr, opts, 'frag');
    // Fragment drawables are usually named "skel"; the fragment name is more useful.
    d.name = name;
    // Vehicle wheels, doors and other physics pieces live outside the main
    // fragDrawable.  Attach them to the primary drawable so renderers can
    // compose the complete vehicle without treating them as collision data.
    if (index === 0) d.fragmentChildren = readPhysicsChildren(r, opts);
    return d;
  });
}

/** Reads drawable-bearing fragment physics children (wheels on vehicles). */
function readPhysicsChildren(r: ResourceReader, opts: DrawableOptions): FragmentChildData[] {
  try {
    const physicsGroup = r.ptr(ROOT + 0xf0);
    if (!r.isValid(physicsGroup)) return [];
    const lod = r.ptr(physicsGroup + 0x10);
    if (!r.isValid(lod)) return [];

    const childPtr = r.ptr(lod + 0xd0);
    const transformsPtr = r.ptr(lod + 0x100);
    const count = r.u8(lod + 0x11d);
    if (!r.isValid(childPtr) || !r.isValid(transformsPtr) || count === 0 || count > 128) return [];

    const position = r.vec3(lod + 0x30);
    const transformCount = r.u32(transformsPtr + 0x10);
    const transformData = transformsPtr + 0x20;
    if (transformCount === 0 || transformCount > 256 || !r.isValid(transformData)) return [];

    const children: FragmentChildData[] = [];
    for (let i = 0; i < count; i++) {
      const child = childPtr + i * 0xb0;
      const transformIndex = r.u16(child + 0x10);
      const boneTag = r.u16(child + 0x12);
      const drawablePtr = r.ptr(child + 0xa0);
      if (transformIndex >= transformCount) continue;
      const transform = d3dMatrix(r, transformData + transformIndex * 64);
      transform[12] += position[0];
      transform[13] += position[1];
      transform[14] += position[2];
      let drawable: DrawableData | undefined;
      if (r.isValid(drawablePtr)) {
        try {
          drawable = readDrawable(r, drawablePtr, opts, 'frag');
        } catch {
          // A child can be a non-renderable physics object.
        }
      }
      children.push({ boneTag, transform, drawable });
    }
    return children;
  } catch {
    // Fragments without vehicle physics use a different layout; they still
    // render their main drawable normally.
    return [];
  }
}

/** Converts a Direct3D row-major matrix to the column-major renderer format. */
function d3dMatrix(r: ResourceReader, ptr: number): number[] {
  const raw = Array.from({ length: 16 }, (_, i) => r.f32(ptr + i * 4));
  return [
    raw[0], raw[4], raw[8], raw[12],
    raw[1], raw[5], raw[9], raw[13],
    raw[2], raw[6], raw[10], raw[14],
    raw[3], raw[7], raw[11], raw[15],
  ];
}
