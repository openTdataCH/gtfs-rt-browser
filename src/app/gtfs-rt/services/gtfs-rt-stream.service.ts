import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { StopJSON } from '../../gtfs-static/dto';
import { FeedMetadataDto, TripTimelineUpdateDto, TripUpdateDto } from '../dto';
import { TripUpdate } from '../models';

export type GtfsRtStreamEvent =
  | { type: 'metadata'; metadata: FeedMetadataDto }
  | { type: 'trip-updates'; updates: readonly TripUpdate[]; processed: number }
  | { type: 'trip-timelines'; updates: readonly TripTimelineUpdateDto[] }
  | { type: 'static-agency-trip-counts'; countsByAgency: ReadonlyMap<string, number> }
  | { type: 'trip-timelines-error'; message: string }
  | { type: 'complete'; count: number }
  | { type: 'stops-lookup'; stopsById: ReadonlyMap<string, StopJSON> }
  | { type: 'stops-error'; message: string };

type WorkerResponse =
  | { type: 'metadata'; metadata: FeedMetadataDto }
  | { type: 'trip-updates'; updates: TripUpdateDto[]; processed: number }
  | { type: 'trip-timelines'; updates: TripTimelineUpdateDto[] }
  | { type: 'static-agency-trip-counts'; countsByAgency: Map<string, number> }
  | { type: 'trip-timelines-error'; message: string }
  | { type: 'complete'; count: number }
  | { type: 'stops-lookup'; stopsById: Map<string, StopJSON> }
  | { type: 'stops-error'; message: string }
  | { type: 'worker-done' }
  | { type: 'error'; message: string };

@Injectable({ providedIn: 'root' })
export class GtfsRtStreamService {
  public streamTripUpdates(url: string): Observable<GtfsRtStreamEvent> {
    return new Observable((subscriber) => {
      const worker = new Worker(new URL('../workers/gtfs-rt-parser.worker', import.meta.url), { type: 'module' });

      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (data.type === 'error') {
          subscriber.error(new Error(data.message));
        } else if (data.type === 'trip-updates') {
          subscriber.next({ ...data, updates: data.updates.map((dto) => new TripUpdate(dto)) });
        } else if (data.type === 'worker-done') {
          subscriber.complete();
        } else {
          subscriber.next(data);
        }
      };
      worker.onerror = (event) => subscriber.error(new Error(event.message || 'GTFS-RT parser worker failed.'));
      worker.postMessage({ type: 'parse', url });
      return () => worker.terminate();
    });
  }
}
