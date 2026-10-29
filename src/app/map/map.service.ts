import { Injectable } from '@angular/core';
import type { Map as LibreMap, Popup } from 'maplibre-gl';

@Injectable()
export class MapService {
  private map?: LibreMap;
  private resizeObserver?: ResizeObserver;
  private generation = 0;

  async init(container: HTMLElement, onReady: () => void, onError: () => void): Promise<{ map: LibreMap; Popup: typeof Popup } | undefined> {
    this.destroy();
    const generation = this.generation;
    // Match the reference app's lazy import, including its CommonJS default export.
    const { default: mapgl } = await import('maplibre-gl');
    if (generation !== this.generation) return;

    const map = new mapgl.Map({
      container,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [8.23, 46.82],
      zoom: 6.5,
      attributionControl: { compact: true }
    });
    this.map = map;
    map.addControl(new mapgl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new mapgl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('error', onError);
    map.on('idle', onReady);
    this.resizeObserver = new ResizeObserver(() => map.resize());
    this.resizeObserver.observe(container);
    return { map, Popup: mapgl.Popup };
  }

  destroy(): void {
    this.generation++;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.map?.remove();
    this.map = undefined;
  }
}
