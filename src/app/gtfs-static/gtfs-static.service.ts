import { Injectable } from '@angular/core';
import { APP_URLS } from '../config';
import { TripDetailResponseJSON } from './dto';

@Injectable({ providedIn: 'root' })
export class GtfsStaticService {
  private readonly tripRequests = new Map<string, Promise<TripDetailResponseJSON>>();

  public loadTrip(gtfsDay: string, tripId: string): Promise<TripDetailResponseJSON> {
    const key = `${gtfsDay}|${tripId}`;
    const cached = this.tripRequests.get(key);
    if (cached) return cached;

    const request = this.fetchTrip(tripId).catch((error: unknown) => {
      this.tripRequests.delete(key);
      throw error;
    });
    this.tripRequests.set(key, request);
    return request;
  }

  private async fetchTrip(tripId: string): Promise<TripDetailResponseJSON> {
    const url = `${APP_URLS.gtfsTrip}/${encodeURIComponent(tripId)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GTFS trip request failed: ${response.status} ${response.statusText}`);
    }
    const json: unknown = await response.json();
    if (!isTripDetailResponse(json)) {
      throw new Error('GTFS trip response does not contain a valid result.trip.');
    }
    return json;
  }
}

function isTripDetailResponse(value: unknown): value is TripDetailResponseJSON {
  if (!isRecord(value) || !isRecord(value['result'])) return false;
  const trip = value['result']['trip'];
  return trip === null || (isRecord(trip)
    && typeof trip['trip_id'] === 'string'
    && typeof trip['stop_times_s'] === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
