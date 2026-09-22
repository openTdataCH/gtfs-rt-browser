import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_URLS } from '../config';
import { BusinessOrganisation, BusinessOrganisationCsvRecord } from './business-organisation.model';

const CSV_FIELDS: readonly (keyof BusinessOrganisationCsvRecord)[] = [
  'sboid', 'said', 'validFrom', 'validTo', 'organisationNumber', 'status',
  'descriptionDe', 'descriptionFr', 'descriptionIt', 'descriptionEn',
  'abbreviationDe', 'abbreviationFr', 'abbreviationIt', 'abbreviationEn',
  'businessTypesId', 'businessTypesDe', 'businessTypesIt', 'businessTypesFr',
  'transportCompanyNumber', 'transportCompanyAbbreviation',
  'transportCompanyBusinessRegisterName', 'creationTime', 'editionTime'
];

@Injectable({ providedIn: 'root' })
export class BusinessOrganisationService {
  private readonly http = inject(HttpClient);
  private readonly organisationsState = signal<readonly BusinessOrganisation[]>([]);
  private readonly errorState = signal<string | undefined>(undefined);
  private loadPromise?: Promise<void>;

  public readonly organisations = this.organisationsState.asReadonly();
  public readonly error = this.errorState.asReadonly();
  public readonly byOrganisationNumber = computed(() => new Map(
    this.organisationsState().map((organisation) => [String(organisation.organisationNumber), organisation])
  ));

  public load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.errorState.set(undefined);
    this.loadPromise = firstValueFrom(this.http.get(APP_URLS.businessOrganisations, { responseType: 'text' }))
      .then((csv) => this.organisationsState.set(parseBusinessOrganisations(csv)))
      .catch((error: unknown) => {
        this.errorState.set(error instanceof Error ? error.message : 'Unable to load business organisations.');
      });
    return this.loadPromise;
  }

  public displayName(agencyId: string, fallback: string): string {
    const organisation = this.byOrganisationNumber().get(agencyId);
    if (!organisation) return fallback;
    return `${organisation.descriptionDe} · ${organisation.abbreviationDe}`;
  }
}

export function parseBusinessOrganisations(csv: string): readonly BusinessOrganisation[] {
  const rows = parseDelimited(csv.replace(/^\uFEFF/, ''), ';');
  const header = rows.shift();
  if (!header || header.join(';') !== CSV_FIELDS.join(';')) {
    throw new Error('Unexpected business-organisation CSV header.');
  }
  return rows.filter((row) => row.some(Boolean)).map((row, rowIndex) => {
    if (row.length !== CSV_FIELDS.length) {
      throw new Error(`Business-organisation CSV row ${rowIndex + 2} has ${row.length} columns; expected ${CSV_FIELDS.length}.`);
    }
    const record = Object.fromEntries(CSV_FIELDS.map((field, index) => [field, row[index]]))
      as unknown as BusinessOrganisationCsvRecord;
    return BusinessOrganisation.initFromCsvRecord(record);
  });
}

function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('Business-organisation CSV contains an unterminated quoted field.');
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
