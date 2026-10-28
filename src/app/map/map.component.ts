import { afterNextRender, ChangeDetectionStrategy, Component, DestroyRef, effect, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { MapService, type MapStop } from './map.service';

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
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  private readonly map = inject(MapService);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  private readonly destroyRef = inject(DestroyRef);
  private loadTimeout?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => this.map.setStops(this.stops()));
    afterNextRender(() => void this.initialize());
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.loadTimeout);
      this.map.destroy();
    });
  }

  protected async initialize(): Promise<void> {
    clearTimeout(this.loadTimeout);
    this.state.set('loading');
    this.loadTimeout = setTimeout(() => this.state.set('error'), 20_000);
    try {
      await this.map.init(this.container().nativeElement, () => {
        clearTimeout(this.loadTimeout);
        this.state.set('ready');
      }, () => {
        clearTimeout(this.loadTimeout);
        this.state.set('error');
      });
    } catch {
      if (this.destroyRef.destroyed) return;
      clearTimeout(this.loadTimeout);
      this.state.set('error');
    }
  }
}
