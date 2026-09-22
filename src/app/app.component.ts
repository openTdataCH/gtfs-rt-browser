import { ScrollingModule } from '@angular/cdk/scrolling';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { APP_URLS } from './config';
import { FeedMetadataDto } from './gtfs-rt/dto';
import { TripUpdate } from './gtfs-rt/models';
import { GtfsRtStreamService } from './gtfs-rt/services';
import { extendedRouteTypeLabel } from './gtfs-static/route-types';

const TIMELINE_CELL_MINUTES = 15;
const TIMELINE_CELL_WIDTH = 100;
const TIMELINE_LEAD_MINUTES = 60;
const TIMELINE_START_MINUTES = 3 * 60;
const TIMELINE_END_MINUTES = 27 * 60;

interface ParseState {
  readonly status: 'idle' | 'loading' | 'complete' | 'error';
  readonly processed: number;
  readonly count: number;
  readonly elapsedMs: number;
  readonly message: string;
}

interface TimelineRow {
  readonly item: TripUpdate;
  readonly left: number;
  readonly width: number;
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
  private readonly timelineScroll = viewChild<ElementRef<HTMLDivElement>>('timelineScroll');
  private startedAt = 0;

  protected readonly title = 'GTFS-RT Browser';
  protected readonly feedUrl = signal<string>(APP_URLS.gtfsRtFeed);
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
  protected readonly feedDayMinute = computed(() => {
    const metadata = this.metadata();
    if (!metadata) return undefined;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(metadata.timestamp * 1000)).map((part) => [part.type, part.value]));
    const date = `${parts['year']}-${parts['month']}-${parts['day']}`;
    const dayOffset = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${metadata.feedDay}T00:00:00Z`)) / 86_400_000;
    return dayOffset * 1_440 + Number(parts['hour']) * 60
      + Number(parts['minute']) + Number(parts['second']) / 60;
  });
  protected readonly items = signal<readonly TripUpdate[]>([]);
  protected readonly selectedId = signal<string | undefined>(undefined);
  protected readonly searchTerm = signal('');
  protected readonly agencyFilter = signal('');
  protected readonly routeTypeFilter = signal('');
  protected readonly relationshipFilter = signal('');
  protected readonly activeTripsOnly = signal(false);
  protected readonly groupByRouteShortName = signal(false);
  protected readonly expandedRouteShortNames = signal<ReadonlySet<string>>(new Set());
  protected readonly filtersExpanded = signal(false);
  protected readonly activeView = signal<'timeline' | 'errors'>('timeline');

  protected readonly timelineItems = computed(() => this.items().filter((item) =>
    item.dto.timeline !== undefined && item.dto.timelineError === undefined));
  protected readonly errorItems = computed(() => this.items().filter((item) =>
    item.dto.timeline === undefined || item.dto.timelineError !== undefined));
  protected readonly viewItems = computed(() =>
    this.activeView() === 'timeline' ? this.timelineItems() : this.errorItems());
  protected readonly canGroupByRouteShortName = computed(() => {
    const agency = this.agencyFilter();
    return Boolean(agency) && this.timelineItems().some((item) =>
      item.agencyId === agency && item.dto.agency !== undefined && item.dto.route !== undefined);
  });

  protected readonly agencyOptions = computed(() => {
    const routeType = this.routeTypeFilter();
    const relationship = this.relationshipFilter();
    const options = new Map<string, { id: string; name: string; count: number }>();
    for (const item of this.timelineItems()) {
      if (!item.matches(this.searchTerm())
        || (this.activeTripsOnly() && !this.isActiveAtFeedTime(item))
        || (routeType && this.routeTypeKey(item) !== routeType)
        || (relationship && item.relationship !== relationship)) continue;
      const current = options.get(item.agencyId);
      options.set(item.agencyId, {
        id: item.agencyId,
        name: this.agencyDetailLabel(item),
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
    const agency = this.agencyFilter();
    const routeType = this.routeTypeFilter();
    const counts = new Map<string, number>();
    for (const item of this.viewItems()) {
      if (!item.matches(this.searchTerm())
        || (this.activeTripsOnly() && !this.isActiveAtFeedTime(item))
        || (agency && item.agencyId !== agency)
        || (routeType && this.routeTypeKey(item) !== routeType)) continue;
      counts.set(item.relationship, (counts.get(item.relationship) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly routeTypeOptions = computed(() => {
    const agency = this.agencyFilter();
    const relationship = this.relationshipFilter();
    const options = new Map<string, { id: string; name: string; count: number }>();
    for (const item of this.timelineItems()) {
      if (!item.matches(this.searchTerm())
        || (this.activeTripsOnly() && !this.isActiveAtFeedTime(item))
        || (agency && item.agencyId !== agency)
        || (relationship && item.relationship !== relationship)) continue;
      const routeType = item.dto.route?.route_type;
      const id = routeType === undefined ? '_no_route_type' : String(routeType);
      const current = options.get(id);
      options.set(id, {
        id,
        name: routeType === undefined ? '_no_route_type' : extendedRouteTypeLabel(routeType),
        count: (current?.count ?? 0) + 1
      });
    }
    return [...options.values()].sort((left, right) => {
      if (left.id === '_no_route_type') return -1;
      if (right.id === '_no_route_type') return 1;
      return Number(left.id) - Number(right.id);
    });
  });

  protected readonly filteredItems = computed(() => {
    const agency = this.agencyFilter();
    const routeType = this.routeTypeFilter();
    const relationship = this.relationshipFilter();
    return this.viewItems().filter((item) => item.matches(this.searchTerm())
      && (!agency || item.agencyId === agency)
      && (!routeType || this.routeTypeKey(item) === routeType)
      && (!relationship || item.relationship === relationship)
      && (!this.activeTripsOnly() || this.isActiveAtFeedTime(item)));
  });

  protected readonly selected = computed(() => {
    const items = this.filteredItems();
    return items.find((item) => item.id === this.selectedId()) ?? items[0];
  });

  protected readonly timeline = computed(() => {
    const items = this.filteredItems().filter((item) => item.dto.timeline !== undefined);
    const start = TIMELINE_START_MINUTES;
    const end = TIMELINE_END_MINUTES;
    const width = Math.max(0, (end - start) / TIMELINE_CELL_MINUTES * TIMELINE_CELL_WIDTH);
    const cells = Array.from({ length: Math.max(0, (end - start) / TIMELINE_CELL_MINUTES) }, (_, index) => {
      const minute = start + index * TIMELINE_CELL_MINUTES;
      const major = minute % 15 === 0;
      return { minute, left: index * TIMELINE_CELL_WIDTH, label: major ? this.dayMinuteLabel(minute) : '', major };
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

  protected readonly timelineGroups = computed(() => {
    const groups = new Map<string, TimelineRow[]>();
    for (const row of this.timeline().rows) {
      const name = row.item.dto.route?.route_short_name || '_no_route_short_name';
      const rows = groups.get(name) ?? [];
      groups.set(name, [...rows, row]);
    }
    return [...groups].map(([name, rows]) => ({ name, rows }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  });

  protected readonly timelineNowLeft = computed(() => {
    const timeline = this.timeline();
    const minute = this.feedDayMinute();
    if (minute === undefined || timeline.end <= timeline.start) return undefined;
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
        if (event.type === 'metadata') {
          this.metadata.set(event.metadata);
          this.positionTimelineAtFeedTime();
        }
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
    this.agencyFilter.set('');
    this.routeTypeFilter.set('');
    this.activeTripsOnly.set(false);
    this.groupByRouteShortName.set(false);
    this.expandedRouteShortNames.set(new Set());
    this.selectedId.set(undefined);
    if (view === 'timeline') this.positionTimelineAtFeedTime();
  }
  protected trackById(_index: number, item: TripUpdate): string { return item.id; }
  protected updateSearch(event: Event): void { this.searchTerm.set((event.target as HTMLInputElement).value); }
  protected updateAgency(event: Event): void {
    const agency = (event.target as HTMLSelectElement).value;
    this.agencyFilter.set(agency);
    this.groupByRouteShortName.set(false);
    this.expandedRouteShortNames.set(new Set());
    this.selectedId.set(this.timeline().rows[0]?.item.id);
  }
  protected updateRouteType(event: Event): void {
    this.routeTypeFilter.set((event.target as HTMLSelectElement).value);
    this.selectedId.set(this.timeline().rows[0]?.item.id);
  }
  protected updateRelationship(event: Event): void {
    this.relationshipFilter.set((event.target as HTMLSelectElement).value);
    const first = this.activeView() === 'timeline'
      ? this.timeline().rows[0]?.item
      : this.filteredItems()[0];
    this.selectedId.set(first?.id);
  }
  protected updateActiveTripsOnly(event: Event): void {
    this.activeTripsOnly.set((event.target as HTMLInputElement).checked);
    this.selectedId.set(this.timeline().rows[0]?.item.id);
  }
  protected updateGroupByRouteShortName(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked && this.canGroupByRouteShortName();
    this.groupByRouteShortName.set(checked);
    const firstGroup = this.timelineGroups()[0];
    this.expandedRouteShortNames.set(checked && firstGroup ? new Set([firstGroup.name]) : new Set());
    this.selectedId.set(firstGroup?.rows[0]?.item.id ?? this.timeline().rows[0]?.item.id);
  }
  protected toggleRouteShortName(name: string): void {
    this.expandedRouteShortNames.update((current) => {
      const expanded = new Set(current);
      if (expanded.has(name)) expanded.delete(name);
      else expanded.add(name);
      return expanded;
    });
  }
  protected expandAllRouteShortNames(): void {
    this.expandedRouteShortNames.set(new Set(this.timelineGroups().map((group) => group.name)));
  }
  protected collapseAllRouteShortNames(): void {
    this.expandedRouteShortNames.set(new Set());
  }
  protected toggleFilters(): void { this.filtersExpanded.update((value) => !value); }

  protected delayLabel(seconds?: number): string {
    if (seconds === undefined) return 'No delay data';
    const sign = seconds > 0 ? '+' : '';
    return `${sign}${Math.round(seconds / 60)} min`;
  }

  protected agencyLabel(item: TripUpdate): string {
    return item.agencyName;
  }

  protected agencyDetailLabel(item: TripUpdate): string {
    const organisation = item.dto.businessOrganisation;
    return organisation
      ? `${organisation.abbreviationDe} · ${organisation.descriptionDe}`
      : item.agencyName;
  }

  protected routeTypeLabel(routeType: number): string {
    return extendedRouteTypeLabel(routeType);
  }

  protected gtfsRouteUrl(item: TripUpdate): string {
    return `${APP_URLS.gtfsChRoutes}?route=${encodeURIComponent(item.routeId)}`;
  }

  protected atlasBusinessOrganisationUrl(item: TripUpdate): string {
    const sboid = item.dto.businessOrganisation?.sboid ?? '';
    return `${APP_URLS.atlasBusinessOrganisations}/${encodeURIComponent(sboid)}`;
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
    const wholeMinutes = Math.floor(minutes);
    const dayOffset = Math.floor(wholeMinutes / 1_440);
    const minuteOfDay = ((wholeMinutes % 1_440) + 1_440) % 1_440;
    const hours = Math.floor(minuteOfDay / 60).toString().padStart(2, '0');
    const mins = (minuteOfDay % 60).toString().padStart(2, '0');
    return `${hours}:${mins}${dayOffset ? ` (+${dayOffset}d)` : ''}`;
  }

  private positionTimelineAtFeedTime(): void {
    window.requestAnimationFrame(() => {
      const element = this.timelineScroll()?.nativeElement;
      const nowLeft = this.timelineNowLeft();
      if (!element || nowLeft === undefined) return;
      const leadWidth = TIMELINE_LEAD_MINUTES / TIMELINE_CELL_MINUTES * TIMELINE_CELL_WIDTH;
      element.scrollLeft = Math.max(0, Math.min(nowLeft - leadWidth, element.scrollWidth - element.clientWidth));
    });
  }

  private routeTypeKey(item: TripUpdate): string {
    const routeType = item.dto.route?.route_type;
    return routeType === undefined ? '_no_route_type' : String(routeType);
  }

  private isActiveAtFeedTime(item: TripUpdate): boolean {
    const now = this.feedDayMinute();
    const departure = item.departureDayMinutes;
    const arrival = item.arrivalDayMinutes;
    return now !== undefined && departure !== undefined && arrival !== undefined
      && departure <= now && now <= arrival;
  }
}

function emptyParseState(status: ParseState['status']): ParseState {
  return { status, processed: 0, count: 0, elapsedMs: 0, message: '' };
}
