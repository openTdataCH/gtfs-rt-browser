export type BusinessOrganisationStatus = 'VALIDATED' | 'IN_REVIEW' | 'REVOKED' | (string & {});

export interface BusinessOrganisationCsvRecord {
  sboid: string;
  said: string;
  validFrom: string;
  validTo: string;
  organisationNumber: string;
  status: string;
  descriptionDe: string;
  descriptionFr: string;
  descriptionIt: string;
  descriptionEn: string;
  abbreviationDe: string;
  abbreviationFr: string;
  abbreviationIt: string;
  abbreviationEn: string;
  businessTypesId: string;
  businessTypesDe: string;
  businessTypesIt: string;
  businessTypesFr: string;
  transportCompanyNumber: string;
  transportCompanyAbbreviation: string;
  transportCompanyBusinessRegisterName: string;
  creationTime: string;
  editionTime: string;
}

export class BusinessOrganisation {
  private constructor(
    public readonly sboid: string,
    public readonly said: number,
    public readonly validFrom: Date,
    public readonly validTo: Date,
    public readonly organisationNumber: number,
    public readonly status: BusinessOrganisationStatus,
    public readonly descriptionDe: string,
    public readonly abbreviationDe: string
  ) {}

  public static initFromCsvRecord(record: BusinessOrganisationCsvRecord): BusinessOrganisation {
    return new BusinessOrganisation(
      required(record.sboid, 'sboid'),
      integer(record.said, 'said'),
      date(record.validFrom, 'validFrom'),
      date(record.validTo, 'validTo'),
      integer(record.organisationNumber, 'organisationNumber'),
      required(record.status, 'status'),
      record.descriptionDe,
      record.abbreviationDe
    );
  }
}

function required(value: string, field: string): string {
  if (!value) throw new Error(`BusinessOrganisation.${field} is required.`);
  return value;
}

function integer(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`BusinessOrganisation.${field} must be an integer.`);
  return parsed;
}

function date(value: string, field: string): Date {
  const normalized = value.includes(' ') && !value.includes('T') ? value.replace(' ', 'T') : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new Error(`BusinessOrganisation.${field} must be a date.`);
  return parsed;
}
