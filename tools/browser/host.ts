import { parseYft } from '../../src/formats/yft';
import { listYtdTextureNames, readYtdTextures } from '../../src/formats/ytd';
import type { HostToWebview, TextureData, WebviewToHost } from '../../src/shared/model';

type SourceFile = { name: string; kind: 'yft' | 'ytd'; url: string };
type SourceManifest = { assetId: string; files: SourceFile[] };

declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage(message: WebviewToHost): void; getState(): Record<string, unknown>; setState(state: Record<string, unknown>): void };
  }
}

const status = document.getElementById('wk-browser-status')!;
const state: Record<string, unknown> = {};
let manifest: SourceManifest | undefined;
let ready = false;
let loading = false;
const sourceCache = new Map<string, Uint8Array>();

const showStatus = (message: string, error = false) => {
  status.textContent = message;
  status.hidden = false;
  status.classList.toggle('is-error', error);
};
const hideStatus = () => { status.hidden = true; };
const send = (message: HostToWebview) => window.postMessage(message, window.location.origin);

async function bytes(file: SourceFile): Promise<Uint8Array> {
  const cached = sourceCache.get(file.name);
  if (cached) return cached;
  const response = await fetch(file.url, { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`Unable to load ${file.kind.toUpperCase()} source (${response.status}).`);
  const data = new Uint8Array(await response.arrayBuffer());
  sourceCache.set(file.name, data);
  return data;
}

const withOrigin = (textures: TextureData[], origin: string) => textures.map((texture) => ({ ...texture, origin }));

async function loadModel() {
  if (!manifest || loading) return;
  const model = manifest.files.find((file) => file.kind === 'yft');
  if (!model) throw new Error('This vehicle preview has no YFT model source.');
  loading = true;
  showStatus('Loading private vehicle preview…');
  try {
    const drawables = parseYft(await bytes(model), { maxSize: 1024 });
    send({ type: 'drawables', file: model.name, kind: 'fragment', drawables });
    hideStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load this vehicle preview.';
    send({ type: 'error', message });
    showStatus(message, true);
  } finally {
    loading = false;
  }
}

async function findTextures(request: Extract<WebviewToHost, { type: 'findTextures' }>) {
  if (!manifest) return;
  const wanted = new Set(request.names.map((name) => name.toLowerCase()));
  const dictionaries = manifest.files.filter((file) => file.kind === 'ytd');
  let searched = 0;
  for (const dictionary of dictionaries) {
    try {
      const data = await bytes(dictionary);
      const available = new Set(listYtdTextureNames(data).map((name) => name.toLowerCase()));
      const matches = new Set([...wanted].filter((name) => available.has(name)));
      searched += 1;
      const textures = matches.size ? withOrigin(readYtdTextures(data, matches, { maxSize: request.maxSize ?? 1024 }), dictionary.name) : [];
      textures.forEach((texture) => wanted.delete(texture.name.toLowerCase()));
      send({ type: 'textures', requestId: request.requestId, textures, source: dictionary.name, searched, done: false });
    } catch {
      searched += 1;
    }
  }
  send({ type: 'textures', requestId: request.requestId, textures: [], source: 'private asset storage', searched, done: true });
}

function onWebviewMessage(message: WebviewToHost) {
  if (message.type === 'ready') {
    ready = true;
    void loadModel();
    return;
  }
  if (message.type === 'findTextures') void findTextures(message);
}

window.acquireVsCodeApi = () => ({
  postMessage: onWebviewMessage,
  getState: () => state,
  setState: (next) => Object.assign(state, next),
});

window.addEventListener('message', (event: MessageEvent<{ type?: string; manifest?: SourceManifest }>) => {
  if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== 'widekit-source-manifest') return;
  const next = event.data.manifest;
  if (!next?.assetId || !Array.isArray(next.files) || !next.files.every((file) => file && typeof file.name === 'string' && typeof file.url === 'string' && (file.kind === 'yft' || file.kind === 'ytd'))) {
    showStatus('Invalid private preview source.', true);
    return;
  }
  manifest = next;
  sourceCache.clear();
  if (ready) void loadModel();
});

showStatus('Waiting for secure vehicle access…');
