import { Injectable } from '@angular/core';
import type { ErrorEvent, Map as LibreMap, Popup, StyleSpecification } from 'maplibre-gl';

let protocolRegistered = false;
const DEFAULT_BOUNDS: [[number, number], [number, number]] = [
  [5.9559, 45.8179],
  [10.4921, 47.8085]
];

@Injectable()
export class MapService {
  private map?: LibreMap;
  private resizeObserver?: ResizeObserver;
  private styleController?: AbortController;
  private generation = 0;

  async init(container: HTMLElement, onReady: () => void, onError: (event: ErrorEvent & { sourceId?: string }) => void, excludedLayerIds: readonly string[] = []): Promise<{ map: LibreMap; Popup: typeof Popup } | undefined> {
    this.destroy();
    const generation = this.generation;
    const controller = new AbortController();
    this.styleController = controller;
    // Match the reference app's lazy import, including its CommonJS default export.
    const [{ default: mapgl }, { Protocol }, response] = await Promise.all([
      import('maplibre-gl'), import('pmtiles'),
      fetch('https://tiles.openfreemap.org/styles/positron', { signal: controller.signal })
    ]);
    if (!response.ok) throw new Error(`Failed to load map style: ${response.status}`);
    const style: StyleSpecification = await response.json();
    if (generation !== this.generation) return;
    style.layers = style.layers.filter(layer => !excludedLayerIds.includes(layer.id));
    if (!protocolRegistered) {
      mapgl.addProtocol('pmtiles', new Protocol().tile);
      protocolRegistered = true;
    }

    const map = new mapgl.Map({
      container,
      style,
      bounds: DEFAULT_BOUNDS,
      fitBoundsOptions: { padding: 20 },
      attributionControl: { compact: true }
    });
    this.map = map;
    map.addControl(new mapgl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new mapgl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('error', onError);
    map.once('load', onReady);
    this.resizeObserver = new ResizeObserver(() => map.resize());
    this.resizeObserver.observe(container);
    return { map, Popup: mapgl.Popup };
  }

  resetView(): void {
    this.map?.fitBounds(DEFAULT_BOUNDS, { padding: 20, duration: 0 });
  }

  destroy(): void {
    this.generation++;
    this.styleController?.abort();
    this.styleController = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.map?.remove();
    this.map = undefined;
  }
}
