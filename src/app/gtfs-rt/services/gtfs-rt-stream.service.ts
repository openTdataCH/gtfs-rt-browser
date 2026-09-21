import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { FeedMetadataDto, TripUpdateDto } from '../dto';
import { TripUpdate } from '../models';

export type GtfsRtStreamEvent =
  | { type: 'metadata'; metadata: FeedMetadataDto }
  | { type: 'trip-updates'; updates: readonly TripUpdate[]; processed: number }
  | { type: 'complete'; count: number };

type WorkerResponse =
  | { type: 'metadata'; metadata: FeedMetadataDto }
  | { type: 'trip-updates'; updates: TripUpdateDto[]; processed: number }
  | { type: 'complete'; count: number }
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
        } else {
          subscriber.next(data);
          if (data.type === 'complete') subscriber.complete();
        }
      };
      worker.onerror = (event) => subscriber.error(new Error(event.message || 'GTFS-RT parser worker failed.'));
      worker.postMessage({ type: 'parse', url });
      return () => worker.terminate();
    });
  }
}
