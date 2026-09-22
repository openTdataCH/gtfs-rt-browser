import { ScrollingModule } from '@angular/cdk/scrolling';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FeedMetadataDto } from './gtfs-rt/dto';
import { TripUpdate } from './gtfs-rt/models';
import { GtfsRtStreamService } from './gtfs-rt/services';

const GTFS_RT_FEED_URL = 
  'https://tools.opentransportdata.swiss/data/gtfs-rt/gtfs-rt-latest.pb';
const TIMELINE_CELL_MINUTES = 15;
const TIMELINE_CELL_WIDTH = 72;

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
  private readonly browserNow = signal(Date.now());
  private startedAt = 0;

  protected readonly title = 'GTFS-RT Browser';
  protected readonly feedUrl = signal<string>(GTFS_RT_FEED_URL);
  protected readonly parseState = signal<ParseState>(emptyParseState('idle'));
  protected readonly metadata = signal<FeedMetadataDto | undefined>(undefined);
  protected readonly feedNow = computed(() => {
    const timestamp = this.metadata()?.timestamp;
    return timestamp === undefined ? undefined : new Date(timestamp * 1000);
  });
  protected readonly feedTimeOffsetMinutes = computed(() => {
    const now = this.feedNow();
    return now === undefined ? undefined : Math.round((now.getTime() - this.browserNow()) / 60_000);
  });
  protected readonly items = signal<readonly TripUpdate[]>([]);
  protected readonly selectedId = signal<string | undefined>(undefined);
  protected readonly searchTerm = signal('');
  protected readonly routeFilter = signal('');
  protected readonly agencyFilter = signal('');
  protected readonly relationshipFilter = signal('');
  protected readonly delayedOnly = signal(false);
  protected readonly filtersExpanded = signal(false);
  protected readonly activeView = signal<'timeline' | 'errors'>('timeline');

  protected readonly timelineItems = computed(() => this.items().filter((item) =>
    item.dto.timeline !== undefined && item.dto.timelineError === undefined));
  protected readonly errorItems = computed(() => this.items().filter((item) =>
    item.dto.timeline === undefined || item.dto.timelineError !== undefined));
  protected readonly viewItems = computed(() =>
    this.activeView() === 'timeline' ? this.timelineItems() : this.errorItems());

  protected readonly routeOptions = computed(() => {
    const counts = new Map<string, number>();
    for (const item of this.timelineItems()) counts.set(item.routeId, (counts.get(item.routeId) ?? 0) + 1);
    return [...counts].map(([id, count]) => ({ id, count }))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  });

  protected readonly agencyOptions = computed(() => {
    const options = new Map<string, { id: string; name: string; count: number }>();
    for (const item of this.timelineItems()) {
      const current = options.get(item.agencyId);
      options.set(item.agencyId, {
        id: item.agencyId,
        name: item.agencyName,
        count: (current?.count ?? 0) + 1
      });
    }
    return [...options.values()].sort((left, right) => {
      if (left.id === '_no_agency') return -1;
      if (right.id === '_no_agency') return 1;
      return left.name.localeCompare(right.name);
    });
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

  protected readonly timeline = computed(() => {
    const items = this.filteredItems().filter((item) => item.dto.timeline !== undefined);
    if (items.length === 0) return { start: 0, end: 0, width: 0, cells: [], rows: [] };
    const first = Math.min(...items.map((item) => item.departureDayMinutes!));
    const last = Math.max(...items.map((item) => item.arrivalDayMinutes!));
    const start = Math.floor(Math.max(0, first) / TIMELINE_CELL_MINUTES) * TIMELINE_CELL_MINUTES;
    const end = Math.ceil(Math.min(2_880, last) / TIMELINE_CELL_MINUTES) * TIMELINE_CELL_MINUTES;
    const width = Math.max(0, (end - start) / TIMELINE_CELL_MINUTES * TIMELINE_CELL_WIDTH);
    const cells = Array.from({ length: Math.max(0, (end - start) / TIMELINE_CELL_MINUTES) }, (_, index) => {
      const minute = start + index * TIMELINE_CELL_MINUTES;
      return { minute, left: index * TIMELINE_CELL_WIDTH, label: this.dayMinuteLabel(minute) };
    });
    const rows = items
      .filter((item) => item.arrivalDayMinutes! > start && item.departureDayMinutes! < end)
      .map((item) => {
        const from = Math.max(start, item.departureDayMinutes!);
        const to = Math.min(end, item.arrivalDayMinutes!);
        return {
          item,
          left: (from - start) / TIMELINE_CELL_MINUTES * TIMELINE_CELL_WIDTH,
          width: Math.max(3, (to - from) / TIMELINE_CELL_MINUTES * TIMELINE_CELL_WIDTH)
        };
      });
    return { start, end, width, cells, rows };
  });

  protected readonly timelineNowLeft = computed(() => {
    const metadata = this.metadata();
    const timeline = this.timeline();
    if (!metadata || timeline.end <= timeline.start) return undefined;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(metadata.timestamp * 1000)).map((part) => [part.type, part.value]));
    const date = `${parts['year']}-${parts['month']}-${parts['day']}`;
    const dayOffset = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${metadata.feedDay}T00:00:00Z`)) / 86_400_000;
    const minute = dayOffset * 1_440 + Number(parts['hour']) * 60
      + Number(parts['minute']) + Number(parts['second']) / 60;
    if (minute < timeline.start || minute > timeline.end) return undefined;
    return (minute - timeline.start) / TIMELINE_CELL_MINUTES * TIMELINE_CELL_WIDTH;
  });

  public constructor() {
    const clock = window.setInterval(() => this.browserNow.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => window.clearInterval(clock));
    this.parseFeed();
  }

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
  protected selectView(view: 'timeline' | 'errors'): void {
    this.activeView.set(view);
    this.routeFilter.set('');
    this.agencyFilter.set('');
    this.selectedId.set(undefined);
  }
  protected trackById(_index: number, item: TripUpdate): string { return item.id; }
  protected updateSearch(event: Event): void { this.searchTerm.set((event.target as HTMLInputElement).value); }
  protected updateRoute(event: Event): void { this.routeFilter.set((event.target as HTMLSelectElement).value); }
  protected updateAgency(event: Event): void {
    this.agencyFilter.set((event.target as HTMLSelectElement).value);
  }
  protected updateRelationship(event: Event): void { this.relationshipFilter.set((event.target as HTMLSelectElement).value); }
  protected updateDelayedOnly(event: Event): void { this.delayedOnly.set((event.target as HTMLInputElement).checked); }
  protected toggleFilters(): void { this.filtersExpanded.update((value) => !value); }

  protected delayLabel(seconds?: number): string {
    if (seconds === undefined) return 'No delay data';
    const sign = seconds > 0 ? '+' : '';
    return `${sign}${Math.round(seconds / 60)} min`;
  }

  protected agencyLabel(item: TripUpdate): string {
    return item.agencyName;
  }

  protected delayClass(seconds?: number): string {
    if (seconds === undefined || seconds === 0) return 'text-bg-secondary';
    return seconds > 0 ? 'text-bg-danger' : 'text-bg-success';
  }

  protected signedMinutes(minutes: number): string {
    return `${minutes > 0 ? '+' : ''}${minutes}min`;
  }

  protected dayMinuteLabel(minutes?: number): string {
    if (minutes === undefined) return '—';
    const dayOffset = Math.floor(minutes / 1_440);
    const minuteOfDay = ((minutes % 1_440) + 1_440) % 1_440;
    const hours = Math.floor(minuteOfDay / 60).toString().padStart(2, '0');
    const mins = (minuteOfDay % 60).toString().padStart(2, '0');
    return `${hours}:${mins}${dayOffset ? ` (+${dayOffset}d)` : ''}`;
  }
}

function emptyParseState(status: ParseState['status']): ParseState {
  return { status, processed: 0, count: 0, elapsedMs: 0, message: '' };
}
