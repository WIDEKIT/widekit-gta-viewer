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

/** Named vehicle pieces exposed by the read-only WideKit showroom controls. */
type VehiclePart = 'bonnet' | 'boot' | 'driver_front' | 'passenger_front' | 'driver_rear' | 'passenger_rear';
type VehicleLight = 'headlights' | 'tail_lights' | 'indicators' | 'reverse_lights' | 'brake_lights' | 'extra_lights';
type CameraPreset = 'front' | 'rear' | 'side' | 'top' | 'under' | 'engine' | 'trunk' | 'interior';

const VEHICLE_PART_BONES: Record<VehiclePart, readonly string[]> = {
  bonnet: ['bonnet', 'hood'],
  boot: ['boot', 'trunk'],
  driver_front: ['door_dside_f', 'door_driver_f'],
  passenger_front: ['door_pside_f', 'door_passenger_f'],
  driver_rear: ['door_dside_r', 'doorb1', 'door_driver_r'],
  passenger_rear: ['door_pside_r', 'doorb2', 'door_passenger_r'],
};

type VehiclePartBone = { boneIndices: ReadonlySet<number>; pivot: THREE.Vector3; side: number };

type VehicleLightBinding = {
  overlay: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  material: THREE.MeshStandardMaterial;
  source: THREE.MeshStandardMaterial;
};

type VehicleSkinBinding = {
  geometry: THREE.BufferGeometry;
  position: THREE.BufferAttribute;
  normal?: THREE.BufferAttribute;
  restPositions: Float32Array;
  restNormals?: Float32Array;
  blendIndices: Uint8Array;
  blendWeights: Uint8Array;
};

function isVehiclePart(value: string): value is VehiclePart {
  return value in VEHICLE_PART_BONES;
}

function isVehicleLight(value: string): value is VehicleLight {
  return value === 'headlights' || value === 'tail_lights' || value === 'indicators' || value === 'reverse_lights' || value === 'brake_lights' || value === 'extra_lights';
}

function isCameraPreset(value: string): value is CameraPreset {
  return value === 'front' || value === 'rear' || value === 'side' || value === 'top' || value === 'under' || value === 'engine' || value === 'trunk' || value === 'interior';
}

function vehicleLightKind(signature: string, isFront: boolean): VehicleLight | undefined {
  if (/(indicator|turn|signal|blink|direction|hazard)/.test(signature)) return 'indicators';
  if (/(reverse|back[_ -]?(up|light)|backup)/.test(signature)) return 'reverse_lights';
  if (/(brake|stop)/.test(signature)) return 'brake_lights';
  if (/(extra|siren|emergency)/.test(signature)) return 'extra_lights';
  if (/(tail|rear[_ -]?(light|lamp)|(?:light|lamp)[_ -]?rear)/.test(signature)) return 'tail_lights';
  if (/(head|front[_ -]?(light|lamp)|(?:light|lamp)[_ -]?front|lowbeam|highbeam|fog)/.test(signature)) return 'headlights';
  // "vehicle_lights" is GTA's generic authored lamp shader. The mesh's Y
  // position is the reliable data available when it has no semantic name.
  return isFront ? 'headlights' : 'tail_lights';
}

/** GTA vehicle_lightsemissive stores the authored lamp state in vertex alpha. */
const GTA_LIGHT_STATE: Readonly<Record<number, VehicleLight>> = {
  1: 'headlights', 2: 'headlights',
  3: 'tail_lights', 4: 'tail_lights',
  5: 'indicators', 6: 'indicators', 7: 'indicators', 8: 'indicators',
  9: 'brake_lights', 10: 'brake_lights', 11: 'brake_lights',
  12: 'reverse_lights', 13: 'reverse_lights',
  14: 'extra_lights', 15: 'extra_lights',
};

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
  /** Vehicle bones and skin data used for door, bonnet and boot articulation. */
  private readonly vehiclePartBones = new Map<VehiclePart, VehiclePartBone>();
  private vehicleSkinBindings: VehicleSkinBinding[] = [];
  private readonly openVehicleParts = new Set<VehiclePart>();
  /** Current 0–1 pose for each part, retained while an animation is in flight. */
  private readonly vehiclePartProgress = new Map<VehiclePart, number>();
  private readonly vehiclePartTransitions = new Map<VehiclePart, { from: number; to: number; startedAt: number }>();
  private vehicleAnimationFrame?: number;
  /** Individually addressable light materials inferred from authored YFT shaders. */
  private readonly vehicleLights = new Map<VehicleLight, VehicleLightBinding[]>();
  /** GTA indicators flash while all other lamp channels remain steady. */
  private indicatorsEnabled = false;
  private indicatorAnimationFrame?: number;
  /** Optional in-scene camera focus points, kept outside vehicle bounds. */
  private cameraPresetHotspots?: THREE.Group;
  private cameraPresetsVisible = false;
  private cameraPresetPointer?: THREE.Vector2;
  private cameraPresetAnimationFrame?: number;
  /** A panel opened solely by a camera focus; it closes when leaving that focus. */
  private cameraPresetOpenedPart?: VehiclePart;

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
    this.viewer.renderer.domElement.addEventListener('pointerdown', this.onCameraPresetPointerDown);
    this.viewer.renderer.domElement.addEventListener('pointerup', this.onCameraPresetPointerUp);
    this.viewer.setGridVisible(pref('grid', true));
    this.store.showTextures = this.opts.textures;
    this.offStore = this.store.onChange(() => {
      this.refreshVehicleLightMaps();
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
    this.closeCameraPresetPart();
    this.viewer.frame();
  }

  setAutoRotate(enabled: boolean): void {
    this.viewer.setAutoRotate(enabled);
  }

  /** Shows small interactive focus points in the 3D studio. */
  setCameraPresetsVisible(visible: boolean): void {
    this.cameraPresetsVisible = visible;
    if (!visible) this.closeCameraPresetPart();
    if (this.cameraPresetHotspots) this.cameraPresetHotspots.visible = visible;
    this.viewer.requestRender();
  }

  /** Moves the camera smoothly to a useful inspection angle. */
  setCameraPreset(preset: string): void {
    if (!isCameraPreset(preset)) return;
    this.closeCameraPresetPart();
    const bounds = new THREE.Box3().setFromObject(this.viewer.content);
    if (bounds.isEmpty()) return;
    if (preset === 'engine') this.openCameraPresetPart('bonnet');
    if (preset === 'trunk') this.openCameraPresetPart('boot');
    if (preset === 'interior') this.openCameraPresetPart('driver_front');
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const target = center.clone();
    const direction = new THREE.Vector3();
    let distance = Math.max(size.length() * 0.68, 3);
    switch (preset) {
      case 'front':
        target.y = bounds.max.y - size.y * 0.17;
        direction.set(0, 1, 0.22);
        break;
      case 'rear':
        target.y = bounds.min.y + size.y * 0.17;
        direction.set(0, -1, 0.22);
        break;
      case 'side':
        target.x = bounds.max.x - size.x * 0.1;
        direction.set(1, 0, 0.16);
        break;
      case 'top':
        direction.set(0, -0.12, 1);
        distance *= 0.98;
        break;
      case 'under':
        target.z = bounds.min.z + size.z * 0.1;
        direction.set(0, 0.08, -1);
        distance *= 0.8;
        break;
      case 'engine':
        target.set(center.x, bounds.max.y - size.y * 0.28, bounds.min.z + size.z * 0.62);
        direction.set(0, 0.85, 0.72);
        distance *= 0.58;
        break;
      case 'trunk':
        target.set(center.x, bounds.min.y + size.y * 0.18, bounds.min.z + size.z * 0.5);
        direction.set(0, -0.92, 0.42);
        distance *= 0.66;
        break;
      case 'interior':
        target.set(bounds.min.x + size.x * 0.32, center.y + size.y * 0.04, bounds.min.z + size.z * 0.6);
        direction.set(-1, 0.08, 0.18);
        distance *= 0.44;
        break;
    }
    this.animateCamera(target, direction.normalize(), distance);
  }

  private openCameraPresetPart(part: VehiclePart): void {
    if (!this.vehiclePartBones.has(part)) return;
    this.cameraPresetOpenedPart = part;
    this.setVehiclePart(part, true);
  }

  private closeCameraPresetPart(): void {
    if (!this.cameraPresetOpenedPart) return;
    this.setVehiclePart(this.cameraPresetOpenedPart, false);
    this.cameraPresetOpenedPart = undefined;
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

  /** Opens or closes an authored GTA vehicle part around its skeleton bone. */
  setVehiclePart(part: string, open: boolean): void {
    if (!isVehiclePart(part)) return;
    if (!this.vehiclePartBones.has(part) || !this.vehicleSkinBindings.length) return;
    if (open) this.openVehicleParts.add(part);
    else this.openVehicleParts.delete(part);
    const current = this.vehiclePartProgress.get(part) ?? 0;
    const target = open ? 1 : 0;
    if (Math.abs(current - target) < 0.001) return;
    this.vehiclePartTransitions.set(part, { from: current, to: target, startedAt: performance.now() });
    this.animateVehicleParts();
  }

  /** Returns only the light groups that were actually found in the active YFT. */
  vehicleLightCapabilities(): string[] {
    return [...this.vehicleLights].filter(([, bindings]) => bindings.length > 0).map(([light]) => light);
  }

  /** Enables an authored lamp without touching the vehicle's default lens material. */
  setVehicleLight(light: string, enabled: boolean): void {
    if (!isVehicleLight(light)) return;
    const bindings = this.vehicleLights.get(light);
    if (!bindings?.length) return;
    if (light === 'indicators') {
      this.indicatorsEnabled = enabled;
      if (enabled) this.animateIndicators();
      else {
        if (this.indicatorAnimationFrame !== undefined) cancelAnimationFrame(this.indicatorAnimationFrame);
        this.indicatorAnimationFrame = undefined;
        this.setVehicleLightOverlayVisible('indicators', false);
      }
    } else {
      this.setVehicleLightOverlayVisible(light, enabled);
    }
    this.viewer.requestRender();
  }

  dispose(): void {
    if (this.vehicleAnimationFrame !== undefined) cancelAnimationFrame(this.vehicleAnimationFrame);
    if (this.indicatorAnimationFrame !== undefined) cancelAnimationFrame(this.indicatorAnimationFrame);
    if (this.cameraPresetAnimationFrame !== undefined) cancelAnimationFrame(this.cameraPresetAnimationFrame);
    this.viewer.renderer.domElement.removeEventListener('pointerdown', this.onCameraPresetPointerDown);
    this.viewer.renderer.domElement.removeEventListener('pointerup', this.onCameraPresetPointerUp);
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
    this.bindVehicleParts(content, d);
    this.addWheelChildren(content, d, d.fragmentChildren ?? []);
    this.viewer.setContent(content);
    this.bindVehicleLights(content, d);
    this.buildCameraPresetHotspots(new THREE.Box3().setFromObject(content));
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

  /** Captures real GTA skin weights; most vehicle bodies are one skinned mesh. */
  private bindVehicleParts(root: THREE.Group, vehicle: DrawableData): void {
    this.vehiclePartBones.clear();
    this.vehicleSkinBindings = [];
    for (const part of Object.keys(VEHICLE_PART_BONES) as VehiclePart[]) {
      const names = new Set(VEHICLE_PART_BONES[part]);
      const boneIndex = vehicle.bones.findIndex((bone) => names.has(bone.name.toLowerCase()));
      if (boneIndex < 0) continue;
      const side = Math.sign(Number(vehicle.bones[boneIndex].world[12])) || (part.includes('driver') ? -1 : 1);
      const pivot = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(vehicle.bones[boneIndex].world));
      // GTA models place glass, handles, hinges and boot spoilers on child bones.
      // They inherit their parent's pose, so use the door/boot's full descendant tree.
      const boneIndices = new Set<number>([boneIndex]);
      let foundChild = true;
      while (foundChild) {
        foundChild = false;
        vehicle.bones.forEach((bone, index) => {
          if (!boneIndices.has(index) && boneIndices.has(bone.parent)) {
            boneIndices.add(index);
            foundChild = true;
          }
        });
      }
      this.vehiclePartBones.set(part, { boneIndices, pivot, side });
    }
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const geometry = object.geometry;
      const skin = geometry.userData.widekitSkin as { blendIndices?: Uint8Array; blendWeights?: Uint8Array } | undefined;
      const position = geometry.getAttribute('position');
      if (!skin?.blendIndices || !skin?.blendWeights || !(position instanceof THREE.BufferAttribute)) return;
      const normal = geometry.getAttribute('normal');
      this.vehicleSkinBindings.push({
        geometry,
        position,
        ...(normal instanceof THREE.BufferAttribute ? { normal } : {}),
        restPositions: new Float32Array(position.array as Float32Array),
        ...(normal instanceof THREE.BufferAttribute ? { restNormals: new Float32Array(normal.array as Float32Array) } : {}),
        blendIndices: skin.blendIndices,
        blendWeights: skin.blendWeights,
      });
    });
    this.applyVehiclePartTransforms();
  }

  /** Creates a glowing overlay for one GTA external-light state. */
  private addVehicleLightOverlay(source: THREE.Mesh, original: THREE.MeshStandardMaterial, stateId?: number): VehicleLightBinding {
    const material = original.clone();
    material.userData = { ...original.userData, widekitLightOverlay: true };
    // Add only the authored lamp texture over the untouched base lens.
    material.color.set(0x000000);
    material.map = null;
    material.emissive.set(0xffffff);
    material.emissiveMap = original.map;
    material.emissiveIntensity = 2.5;
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    if (stateId !== undefined) {
      material.vertexColors = true;
      const stateAlpha = (stateId / 255).toFixed(8);
      // onBeforeCompile is state-specific. Without a unique key Three.js
      // reuses the first compiled light shader for every button.
      material.customProgramCacheKey = () => `widekit-light-state-${stateId}`;
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#ifdef USE_COLOR\n  diffuseColor.rgb *= vColor.rgb;\n#endif\nif (abs(vColor.a - ${stateAlpha}) > 0.00196) discard;`
        );
      };
    }
    material.needsUpdate = true;
    const overlay = new THREE.Mesh(source.geometry, material);
    overlay.name = `widekit-light-overlay-${stateId ?? 'semantic'}`;
    overlay.visible = false;
    overlay.frustumCulled = false;
    overlay.renderOrder = source.renderOrder + 1;
    overlay.userData.widekitLightOverlay = true;
    source.add(overlay);
    return { overlay, material, source: original };
  }

  /** Keeps overlays in sync when a referenced YTD texture arrives asynchronously. */
  private refreshVehicleLightMaps(): void {
    for (const bindings of this.vehicleLights.values()) {
      for (const binding of bindings) {
        if (binding.material.emissiveMap !== binding.source.map) {
          binding.material.emissiveMap = binding.source.map;
          binding.material.needsUpdate = true;
        }
      }
    }
  }

  /** Changes a group without replacing any authored GTA material. */
  private setVehicleLightOverlayVisible(light: VehicleLight, visible: boolean): void {
    for (const binding of this.vehicleLights.get(light) ?? []) {
      binding.material.emissiveMap = binding.source.map;
      binding.material.needsUpdate = true;
      binding.overlay.visible = visible;
    }
  }

  /** Runs the familiar on/off indicator rhythm only while indicators are enabled. */
  private animateIndicators = (): void => {
    if (!this.indicatorsEnabled) {
      this.indicatorAnimationFrame = undefined;
      return;
    }
    const cycle = 920;
    const phase = performance.now() % cycle;
    this.setVehicleLightOverlayVisible('indicators', phase < cycle * 0.56);
    this.viewer.requestRender();
    this.indicatorAnimationFrame = requestAnimationFrame(this.animateIndicators);
  };

  /**
   * Derives controllable lights from the real GTA external-state IDs in vertex
   * alpha. Shader-name inference remains only as a fallback for unusual YFTs.
   */
  private bindVehicleLights(root: THREE.Group, vehicle: DrawableData): void {
    this.vehicleLights.clear();
    root.updateMatrixWorld(true);
    const vehicleBox = new THREE.Box3().setFromObject(root);
    const vehicleCentreY = vehicleBox.getCenter(new THREE.Vector3()).y;
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object.userData.widekitLightOverlay) return;
      const original = object.material;
      if (!(original instanceof THREE.MeshStandardMaterial)) return;
      const shader = vehicle.shaders[Number(original.userData.shaderIndex)];
      const signature = [shader?.name, shader?.diffuse, ...(shader?.textures.map((texture) => texture.texture) ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!/(light|lamp|emissive|brake|reverse|indicator|signal|turn)/.test(signature)) return;
      const colours = object.geometry.getAttribute('color');
      const alphaValues = colours instanceof THREE.BufferAttribute && colours.itemSize >= 4
        ? new Set(Array.from(colours.array as ArrayLike<number>).filter((_, index) => index % colours.itemSize === 3))
        : new Set<number>();
      let foundState = false;
      for (const stateId of alphaValues) {
        const light = GTA_LIGHT_STATE[stateId];
        if (!light) continue;
        foundState = true;
        const bindings = this.vehicleLights.get(light) ?? [];
        bindings.push(this.addVehicleLightOverlay(object, original, stateId));
        this.vehicleLights.set(light, bindings);
      }
      if (foundState) return;
      const bounds = new THREE.Box3().setFromObject(object);
      const light = vehicleLightKind(signature, bounds.getCenter(new THREE.Vector3()).y >= vehicleCentreY);
      if (!light) return;
      const bindings = this.vehicleLights.get(light) ?? [];
      bindings.push(this.addVehicleLightOverlay(object, original));
      this.vehicleLights.set(light, bindings);
    });
    this.refreshVehicleLightMaps();
  }

  /** Builds clickable, screen-legible points around the active vehicle. */
  private buildCameraPresetHotspots(bounds: THREE.Box3): void {
    this.cameraPresetHotspots?.removeFromParent();
    if (bounds.isEmpty()) return;
    const group = new THREE.Group();
    group.name = 'widekit-camera-presets';
    group.visible = this.cameraPresetsVisible;
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const markScale = Math.max(Math.max(size.x, size.y, size.z) * 0.09, 0.2);
    const points: Array<[CameraPreset, string, THREE.Vector3]> = [
      ['front', 'FRONT', new THREE.Vector3(center.x, bounds.max.y + size.y * 0.12, center.z + size.z * 0.18)],
      ['rear', 'REAR', new THREE.Vector3(center.x, bounds.min.y - size.y * 0.12, center.z + size.z * 0.18)],
      ['side', 'SIDE', new THREE.Vector3(bounds.max.x + size.x * 0.12, center.y, center.z + size.z * 0.12)],
      ['top', 'TOP', new THREE.Vector3(center.x, center.y, bounds.max.z + size.z * 0.34)],
      ['under', 'UNDER', new THREE.Vector3(center.x, center.y, bounds.min.z - size.z * 0.22)],
      ['engine', 'ENGINE', new THREE.Vector3(center.x, bounds.max.y - size.y * 0.25, bounds.max.z + size.z * 0.18)],
      ['trunk', 'TRUNK', new THREE.Vector3(center.x, bounds.min.y + size.y * 0.11, bounds.max.z + size.z * 0.13)],
      ['interior', 'INTERIOR', new THREE.Vector3(bounds.min.x - size.x * 0.09, center.y + size.y * 0.02, bounds.min.z + size.z * 0.62)],
    ];
    for (const [preset, label, position] of points) group.add(this.createCameraPresetMarker(preset, label, position, markScale));
    this.cameraPresetHotspots = group;
    this.viewer.overlay.add(group);
  }

  private createCameraPresetMarker(preset: CameraPreset, label: string, position: THREE.Vector3, scale: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 54;
    const context = canvas.getContext('2d');
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = 'rgba(7, 17, 31, 0.82)';
      context.beginPath();
      context.roundRect(2, 3, 216, 48, 24);
      context.fill();
      context.strokeStyle = preset === 'engine' ? '#ff9f1c' : '#6ff2c3';
      context.lineWidth = 2;
      context.stroke();
      context.beginPath();
      context.arc(27, 27, 7, 0, Math.PI * 2);
      context.fillStyle = preset === 'engine' ? '#ff9f1c' : '#6ff2c3';
      context.fill();
      context.fillStyle = '#f7f8fb';
      context.font = 'bold 18px monospace';
      context.textBaseline = 'middle';
      context.fillText(label, 44, 28);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
    const marker = new THREE.Sprite(material);
    marker.name = `widekit-camera-preset-${preset}`;
    marker.position.copy(position);
    marker.scale.set(scale * 1.4, scale * 0.34, 1);
    marker.renderOrder = 10;
    marker.userData.cameraPreset = preset;
    return marker;
  }

  private onCameraPresetPointerDown = (event: PointerEvent): void => {
    this.cameraPresetPointer = new THREE.Vector2(event.clientX, event.clientY);
  };

  private onCameraPresetPointerUp = (event: PointerEvent): void => {
    if (!this.cameraPresetsVisible || !this.cameraPresetHotspots || !this.cameraPresetPointer) return;
    if (this.cameraPresetPointer.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 7) return;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const cursor = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(cursor, this.viewer.camera);
    const hit = raycaster.intersectObjects(this.cameraPresetHotspots.children, true).find((item) => isCameraPreset(item.object.userData.cameraPreset));
    if (!hit) return;
    event.preventDefault();
    this.setCameraPreset(hit.object.userData.cameraPreset as string);
  };

  private animateCamera(target: THREE.Vector3, direction: THREE.Vector3, distance: number): void {
    if (this.cameraPresetAnimationFrame !== undefined) cancelAnimationFrame(this.cameraPresetAnimationFrame);
    const startPosition = this.viewer.camera.position.clone();
    const startTarget = this.viewer.controls.target.clone();
    const endPosition = target.clone().addScaledVector(direction, distance);
    const startedAt = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - startedAt) / 560);
      const eased = t * t * (3 - 2 * t);
      this.viewer.camera.position.lerpVectors(startPosition, endPosition, eased);
      this.viewer.controls.target.lerpVectors(startTarget, target, eased);
      this.viewer.controls.update();
      this.viewer.requestRender();
      if (t < 1) this.cameraPresetAnimationFrame = requestAnimationFrame(tick);
      else this.cameraPresetAnimationFrame = undefined;
    };
    tick();
  }

  /** Interpolates part poses with a short eased motion instead of snapping. */
  private animateVehicleParts = (): void => {
    const now = performance.now();
    const duration = 360;
    for (const [part, transition] of this.vehiclePartTransitions) {
      const t = Math.min(1, (now - transition.startedAt) / duration);
      // Smoothstep keeps the motion gentle at both ends, including reversals.
      const eased = t * t * (3 - 2 * t);
      this.vehiclePartProgress.set(part, THREE.MathUtils.lerp(transition.from, transition.to, eased));
      if (t === 1) this.vehiclePartTransitions.delete(part);
    }
    this.applyVehiclePartTransforms();
    this.viewer.requestRender();
    if (this.vehiclePartTransitions.size) this.vehicleAnimationFrame = requestAnimationFrame(this.animateVehicleParts);
    else this.vehicleAnimationFrame = undefined;
  };

  /** Deforms vertices by their moving bone or any descendant of that bone. */
  private applyVehiclePartTransforms(): void {
    const transforms = new Map<number, { matrix: THREE.Matrix4; normal: THREE.Matrix3 }>();
    for (const [part, progress] of this.vehiclePartProgress) {
      if (progress <= 0.0001) continue;
      const bone = this.vehiclePartBones.get(part);
      if (!bone) continue;
      const rotation = this.vehiclePartRotation(part, bone.side, progress);
      const matrix = new THREE.Matrix4()
        .makeTranslation(bone.pivot.x, bone.pivot.y, bone.pivot.z)
        .multiply(rotation)
        .multiply(new THREE.Matrix4().makeTranslation(-bone.pivot.x, -bone.pivot.y, -bone.pivot.z));
      const transform = { matrix, normal: new THREE.Matrix3().getNormalMatrix(matrix) };
      for (const boneIndex of bone.boneIndices) transforms.set(boneIndex, transform);
    }
    const point = new THREE.Vector3();
    const direction = new THREE.Vector3();
    for (const binding of this.vehicleSkinBindings) {
      const positions = binding.position.array as Float32Array;
      positions.set(binding.restPositions);
      const normals = binding.normal?.array as Float32Array | undefined;
      if (normals && binding.restNormals) normals.set(binding.restNormals);
      for (let vertex = 0; vertex < binding.position.count; vertex++) {
        const base = vertex * 4;
        let transform: { matrix: THREE.Matrix4; normal: THREE.Matrix3 } | undefined;
        let strongest = 0;
        for (let influence = 0; influence < 4; influence++) {
          const candidate = transforms.get(binding.blendIndices[base + influence]);
          const weight = binding.blendWeights[base + influence];
          if (candidate && weight > strongest) {
            transform = candidate;
            strongest = weight;
          }
        }
        if (!transform || strongest === 0) continue;
        const p = vertex * 3;
        point.fromArray(binding.restPositions, p).applyMatrix4(transform.matrix);
        positions[p] = point.x;
        positions[p + 1] = point.y;
        positions[p + 2] = point.z;
        if (normals && binding.restNormals) {
          direction.fromArray(binding.restNormals, p).applyMatrix3(transform.normal).normalize();
          normals[p] = direction.x;
          normals[p + 1] = direction.y;
          normals[p + 2] = direction.z;
        }
      }
      binding.position.needsUpdate = true;
      if (binding.normal) binding.normal.needsUpdate = true;
      binding.geometry.computeBoundingSphere();
    }
  }

  private vehiclePartRotation(part: VehiclePart, side: number, progress: number): THREE.Matrix4 {
    if (part === 'bonnet') return new THREE.Matrix4().makeRotationX(0.72 * progress);
    if (part === 'boot') return new THREE.Matrix4().makeRotationX(-0.68 * progress);
    // Door direction is derived from the authored bone's X position: left
    // opens left, right opens right. This works for both front and rear doors.
    return new THREE.Matrix4().makeRotationZ(side * 0.76 * progress);
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
  private addWheelChildren(root: THREE.Group, vehicle: DrawableData, children: FragmentChildData[]): void {
    const slots = new Map<WheelSlot, FragmentChildData>();
    for (const child of children) {
      const slot = wheelSlot(child.boneTag);
      if (slot) slots.set(slot, child);
    }
    // This vehicle provides a single detailed wheel drawable (LF); the other
    // three physics children only provide placement transforms. Build it once
    // and clone it, so every slot gets the exact same geometry/material set.
    const source = slots.get('lf')?.drawable ?? slots.get('rf')?.drawable
      ?? slots.get('lr')?.drawable ?? slots.get('rr')?.drawable;
    if (!source) return;
    const drawable = source.shaders.length === 0
      ? { ...source, shaders: vehicle.shaders, textures: vehicle.textures, hasExternalTextures: vehicle.hasExternalTextures }
      : source;
    const template = buildDrawable(drawable, availableLod(drawable, 'high'), this.store, this.opts);
    template.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh;
        mesh.frustumCulled = false;
        // A reflected right-side wheel reverses face winding. Render both
        // sides so its authored normals and spokes remain visible.
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => { material.side = THREE.DoubleSide; });
      }
    });

    for (const slot of ['lf', 'rf', 'lr', 'rr'] as const) {
      const child = slots.get(slot);
      if (!child) continue;
      const wheel = slot === 'lf' ? template : template.clone(true);
      wheel.name = `wheel_${slot}`;
      wheel.matrixAutoUpdate = false;
      // The mesh is local to the source wheel. Each physics child supplies
      // the exact world placement for its own corner of the vehicle.
      wheel.matrix.fromArray(fragmentMatrix(child.transform));
      if (slot === 'rf' || slot === 'rr') {
        // GTA stores the detailed wheel on the left side. Reflect its local
        // geometry for the two right-hand sockets instead of showing it
        // inside-out/backwards.
        wheel.matrix.multiply(new THREE.Matrix4().makeScale(-1, 1, 1));
      }
      wheel.matrixWorldNeedsUpdate = true;
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
function fragmentMatrix(transform: number[]): number[] {
  const matrix = transform.slice(0, 16);
  matrix[15] = 1;
  return matrix;
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
