import { StopTimeEventDto, StopTimeUpdateDto, TripUpdateDto } from '../dto';

export class StopTimeUpdate {
  public readonly effectiveTime?: Date;
  public readonly effectiveDelay?: number;

  public constructor(public readonly dto: StopTimeUpdateDto) {
    const event = dto.departure ?? dto.arrival;
    this.effectiveTime = epochDate(event);
    this.effectiveDelay = event?.delay;
  }

  public get stopId(): string { return this.dto.stopId || this.dto.assignedStopId || '—'; }
  public get relationship(): string { return this.dto.scheduleRelationship; }
  public get isSkipped(): boolean { return this.relationship === 'SKIPPED'; }
}

export class TripUpdate {
  public readonly stops: readonly StopTimeUpdate[];
  public readonly updatedAt?: Date;
  public readonly minDelay?: number;
  public readonly maxDelay?: number;

  public constructor(public readonly dto: TripUpdateDto) {
    this.stops = dto.stopTimeUpdates.map((stop) => new StopTimeUpdate(stop));
    this.updatedAt = dto.timestamp === undefined ? undefined : new Date(dto.timestamp * 1000);
    const delays = [dto.delay, ...this.stops.map((stop) => stop.effectiveDelay)]
      .filter((delay): delay is number => delay !== undefined);
    this.minDelay = delays.length ? Math.min(...delays) : undefined;
    this.maxDelay = delays.length ? Math.max(...delays) : undefined;
  }

  public get id(): string { return this.dto.entityId; }
  public get tripId(): string { return this.dto.trip.tripId || '—'; }
  public get routeId(): string { return this.dto.trip.routeId || '—'; }
  public get hasRouteId(): boolean { return Boolean(this.dto.trip.routeId); }
  public get agencyId(): string { return this.dto.agencyId || 'No_Agency'; }
  public get agencyName(): string { return this.dto.agency?.agency_name || this.agencyId; }
  public get vehicleLabel(): string { return this.dto.vehicle?.label || this.dto.vehicle?.id || '—'; }
  public get relationship(): string { return this.dto.trip.scheduleRelationship; }
  public get cancelled(): boolean { return this.relationship === 'CANCELED'; }
  public get skippedStopCount(): number { return this.stops.filter((stop) => stop.isSkipped).length; }

  public matches(query: string): boolean {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return true;
    return [this.id, this.tripId, this.routeId, this.vehicleLabel, this.agencyId, this.agencyName,
      ...this.stops.map((stop) => stop.stopId)]
      .some((value) => value.toLocaleLowerCase().includes(normalized));
  }
}

function epochDate(event?: StopTimeEventDto): Date | undefined {
  return event?.time === undefined ? undefined : new Date(event.time * 1000);
}
