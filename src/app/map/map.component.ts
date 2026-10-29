import { afterNextRender, ChangeDetectionStrategy, Component, DestroyRef, effect, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import type { FeatureCollection, LineString, Point } from 'geojson';
import type { GeoJSONSource, Map as LibreMap, Popup } from 'maplibre-gl';
import { APP_URLS } from '../config';
import { MapService } from './map.service';
import type { MapStop } from './map-stop.model';
import { parseTripShape } from './trip-shape';

@Component({
  selector: 'app-map',
  providers: [MapService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="trip-map" aria-label="Selected trip stops map">
      <div #container class="map-container" aria-label="Interactive map"></div>
      @if (state() !== 'ready') {
        <div class="map-status small" role="status">
          @if (state() === 'error') {
            <span>The basemap could not be loaded.</span>
            <button class="btn btn-sm btn-light" type="button" (click)="initialize()">Retry map</button>
          } @else { <span>Loading basemap…</span> }
        </div>
      }
    </section>
  `,
  styles: `
    :host { display: block; width: 100%; height: 100%; }
    .trip-map { position: relative; height: 100%; overflow: hidden; }
    .map-container { width: 100%; height: 100%; }
    .map-status { position: absolute; inset: 0; display: flex; align-items: center;
      justify-content: center; gap: .5rem; background: #ffffffd9; }
  `
})
export class MapComponent {
  readonly stops = input<readonly MapStop[]>([]);
  readonly tripId = input<string>();
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  private readonly mapService = inject(MapService);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  private readonly destroyRef = inject(DestroyRef);
  private libreMap?: LibreMap;
  private popup?: Popup;
  private stopData: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };
  private routeData: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };
  private readonly tripShape = signal<{ tripId: string; data: FeatureCollection<LineString> } | undefined>(undefined);
  private loadTimeout?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(onCleanup => {
      const tripId = this.tripId()?.trim();
      this.tripShape.set(undefined);
      if (!tripId || tripId === '—') return;
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      void this.loadTripShape(tripId, controller.signal);
    });
    effect(() => {
      const shape = this.tripShape();
      this.setStops(this.stops(), shape && shape.tripId === this.tripId()?.trim() ? shape.data : undefined);
    });
    afterNextRender(() => void this.initialize());
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.loadTimeout);
      this.popup?.remove();
      this.libreMap = undefined;
      this.mapService.destroy();
    });
  }

  protected async initialize(): Promise<void> {
    clearTimeout(this.loadTimeout);
    this.popup?.remove();
    this.popup = undefined;
    this.libreMap = undefined;
    this.state.set('loading');
    this.loadTimeout = setTimeout(() => this.state.set('error'), 20_000);
    try {
      const initialized = await this.mapService.init(this.container().nativeElement, () => {
        clearTimeout(this.loadTimeout);
        this.state.set('ready');
      }, () => {
        clearTimeout(this.loadTimeout);
        this.state.set('error');
      });
      if (!initialized || this.destroyRef.destroyed) return;
      this.libreMap = initialized.map;
      initialized.map.once('load', () => this.addLayers(initialized.map, initialized.Popup));
    } catch {
      if (this.destroyRef.destroyed) return;
      clearTimeout(this.loadTimeout);
      this.state.set('error');
    }
  }

  private addLayers(map: LibreMap, PopupType: typeof Popup): void {
    map.addSource('trip-route', { type: 'geojson', data: this.routeData });
    map.addLayer({
      id: 'trip-route', type: 'line', source: 'trip-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#357abd', 'line-width': 3, 'line-opacity': 0.7 }
    });
    map.addSource('trip-stops', { type: 'geojson', data: this.stopData });
    map.addLayer({
      id: 'trip-stops', type: 'circle', source: 'trip-stops',
      paint: { 'circle-radius': 5, 'circle-color': '#357abd', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 }
    });
    map.addLayer({
      id: 'trip-stop-numbers', type: 'symbol', source: 'trip-stops',
      layout: {
        'text-field': ['to-string', ['get', 'sequence']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 14,
        'text-anchor': 'top-left',
        'text-offset': [0.35, 0.35],
        'text-allow-overlap': true,
        'text-ignore-placement': true
      },
      paint: { 'text-color': '#2764a6', 'text-halo-color': '#fff', 'text-halo-width': 2 }
    });
    map.on('click', 'trip-stops', event => {
      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== 'Point') return;
      const label = document.createElement('div');
      label.textContent = String(feature.properties?.['name'] || feature.properties?.['stopId'] || 'Stop');
      this.popup?.remove();
      this.popup = new PopupType().setLngLat(feature.geometry.coordinates as [number, number]).setDOMContent(label).addTo(map);
    });
    map.on('mouseenter', 'trip-stops', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'trip-stops', () => { map.getCanvas().style.cursor = ''; });
    this.fitStops();
  }

  private async loadTripShape(tripId: string, signal: AbortSignal): Promise<void> {
    try {
      const response = await fetch(`${APP_URLS.gtfsChTrips}/${encodeURIComponent(tripId)}/shape`, { signal });
      if (!response.ok) return;
      const data = parseTripShape(await response.json());
      if (!signal.aborted) this.tripShape.set({ tripId, data });
    } catch {
      // Missing shapes, invalid responses, and network errors retain the stop-to-stop line.
    }
  }

  private setStops(stops: readonly MapStop[], shape?: FeatureCollection<LineString>): void {
    this.popup?.remove();
    this.popup = undefined;
    this.stopData = {
      type: 'FeatureCollection',
      features: stops.flatMap((stop, index) => {
        const { longitude, latitude } = stop;
        if (longitude === undefined || latitude === undefined
          || !Number.isFinite(longitude) || !Number.isFinite(latitude)
          || Math.abs(longitude) > 180 || Math.abs(latitude) > 85) return [];
        return [{ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [longitude, latitude] },
          properties: { name: stop.name, stopId: stop.stopId, sequence: stop.sequence ?? index + 1 } }];
      })
    };
    const coordinates = this.stopData.features.map(feature => feature.geometry.coordinates);
    this.routeData = shape ?? {
      type: 'FeatureCollection',
      features: coordinates.length < 2 ? [] : [{
        type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates }
      }]
    };
    this.libreMap?.getSource<GeoJSONSource>('trip-route')?.setData(this.routeData);
    this.libreMap?.getSource<GeoJSONSource>('trip-stops')?.setData(this.stopData);
    this.fitStops();
  }

  private fitStops(): void {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    const extend = (point: number[]) => {
      west = Math.min(west, point[0]);
      south = Math.min(south, point[1]);
      east = Math.max(east, point[0]);
      north = Math.max(north, point[1]);
    };
    this.stopData.features.forEach(feature => extend(feature.geometry.coordinates));
    this.routeData.features.forEach(feature => feature.geometry.coordinates.forEach(extend));
    if (!Number.isFinite(west)) return;
    this.libreMap?.fitBounds([
      [west, south],
      [east, north]
    ], { padding: 35, maxZoom: 14, duration: 0 });
  }
}
