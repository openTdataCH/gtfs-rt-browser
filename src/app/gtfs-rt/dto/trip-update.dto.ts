import type { AgencyJSON } from '../../gtfs-static/dto';

export interface TripUpdateDto {
  readonly entityId: string;
  readonly trip: TripDescriptorDto;
  readonly vehicle?: VehicleDescriptorDto;
  readonly stopTimeUpdates: readonly StopTimeUpdateDto[];
  readonly timestamp?: number;
  readonly delay?: number;
  readonly agencyId?: string;
  readonly agency?: AgencyJSON;
  readonly businessOrganisation?: BusinessOrganisationDto;
  readonly timeline?: TripTimelineDto;
  readonly timelineError?: string;
}

export interface TripTimelineDto {
  readonly departureDayMinutes: number;
  readonly arrivalDayMinutes: number;
}

export interface BusinessOrganisationDto {
  readonly organisationNumber: string;
  readonly descriptionDe: string;
  readonly abbreviationDe: string;
}

export interface TripDescriptorDto {
  readonly tripId?: string;
  readonly routeId?: string;
  readonly directionId?: number;
  readonly startTime?: string;
  readonly startDate?: string;
  readonly scheduleRelationship: TripScheduleRelationship;
}

export interface VehicleDescriptorDto {
  readonly id?: string;
  readonly label?: string;
  readonly licensePlate?: string;
}

export interface StopTimeUpdateDto {
  readonly stopSequence?: number;
  readonly stopId?: string;
  readonly arrival?: StopTimeEventDto;
  readonly departure?: StopTimeEventDto;
  readonly scheduleRelationship: StopScheduleRelationship;
  readonly assignedStopId?: string;
}

export interface StopTimeEventDto {
  readonly delay?: number;
  readonly time?: number;
  readonly uncertainty?: number;
}

export type TripScheduleRelationship =
  | 'SCHEDULED' | 'ADDED' | 'UNSCHEDULED' | 'CANCELED'
  | 'REPLACEMENT' | 'DUPLICATED' | 'UNKNOWN';

export type StopScheduleRelationship =
  | 'SCHEDULED' | 'SKIPPED' | 'NO_DATA' | 'UNSCHEDULED' | 'UNKNOWN';

export interface FeedMetadataDto {
  readonly feedVersion: string;
  readonly feedDay: string;
  readonly gtfsRealtimeVersion: string;
  readonly incrementality: 'FULL_DATASET' | 'DIFFERENTIAL' | 'UNKNOWN';
  readonly timestamp: number;
  readonly entityCount: number;
  readonly tripUpdateCount: number;
}
