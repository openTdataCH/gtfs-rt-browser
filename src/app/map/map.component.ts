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
      <div class="layer-manager" role="group" aria-label="Map layers">
        <div class="layer-manager-heading">Layers</div>
        <label>
          <input type="checkbox" [checked]="resultShapesVisible()" (change)="updateResultShapesVisibility($event)">
          <span>GTFS-RT Shapes</span>
        </label>
        <label>
          <input type="checkbox" [checked]="shapesVisible()" (change)="updateShapesVisibility($event)">
          <span>GTFS-S Shapes</span>
        </label>
        @if (resultShapesStatus() === 'loading') {
          <div class="layer-status text-secondary" role="status">Loading filtered trip shapes…</div>
        } @else if (resultShapesStatus() === 'error') {
          <div class="layer-status text-danger" role="status" [title]="resultShapesError() || ''">Filtered trip shapes unavailable.</div>
        }
        <label>
          <input type="checkbox" [checked]="backgroundMapsVisible()" (change)="updateBackgroundMapsVisibility($event)">
          <span>Background Map</span>
        </label>
      </div>
      @if (graphError()) {
        <div class="graph-status small" role="status">The shapes graph could not be loaded.</div>
      }
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
    .layer-manager { position: absolute; top: 10px; left: 10px; margin: 0;
      padding: .5rem .75rem; border: 0; border-radius: 4px; background: #fff;
      box-shadow: 0 0 0 2px #0000001a; font-size: .8rem; }
    .layer-manager-heading { margin: 0 0 .4rem;
      font-size: inherit; font-weight: 600; }
    .layer-manager label { display: flex; align-items: center; gap: .5rem; cursor: pointer; }
    .layer-manager label + label { margin-top: .25rem; }
    .layer-manager input { margin: 0; accent-color: #357abd; }
    .layer-status { margin: .25rem 0; max-width: 13rem; font-size: .75rem; }
    .graph-status { position: absolute; bottom: 2rem; left: .5rem;
      padding: .25rem .5rem; border-radius: .25rem; background: #ffffffed; }
    .map-status { position: absolute; inset: 0; display: flex; align-items: center;
      justify-content: center; gap: .5rem; background: #ffffffd9; }
  `
})
export class MapComponent {
  private readonly excludedBasemapLayerIds: readonly string[] = ['landcover_wood', 'park'];
  readonly stops = input<readonly MapStop[]>([]);
  readonly tripId = input<string>();
  readonly resultEdgeIds = input<readonly number[]>([]);
  readonly resultShapesStatus = input<'loading' | 'ready' | 'error'>('loading');
  readonly resultShapesError = input<string>();
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly graphError = signal(false);
  protected readonly shapesVisible = signal(true);
  protected readonly resultShapesVisible = signal(true);
  protected readonly backgroundMapsVisible = signal(true);
  private readonly mapService = inject(MapService);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  private readonly destroyRef = inject(DestroyRef);
  private libreMap?: LibreMap;
  private popup?: Popup;
  private stopData: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };
  private routeData: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };
  private readonly tripShape = signal<{ tripId: string; data: FeatureCollection<LineString> } | undefined>(undefined);
  private loadTimeout?: ReturnType<typeof setTimeout>;
  private appliedResultEdgeIds = new Set<number>();

  constructor() {
    effect(() => this.updateResultShapeEdges(this.resultEdgeIds()));
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
    this.appliedResultEdgeIds.clear();
    this.state.set('loading');
    this.graphError.set(false);
    this.loadTimeout = setTimeout(() => this.state.set('error'), 20_000);
    try {
      const initialized = await this.mapService.init(this.container().nativeElement, () => {
        clearTimeout(this.loadTimeout);
        this.state.set('ready');
      }, event => {
        if (event.sourceId === 'shapes-graph') {
          this.graphError.set(true);
          return;
        }
        clearTimeout(this.loadTimeout);
        this.state.set('error');
      }, this.excludedBasemapLayerIds);
      if (!initialized || this.destroyRef.destroyed) return;
      this.libreMap = initialized.map;
      initialized.map.once('load', () => this.addLayers(initialized.map, initialized.Popup));
    } catch {
      if (this.destroyRef.destroyed) return;
      clearTimeout(this.loadTimeout);
      this.state.set('error');
    }
  }

  protected updateShapesVisibility(event: Event): void {
    const visible = (event.target as HTMLInputElement).checked;
    this.shapesVisible.set(visible);
    if (this.libreMap?.getLayer('shapes-graph')) {
      this.libreMap.setLayoutProperty('shapes-graph', 'visibility', visible ? 'visible' : 'none');
    }
  }

  protected updateResultShapesVisibility(event: Event): void {
    const visible = (event.target as HTMLInputElement).checked;
    this.resultShapesVisible.set(visible);
    if (this.libreMap?.getLayer('result-shapes')) {
      this.libreMap.setLayoutProperty('result-shapes', 'visibility', visible ? 'visible' : 'none');
    }
  }

  private updateResultShapeEdges(edgeIds: readonly number[]): void {
    const map = this.libreMap;
    if (!map?.getSource('shapes-graph')) return;
    const next = new Set(edgeIds);
    for (const id of this.appliedResultEdgeIds) {
      if (!next.has(id)) map.removeFeatureState({ source: 'shapes-graph', sourceLayer: 'trgraph', id }, 'inResults');
    }
    for (const id of next) {
      if (!this.appliedResultEdgeIds.has(id)) {
        map.setFeatureState({ source: 'shapes-graph', sourceLayer: 'trgraph', id }, { inResults: true });
      }
    }
    this.appliedResultEdgeIds = next;
  }

  protected updateBackgroundMapsVisibility(event: Event): void {
    const visible = (event.target as HTMLInputElement).checked;
    this.backgroundMapsVisible.set(visible);
    if (this.libreMap?.getLayer('background-mask')) {
      this.libreMap.setLayoutProperty('background-mask', 'visibility', visible ? 'none' : 'visible');
    }
  }

  private addLayers(map: LibreMap, PopupType: typeof Popup): void {
    const firstLabelLayerId = map.getStyle().layers.find(layer => layer.type === 'symbol')?.id;
    map.addSource('background-mask', {
      type: 'geojson',
      data: {
        type: 'Feature', properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [-180, -85.051129], [180, -85.051129],
            [180, 85.051129], [-180, 85.051129], [-180, -85.051129]
          ]]
        }
      }
    });
    map.addLayer({
      id: 'background-mask', type: 'fill', source: 'background-mask',
      layout: { visibility: this.backgroundMapsVisible() ? 'none' : 'visible' },
      paint: { 'fill-color': '#fff', 'fill-opacity': 1, 'fill-antialias': false }
    }, firstLabelLayerId);
    map.addSource('shapes-graph', { type: 'vector', url: `pmtiles://${APP_URLS.shapesGraph}` });
    map.addLayer({
      id: 'shapes-graph', type: 'line', source: 'shapes-graph', 'source-layer': 'trgraph',
      layout: {
        'line-join': 'round', 'line-cap': 'round',
        visibility: this.shapesVisible() ? 'visible' : 'none'
      },
      paint: {
        'line-color': '#7b8794',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 14, 2],
        'line-opacity': 0.5
      }
    });
    map.addLayer({
      id: 'result-shapes', type: 'line', source: 'shapes-graph', 'source-layer': 'trgraph',
      layout: {
        'line-join': 'round', 'line-cap': 'round',
        visibility: this.resultShapesVisible() ? 'visible' : 'none'
      },
      paint: {
        'line-color': '#e58b24',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 14, 3.5],
        'line-opacity': ['case', ['boolean', ['feature-state', 'inResults'], false], 0.9, 0]
      }
    });
    this.updateResultShapeEdges(this.resultEdgeIds());
    map.addSource('trip-route', { type: 'geojson', data: this.routeData });
    map.addLayer({
      id: 'trip-route-casing', type: 'line', source: 'trip-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#fff', 'line-width': 8 }
    });
    map.addLayer({
      id: 'trip-route', type: 'line', source: 'trip-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#357abd', 'line-width': 5, 'line-opacity': 0.9 }
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
