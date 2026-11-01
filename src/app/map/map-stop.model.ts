export interface MapStop {
  readonly sequence?: number;
  readonly longitude?: number;
  readonly latitude?: number;
  readonly name?: string;
  readonly stopId: string;
  readonly arrivalMinute?: number;
  readonly departureMinute?: number;
  readonly isSkipped?: boolean;
}
