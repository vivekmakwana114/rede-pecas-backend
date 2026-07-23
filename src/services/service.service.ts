import * as XLSX from 'xlsx';
import { ApiError } from '../utils/ApiError.js';
import { SERVICE_CATEGORIES } from '../constants/serviceCategory.js';
import { importServicesBatch, ImportServiceItem } from '../models/service.model.js';

export interface ServiceImportResult {
  inserted: number;
  updated: number;
  skipped: { row: number; reasons: string[] }[];
}

// Values a CSV/XLSX author would plausibly type in a yes/no column — same
// set as product.service.ts's YES_VALUES.
const YES_VALUES = new Set(['yes', 'sim', 'true', '1']);

const HEADER_ALIASES: Record<string, string[]> = {
  providerName: ['provider_name', 'provider name', 'fornecedor_servico'],
  providerAddress: ['address', 'endereco'],
  providerProvince: ['province', 'provincia'],
  providerPhone: ['phone', 'telefone'],
  specialties: ['specialties', 'especialidades'],
  rating: ['rating', 'avaliacao'],
  responseTime: ['response_time', 'response time', 'tempo_resposta'],
  serviceName: ['service_name', 'service name', 'nome_servico'],
  serviceCategory: ['service_category', 'service category', 'categoria_servico'],
  serviceBasePrice: ['service_base_price', 'service base price', 'preco_base_servico'],
  serviceDurationH: ['service_duration_h', 'service duration h', 'duracao_servico_h'],
  availableAtHome: ['available_at_home', 'available at home', 'disponivel_domicilio'],
  baseTravelFee: ['base_travel_fee', 'base travel fee', 'taxa_deslocacao'],
  logisticsFeeNotes: ['logistics_fee_notes', 'logistics fee notes', 'notas_taxa_logistica'],
};

const REQUIRED_COLUMNS: { field: keyof typeof HEADER_ALIASES; label: string }[] = [
  { field: 'providerName', label: 'Provider Name' },
  { field: 'serviceName', label: 'Service Name' },
  { field: 'serviceCategory', label: 'Service Category' },
  { field: 'serviceBasePrice', label: 'Service Base Price' },
  { field: 'serviceDurationH', label: 'Service Duration H' },
];

function getMissingRequiredColumns(headerRow: unknown[]): string[] {
  const headerSet = new Set(headerRow.map((h) => String(h ?? '').trim().toLowerCase()));
  return REQUIRED_COLUMNS.filter(({ field }) => !HEADER_ALIASES[field].some((alias) => headerSet.has(alias))).map(
    ({ label }) => label
  );
}

/**
 * Validates one spreadsheet row and either returns the item ready to import
 * or the reasons this row is being skipped — same skip-not-reject contract
 * as validateRow in product.service.ts (a bad row doesn't block the rest of
 * the file).
 */
function validateServiceRow(row: Record<string, any>, rowNumber: number): { item: ImportServiceItem } | { reasons: string[] } {
  const lowerRow = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const pick = (field: string) => {
    for (const alias of HEADER_ALIASES[field]) {
      if (lowerRow[alias] !== undefined && lowerRow[alias] !== '') return lowerRow[alias];
    }
    return undefined;
  };
  const pickStr = (field: string) => {
    const v = pick(field);
    return v !== undefined ? String(v) : undefined;
  };

  const reasons: string[] = [];

  const providerName = pick('providerName');
  if (!providerName) reasons.push('Provider Name is required.');

  const serviceName = pick('serviceName');
  if (!serviceName) reasons.push('Service Name is required.');

  const serviceCategory = pick('serviceCategory');
  if (!serviceCategory) reasons.push('Service Category is required.');
  else if (!SERVICE_CATEGORIES.includes(String(serviceCategory) as any)) {
    reasons.push(`Unknown Service Category "${serviceCategory}" — must be one of ${SERVICE_CATEGORIES.join(', ')}.`);
  }

  const priceRaw = pick('serviceBasePrice');
  const price = Number(priceRaw);
  if (priceRaw === undefined || Number.isNaN(price) || price < 0) {
    reasons.push('Service Base Price is required and must be a non-negative number.');
  }

  const durationRaw = pick('serviceDurationH');
  const duration = Number(durationRaw);
  if (durationRaw === undefined || Number.isNaN(duration) || duration < 0) {
    reasons.push('Service Duration H is required and must be a non-negative number.');
  }

  const availableAtHome = YES_VALUES.has(String(pick('availableAtHome') ?? '').trim().toLowerCase());

  const ratingRaw = pick('rating');
  const rating = ratingRaw !== undefined ? Number(ratingRaw) : undefined;

  const travelFeeRaw = pick('baseTravelFee');
  const baseTravelFee = travelFeeRaw !== undefined ? Number(travelFeeRaw) : undefined;

  if (reasons.length) return { reasons: reasons.map((r) => `Row ${rowNumber}: ${r}`) };

  return {
    item: {
      providerName: String(providerName),
      providerAddress: pickStr('providerAddress'),
      providerProvince: pickStr('providerProvince'),
      providerPhone: pickStr('providerPhone'),
      specialties: pickStr('specialties'),
      rating: rating !== undefined && !Number.isNaN(rating) ? rating : undefined,
      responseTime: pickStr('responseTime'),
      serviceName: String(serviceName),
      serviceCategory: String(serviceCategory),
      serviceBasePrice: price,
      serviceDurationH: duration,
      availableAtHome,
      baseTravelFee: baseTravelFee !== undefined && !Number.isNaN(baseTravelFee) ? baseTravelFee : undefined,
      logisticsFeeNotes: pickStr('logisticsFeeNotes'),
    },
  };
}

/**
 * Parses a single uploaded CSV/XLSX services file and imports every valid
 * row, mirroring importInventoryFromFile in product.service.ts — a missing
 * header column rejects the whole file, but a row-level problem only skips
 * that row (reported in `skipped`).
 */
export async function importServicesFromFile(fileBuffer: Buffer): Promise<ServiceImportResult> {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  const headerRow = (XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })[0] as unknown[] | undefined) ?? [];
  const missingColumns = getMissingRequiredColumns(headerRow);
  if (missingColumns.length) {
    throw new ApiError(400, `Missing required column(s): ${missingColumns.join(', ')}.`);
  }

  const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet);
  if (!rawRows.length) {
    throw new ApiError(400, 'The file has no data rows.');
  }

  const items: ImportServiceItem[] = [];
  const skipped: { row: number; reasons: string[] }[] = [];
  rawRows.forEach((row, i) => {
    const rowNumber = i + 2;
    const result = validateServiceRow(row, rowNumber);
    if ('reasons' in result) skipped.push({ row: rowNumber, reasons: result.reasons });
    else items.push(result.item);
  });

  const { inserted, updated } = await importServicesBatch(items, null);
  return { inserted, updated, skipped };
}

const TEMPLATE_HEADER_ROW = [
  'Provider Name',
  'Address',
  'Province',
  'Phone',
  'Specialties',
  'Rating',
  'Response Time',
  'Service Name',
  'Service Category',
  'Service Base Price',
  'Service Duration H',
  'Available At Home',
  'Base Travel Fee',
  'Logistics Fee Notes',
];

/**
 * Builds a blank XLSX workbook containing only the header row expected by
 * importServicesFromFile — mirrors generateInventoryTemplateFile in
 * product.service.ts.
 */
export function generateServicesTemplateFile(): Buffer {
  const worksheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADER_ROW]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Services');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
