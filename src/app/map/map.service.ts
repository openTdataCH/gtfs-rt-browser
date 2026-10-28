import { Injectable } from '@angular/core';
import type { FeatureCollection, Point } from 'geojson';
import type { GeoJSONSource, Map as LibreMap } from 'maplibre-gl';

export interface MapStop {
  readonly longitude?: number;
  readonly latitude?: number;
  readonly name?: string;
  readonly stopId: string;
}

@Injectable()
export class MapService {
  private map?: LibreMap;
  private resizeObserver?: ResizeObserver;
  private generation = 0;
  private stops: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };

  async init(container: HTMLElement, onReady: () => void, onError: () => void): Promise<void> {
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
    map.on('load', () => {
      map.addSource('trip-stops', { type: 'geojson', data: this.stops });
      map.addLayer({
        id: 'trip-stops', type: 'circle', source: 'trip-stops',
        paint: { 'circle-radius': 5, 'circle-color': '#357abd', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 }
      });
      map.on('click', 'trip-stops', event => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== 'Point') return;
        const label = document.createElement('div');
        label.textContent = String(feature.properties?.['name'] || feature.properties?.['stopId'] || 'Stop');
        new mapgl.Popup().setLngLat(feature.geometry.coordinates as [number, number]).setDOMContent(label).addTo(map);
      });
      map.on('mouseenter', 'trip-stops', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'trip-stops', () => { map.getCanvas().style.cursor = ''; });
      this.fitStops();
    });
    this.resizeObserver = new ResizeObserver(() => map.resize());
    this.resizeObserver.observe(container);
  }

  setStops(stops: readonly MapStop[]): void {
    this.stops = {
      type: 'FeatureCollection',
      features: stops.flatMap(stop => {
        const { longitude, latitude } = stop;
        if (longitude === undefined || latitude === undefined
          || !Number.isFinite(longitude) || !Number.isFinite(latitude)
          || Math.abs(longitude) > 180 || Math.abs(latitude) > 85) return [];
        return [{ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [longitude, latitude] },
          properties: { name: stop.name, stopId: stop.stopId } }];
      })
    };
    this.map?.getSource<GeoJSONSource>('trip-stops')?.setData(this.stops);
    this.fitStops();
  }

  private fitStops(): void {
    const coordinates = this.stops.features.map(feature => feature.geometry.coordinates);
    if (!coordinates.length) return;
    const longitudes = coordinates.map(point => point[0]);
    const latitudes = coordinates.map(point => point[1]);
    this.map?.fitBounds([
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)]
    ], { padding: 35, maxZoom: 14, duration: 0 });
  }

  destroy(): void {
    this.generation++;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.map?.remove();
    this.map = undefined;
  }
}
