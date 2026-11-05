import * as THREE from 'three';
import type { DrawableData, FragmentChildData, LodLevel, ShaderData, TextureData } from '../../shared/model';
import { LOD_LEVELS } from '../../shared/model';
import {
  applyRenderOptions,
  availableLod,
  boxHelper,
  buildDrawable,
  lodStats,
  RenderOptions,
  TextureStore,
} from '../scene';
import { openLightbox, textureCanvas, textureDescription } from '../textureCanvas';
import { buildCollision } from '../collision';
import { originName } from '../textureEditor';
import { checkbox, cutSlider, fmt, h, newRequestId, onHostMessage, pref, select, setPref, vscode } from '../ui';
import { Viewer } from '../viewer';
import { LiveryEditor } from '../liveryEditor';

const LOD_LABELS: Record<LodLevel, string> = { high: 'High', med: 'Medium', low: 'Low', vlow: 'Very low' };

/** GTA skeleton tags used by vehicle fragment wheels. */
function wheelSlot(tag: number): 'lf' | 'rf' | 'lr' | 'rr' | undefined {
  if (tag === 27922) return 'lf'; // wheel_lf
  if (tag === 26418) return 'rf'; // wheel_rf
  if (tag === 27902 || tag === 29921 || tag === 29922 || tag === 29923) return 'lr';
  if (tag === 26398 || tag === 5857 || tag === 5858 || tag === 5859) return 'rr';
  return undefined;
}

type WheelSlot = Exclude<ReturnType<typeof wheelSlot>, undefined>;

/** Shared render toggles for every 3D view in this editor. */
export function renderOptions(): RenderOptions {
  return {
    textures: pref('textures', true),
    wireframe: pref('wireframe', false),
    vertexColors: pref('vertexColors', false),
    doubleSided: pref('doubleSided', true),
  };
}

/**
 * Requests textures that aren't embedded from nearby .ytd files. Textures are
 * added to `store` as they arrive; resolves when the host finishes searching.
 */
export function fetchTextures(
  store: TextureStore,
  names: string[],
  hints: string[],
  onStatus: (s: string) => void,
  maxSize?: number
): Promise<void> {
  const missing = [...new Set(names.map((n) => n.toLowerCase()))].filter((n) => !store.has(n));
  if (!missing.length) return Promise.resolve();
  const requestId = newRequestId();
  onStatus(`Searching for ${missing.length} texture${missing.length === 1 ? '' : 's'}…`);
  return new Promise((resolve) => {
    const off = onHostMessage((m) => {
      if (m.type !== 'textures' || m.requestId !== requestId) return;
      if (m.textures.length) store.add(m.textures, m.source);
      if (m.done) {
        off();
        const still = missing.filter((n) => !store.has(n));
        onStatus(
          still.length
            ? `${still.length} texture${still.length === 1 ? '' : 's'} not found (searched ${m.searched} .ytd file${m.searched === 1 ? '' : 's'})`
            : ''
        );
        resolve();
      } else {
        onStatus(`Searching textures… (${m.searched} dictionaries checked)`);
      }
    });
    vscode.postMessage({ type: 'findTextures', requestId, names: missing, hints, maxSize });
  });
}

export interface ModelPanelOptions {
  /** Texture dictionary names to search first (e.g. from a .ytyp archetype). */
  textureHints?: string[];
  sidebar?: boolean;
  /** Search nearby .ytd files for textures the model doesn't embed (default true). */
  searchTextures?: boolean;
}

/** Toolbar + 3D view + info sidebar for one or more drawables. */
export class ModelPanel {
  readonly el: HTMLElement;
  private readonly viewer: Viewer;
  private readonly store = new TextureStore();
  private readonly toolbar: HTMLElement;
  private readonly sidebar: HTMLElement;
  private readonly status: HTMLElement;
  private drawables: DrawableData[] = [];
  private current = 0;
  private lod: LodLevel = 'high';
  private opts = renderOptions();
  private bounds?: THREE.Object3D;
  private collision?: THREE.Object3D;
  /** Texture key that replaces the diffuse of variation-driven shaders (ped clothing). */
  private variationKey?: string;
  private offStore: () => void;
  private readonly livery: LiveryEditor;
  /** Kept across sidebar re-renders so its controls keep their state. */
  private readonly liverySection: HTMLElement;
  private readonly sidebarRest = h('div');
  private sidebarQueued = false;

  constructor(private readonly options: ModelPanelOptions = {}) {
    this.toolbar = h('div', { class: 'toolbar' });
    this.status = h('div', { class: 'status' });
    const stage = h('div', { class: 'stage' }, this.status);
    this.sidebar = h('div', { class: 'sidebar' });
    this.el = h(
      'div',
      { class: 'model-panel' },
      this.toolbar,
      h('div', { class: 'model-body' }, stage, options.sidebar === false ? null : this.sidebar)
    );
    this.viewer = new Viewer(stage);
    this.viewer.setGridVisible(pref('grid', true));
    this.store.showTextures = this.opts.textures;
    this.offStore = this.store.onChange(() => {
      this.viewer.requestRender();
      this.queueSidebar();
    });
    this.livery = new LiveryEditor({
      viewer: this.viewer,
      store: this.store,
      drawable: () => this.drawable,
      setStatus: (t) => this.setStatus(t),
    });
    this.liverySection = section('Livery', true, this.livery.el);
    this.sidebar.append(this.liverySection, this.sidebarRest);
  }

  setDrawables(drawables: DrawableData[], keepCamera = false): void {
    this.drawables = drawables;
    this.current = Math.min(this.current, Math.max(0, drawables.length - 1));
    for (const d of drawables) this.store.add(d.textures, 'embedded');
    this.livery.setDrawable(this.drawable);
    this.renderToolbar();
    this.show(!keepCamera);
    // Fetch every referenced texture (not just diffuse) so the sidebar can show them all.
    const names = drawables.flatMap((d) => d.shaders.flatMap((s) => s.textures.map((t) => t.texture)));
    const hints = [...(this.options.textureHints ?? []), ...drawables.map((d) => d.name)];
    if (this.options.searchTextures !== false) void fetchTextures(this.store, names, hints, (s) => this.setStatus(s));
  }

  /**
   * Uses `texture` as the diffuse for the drawable's clothing shaders, the way
   * the game applies a ped variation's .ytd. Pass undefined to restore.
   */
  setVariationTexture(texture: TextureData | undefined, source = 'variation'): void {
    this.variationKey = texture ? `__variation__/${source}/${texture.name}`.toLowerCase() : undefined;
    if (texture && this.variationKey) this.store.add([{ ...texture, name: this.variationKey }], source);
    if (this.drawable) this.show(false);
  }

  setTextureHints(hints: string[]): void {
    this.options.textureHints = hints;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  /** Public, read-only preview controls used by the WideKit browser shell. */
  frame(): void {
    this.viewer.frame();
  }

  setAutoRotate(enabled: boolean): void {
    this.viewer.setAutoRotate(enabled);
  }

  setPaint(colour: string, target: 'primary' | 'secondary' = 'primary'): void {
    if (!/^#[0-9a-f]{6}$/i.test(colour)) return;
    const value = new THREE.Color(colour).getHex();
    const shader = target === 'secondary' ? 'vehicle_paint4' : 'vehicle_paint1';
    this.store.setPaint(shader, value);
    // Some assets expose only paint1; keep the visible paint coherent in that case.
    if (target === 'primary') this.store.setPaint('vehicle_paint2', value);
    this.viewer.requestRender();
  }

  /** Read-only controls exposed to the WideKit showroom sidebar. */
  setPreviewOption(option: string, value: unknown): void {
    const enabled = Boolean(value);
    switch (option) {
      case 'textures':
        this.opts.textures = enabled;
        this.store.showTextures = enabled;
        this.store.refresh();
        break;
      case 'wireframe':
        this.opts.wireframe = enabled;
        applyRenderOptions(this.viewer.content, this.opts);
        break;
      case 'vertexColors':
        this.opts.vertexColors = enabled;
        this.show(false);
        break;
      case 'doubleSided':
        this.opts.doubleSided = enabled;
        applyRenderOptions(this.viewer.content, this.opts);
        break;
      case 'grid':
        this.viewer.setGridVisible(enabled);
        break;
      case 'bounds':
        if (this.bounds) this.bounds.visible = enabled;
        break;
      case 'collision':
        if (this.collision) this.collision.visible = enabled;
        break;
      case 'cut': {
        const d = this.drawable;
        const progress = Math.max(0, Math.min(1, Number(value)));
        this.viewer.setCutHeight(!d || progress >= 1 ? null : d.bbMin[2] + (d.bbMax[2] - d.bbMin[2]) * progress);
        break;
      }
      default:
        return;
    }
    this.viewer.requestRender();
  }

  dispose(): void {
    this.offStore();
    this.livery.dispose();
    this.viewer.dispose();
  }

  private get drawable(): DrawableData | undefined {
    return this.drawables[this.current];
  }

  private show(frame: boolean): void {
    const d = this.drawable;
    this.viewer.clearOverlay();
    if (!d) {
      this.viewer.setContent();
      return;
    }
    this.lod = availableLod(d, this.lod);
    this.store.unbindAll();
    const content = buildDrawable(this.livery.apply(this.withVariation(d)), this.lod, this.store, this.opts);
    this.addWheelChildren(content, d.fragmentChildren ?? []);
    this.viewer.setContent(content);
    this.bounds = boxHelper(d.bbMin, d.bbMax, 0xffc107);
    this.bounds.visible = pref('bounds', false);
    this.viewer.overlay.add(this.bounds);
    this.collision = d.bounds ? buildCollision(d.bounds, { overlay: true, wireframe: false, triangles: true, primitives: true }) : undefined;
    if (this.collision) {
      this.collision.visible = pref('collision', false);
      this.viewer.overlay.add(this.collision);
    }
    if (frame) this.viewer.frame();
    this.livery.shown();
    this.renderToolbar();
    this.renderSidebar();
  }

  /** Texture changes come in bursts (searches, live livery previews); redraw the sidebar once they settle. */
  private queueSidebar(): void {
    if (this.sidebarQueued) return;
    this.sidebarQueued = true;
    setTimeout(() => {
      this.sidebarQueued = false;
      this.renderSidebar();
      this.livery.refreshThumbnails();
    }, 200);
  }

  /** Opens the texture viewer with replace/export actions for texture `key`. */
  private openTexture(key: string): void {
    const info = this.store.info(key);
    const original = this.store.original(key);
    if (!info || !original) return;
    const source = info.source === 'embedded' ? `embedded in ${originName(original) || 'this file'}` : info.source;
    openLightbox(original, source, { original, setPreview: (p) => this.store.setPreview(key, p) });
  }

  /** Applies the variation texture to shaders that take their colour from a variation .ytd. */
  private withVariation(d: DrawableData): DrawableData {
    const key = this.variationKey;
    if (!key) return d;
    const isVariation = (s: ShaderData) => !!s.diffuse && /_diff_\d{3}/.test(s.diffuse);
    const targets = d.shaders.some(isVariation) ? isVariation : (s: ShaderData) => !!s.diffuse;
    return { ...d, shaders: d.shaders.map((s) => (targets(s) ? { ...s, diffuse: key, diffuseIsOverlay: false } : s)) };
  }

  /**
   * Vehicle wheels are fragment physics children rather than meshes in the
   * main drawable.  Put every wheel at its authored transform.  Some GTA
   * vehicles only store one drawable per axle, so reuse that detailed wheel
   * mesh for data-only slots while preserving each slot's own transform.
   */
  private addWheelChildren(root: THREE.Group, children: FragmentChildData[]): void {
    const slots = new Map<WheelSlot, FragmentChildData>();
    for (const child of children) {
      const slot = wheelSlot(child.boneTag);
      if (slot) slots.set(slot, child);
    }
    const frontSource = slots.get('lf')?.drawable ?? slots.get('rf')?.drawable;
    const rearSource = slots.get('lr')?.drawable ?? slots.get('rr')?.drawable;
    for (const [slot, child] of slots) {
      const drawable = child.drawable ?? (slot === 'lf' || slot === 'rf' ? frontSource : rearSource);
      if (!drawable) continue;
      const lod = availableLod(drawable, 'high');
      const wheel = buildDrawable(drawable, lod, this.store, this.opts);
      wheel.name = `wheel_${slot}`;
      wheel.matrixAutoUpdate = false;
      wheel.matrix.fromArray(wheelMatrix(child.transform, slot));
      root.add(wheel);
    }
  }

  private renderToolbar(): void {
    const d = this.drawable;
    const items: (HTMLElement | null)[] = [];
    if (this.drawables.length > 1) {
      items.push(
        h('span', { class: 'label' }, 'Drawable'),
        select(
          this.drawables.map((x, i) => ({ value: String(i), label: x.name || `#${i}` })),
          String(this.current),
          (v) => {
            this.current = Number(v);
            this.livery.setDrawable(this.drawable);
            this.show(true);
          }
        )
      );
    }
    if (d) {
      items.push(
        h('span', { class: 'label' }, 'LOD'),
        select(
          LOD_LEVELS.map((l) => ({ value: l, label: LOD_LABELS[l], disabled: !d.lods[l].length })),
          this.lod,
          (v) => {
            this.lod = v;
            this.show(false);
          }
        )
      );
    }
    const rebuild = () => this.show(false);
    items.push(
      h('span', { class: 'sep' }),
      checkbox('Textures', 'textures', true, (v) => {
        this.opts.textures = v;
        this.store.showTextures = v;
        this.store.refresh();
        this.viewer.requestRender();
      }),
      checkbox('Wireframe', 'wireframe', false, (v) => {
        this.opts.wireframe = v;
        applyRenderOptions(this.viewer.content, this.opts);
        this.viewer.requestRender();
      }),
      checkbox('Vertex colours', 'vertexColors', false, (v) => {
        this.opts.vertexColors = v;
        rebuild();
      }),
      checkbox('Double-sided', 'doubleSided', true, (v) => {
        this.opts.doubleSided = v;
        applyRenderOptions(this.viewer.content, this.opts);
        this.viewer.requestRender();
      }),
      checkbox('Grid', 'grid', true, (v) => this.viewer.setGridVisible(v)),
      checkbox('Bounds', 'bounds', false, (v) => {
        if (this.bounds) this.bounds.visible = v;
        this.viewer.requestRender();
      }),
      d?.bounds
        ? checkbox('Collision', 'collision', false, (v) => {
            if (this.collision) this.collision.visible = v;
            this.viewer.requestRender();
          })
        : null,
      cutSlider(
        () => (d ? { min: d.bbMin[2], max: d.bbMax[2] } : undefined),
        (z) => this.viewer.setCutHeight(z)
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'chip', onclick: () => this.viewer.frame(), title: 'Frame model' }, 'Frame')
    );
    this.toolbar.replaceChildren(...items.filter((x): x is HTMLElement => !!x));
  }

  private renderSidebar(): void {
    const d = this.drawable;
    if (!d || this.options.sidebar === false) {
      this.sidebarRest.replaceChildren();
      this.liverySection.hidden = true;
      return;
    }
    this.liverySection.hidden = !this.livery.available;
    const size = d.bbMax.map((v, i) => v - d.bbMin[i]);
    const stats = lodStats(d, this.lod);
    const lodRows = LOD_LEVELS.filter((l) => d.lods[l].length).map((l) => {
      const s = lodStats(d, l);
      return h('tr', null, h('td', null, LOD_LABELS[l]), h('td', null, fmt(s.vertices)), h('td', null, fmt(s.triangles)), h('td', null, fmt(d.lodDistances[l])));
    });

    const info = section(
      'Model',
      true,
      kv('Name', d.name || '—'),
      kv('Size', `${size.map((v) => fmt(v)).join(' × ')} m`),
      kv('Models / geometries', `${stats.models} / ${stats.geometries}`),
      kv('Bones', d.bones.length ? String(d.bones.length) : '—'),
      kv('Collision', d.bounds ? `${fmt(d.bounds.triangles)} tris, ${fmt(d.bounds.primitives.length)} primitives` : '—'),
      h(
        'table',
        { class: 'grid-table' },
        h('tr', null, h('th', null, 'LOD'), h('th', null, 'Verts'), h('th', null, 'Tris'), h('th', null, 'Dist')),
        lodRows
      )
    );

    const shaders = section(
      `Shaders (${d.shaders.length})`,
      true,
      d.shaders.map((s, i) =>
        h(
          'div',
          { class: 'shader' },
          h('div', { class: 'shader-name' }, `${i}: ${s.name}`),
          s.textures.map((t) => {
            const found = this.store.info(t.texture);
            const state = found?.data.pixels ? 'ok' : found ? 'ref' : 'missing';
            return h(
              'div',
              {
                class: `tex-ref ${state}${found?.data.pixels ? ' clickable' : ''}`,
                title: found ? `${found.source === 'embedded' ? 'Embedded' : `From ${found.source}`}${found.data.pixels ? ' · click to view, replace or export' : ''}` : 'Not found',
                onclick: found?.data.pixels ? () => this.openTexture(t.texture) : undefined,
              },
              h('span', { class: 'param' }, t.param),
              h('span', null, t.texture),
              found?.preview ? h('span', { class: 'badge' }, 'preview') : null
            );
          })
        )
      )
    );

    const textures = this.store.all().filter((t) => t.data.pixels);
    const gallery = section(
      `Textures (${textures.length})`,
      true,
      h(
        'div',
        { class: 'thumbs' },
        textures.map(({ key, data, source, preview }) =>
          h(
            'div',
            {
              class: 'thumb',
              title: `${data.name}\n${textureDescription(data)}\n${source === 'embedded' ? 'Embedded' : `From ${source}`}\nClick to view, replace or export`,
              onclick: () => this.openTexture(key),
            },
            preview ? h('span', { class: 'badge' }, 'preview') : null,
            h('div', { class: 'checker thumb-image' }, textureCanvas(data, 96)),
            h('div', { class: 'thumb-name' }, data.name.replace(/^__variation__\/[^/]*\//, ''))
          )
        )
      )
    );

    const bones = d.bones.length
      ? section(
          `Skeleton (${d.bones.length})`,
          false,
          h(
            'div',
            { class: 'bones' },
            d.bones.map((b, i) => h('div', null, `${i}: ${b.name}`, h('span', { class: 'muted' }, ` tag ${b.tag}`)))
          )
        )
      : null;

    this.sidebarRest.replaceChildren(...[info, shaders, gallery, bones].filter((x): x is HTMLElement => !!x));
  }
}

/** GTA authors wheel meshes for the left side; right wheels are mirrored. */
function wheelMatrix(transform: number[], slot: WheelSlot): number[] {
  if (slot !== 'rf' && slot !== 'rr') return transform;
  return [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, transform[12], transform[13], transform[14], 1];
}

function section(title: string, open: boolean, ...content: (Node | Node[] | null)[]): HTMLElement {
  const key = `section:${title.replace(/\s*\(.*$/, '')}`;
  const el = h('details', { class: 'section', open: pref(key, open) }, h('summary', null, title), ...content.flat().filter((x): x is Node => !!x));
  el.addEventListener('toggle', () => setPref(key, el.open));
  return el;
}

function kv(k: string, v: string): HTMLElement {
  return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
}

export { section, kv };
