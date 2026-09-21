import { ScrollingModule } from '@angular/cdk/scrolling';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FeedMetadataDto } from './gtfs-rt/dto';
import { TripUpdate } from './gtfs-rt/models';
import { GtfsRtStreamService } from './gtfs-rt/services';

const GTFS_RT_FEED_URL = 'https://api.opentransportdata.swiss/la/gtfs-rt';

interface ParseState {
  readonly status: 'idle' | 'loading' | 'complete' | 'error';
  readonly processed: number;
  readonly count: number;
  readonly elapsedMs: number;
  readonly message: string;
}

@Component({
  selector: 'app-root',
  imports: [ScrollingModule, DatePipe, DecimalPipe],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent {
  private readonly stream = inject(GtfsRtStreamService);
  private readonly destroyRef = inject(DestroyRef);
  private startedAt = 0;

  protected readonly title = 'GTFS-RT Browser';
  protected readonly feedUrl = signal<string>(GTFS_RT_FEED_URL);
  protected readonly parseState = signal<ParseState>(emptyParseState('idle'));
  protected readonly metadata = signal<FeedMetadataDto | undefined>(undefined);
  protected readonly items = signal<readonly TripUpdate[]>([]);
  protected readonly selectedId = signal<string | undefined>(undefined);
  protected readonly searchTerm = signal('');
  protected readonly routeFilter = signal('');
  protected readonly agencyFilter = signal('');
  protected readonly relationshipFilter = signal('');
  protected readonly delayedOnly = signal(false);
  protected readonly filtersExpanded = signal(false);
  protected readonly activeView = signal<'messages' | 'errors'>('messages');

  protected readonly messageItems = computed(() => this.items().filter((item) => item.hasRouteId));
  protected readonly errorItems = computed(() => this.items().filter((item) => !item.hasRouteId));
  protected readonly viewItems = computed(() =>
    this.activeView() === 'messages' ? this.messageItems() : this.errorItems());

  protected readonly routeOptions = computed(() => {
    const counts = new Map<string, number>();
    for (const item of this.messageItems()) counts.set(item.routeId, (counts.get(item.routeId) ?? 0) + 1);
    return [...counts].map(([id, count]) => ({ id, count }))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  });

  protected readonly agencyOptions = computed(() => {
    const options = new Map<string, { id: string; name: string; count: number }>();
    for (const item of this.messageItems()) {
      const current = options.get(item.agencyId);
      options.set(item.agencyId, {
        id: item.agencyId,
        name: item.agencyName,
        count: (current?.count ?? 0) + 1
      });
    }
    return [...options.values()].sort((left, right) => left.name.localeCompare(right.name));
  });

  protected readonly relationshipOptions = computed(() => {
    const counts = new Map<string, number>();
    for (const item of this.viewItems()) counts.set(item.relationship, (counts.get(item.relationship) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly filteredItems = computed(() => {
    const route = this.routeFilter();
    const agency = this.agencyFilter();
    const relationship = this.relationshipFilter();
    return this.viewItems().filter((item) => item.matches(this.searchTerm())
      && (!route || item.routeId === route)
      && (!agency || item.agencyId === agency)
      && (!relationship || item.relationship === relationship)
      && (!this.delayedOnly() || (item.maxDelay ?? 0) > 0));
  });

  protected readonly selected = computed(() => {
    const items = this.filteredItems();
    return items.find((item) => item.id === this.selectedId()) ?? items[0];
  });

  public constructor() { this.parseFeed(); }

  protected parseFeed(): void {
    this.items.set([]); this.selectedId.set(undefined); this.metadata.set(undefined);
    this.startedAt = performance.now();
    this.parseState.set(emptyParseState('loading'));
    this.stream.streamTripUpdates(this.feedUrl()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (event) => {
        if (event.type === 'metadata') this.metadata.set(event.metadata);
        if (event.type === 'trip-updates') {
          this.items.update((items) => [...items, ...event.updates]);
          this.selectedId.update((id) => id ?? event.updates[0]?.id);
          this.parseState.set({ ...emptyParseState('loading'), processed: event.processed });
        }
        if (event.type === 'complete') {
          this.parseState.set({ ...emptyParseState('complete'), count: event.count, elapsedMs: performance.now() - this.startedAt });
        }
      },
      error: (error: Error) => this.parseState.set({ ...emptyParseState('error'), message: error.message })
    });
  }

  protected select(item: TripUpdate): void { this.selectedId.set(item.id); }
  protected selectView(view: 'messages' | 'errors'): void {
    this.activeView.set(view);
    this.routeFilter.set('');
    this.agencyFilter.set('');
    this.selectedId.set(undefined);
  }
  protected trackById(_index: number, item: TripUpdate): string { return item.id; }
  protected updateSearch(event: Event): void { this.searchTerm.set((event.target as HTMLInputElement).value); }
  protected updateRoute(event: Event): void { this.routeFilter.set((event.target as HTMLSelectElement).value); }
  protected updateAgency(event: Event): void { this.agencyFilter.set((event.target as HTMLSelectElement).value); }
  protected updateRelationship(event: Event): void { this.relationshipFilter.set((event.target as HTMLSelectElement).value); }
  protected updateDelayedOnly(event: Event): void { this.delayedOnly.set((event.target as HTMLInputElement).checked); }
  protected toggleFilters(): void { this.filtersExpanded.update((value) => !value); }

  protected delayLabel(seconds?: number): string {
    if (seconds === undefined) return 'No delay data';
    const sign = seconds > 0 ? '+' : '';
    return `${sign}${Math.round(seconds / 60)} min`;
  }

  protected delayClass(seconds?: number): string {
    if (seconds === undefined || seconds === 0) return 'text-bg-secondary';
    return seconds > 0 ? 'text-bg-danger' : 'text-bg-success';
  }
}

function emptyParseState(status: ParseState['status']): ParseState {
  return { status, processed: 0, count: 0, elapsedMs: 0, message: '' };
}
