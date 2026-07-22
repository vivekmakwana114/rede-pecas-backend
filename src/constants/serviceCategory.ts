export const SERVICE_CATEGORIES = ['maintenance', 'general_mechanics', 'diagnostics'] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/**
 * Maps products.subcategory (the catalog CSV's fine-grained taxonomy) down to
 * the 3-bucket services.service_category used to match products to relevant
 * services (see db/schema.sql products/services tables). Case-sensitive on
 * the CSV's subcategory value. Nothing maps to 'diagnostics' today — that
 * bucket is scanner-only work, not tied to a part category.
 */
export const SUBCATEGORY_TO_SERVICE_CATEGORY: Record<string, ServiceCategory> = {
  'Engine Oil': 'maintenance',
  Filtration: 'maintenance',
  Brakes: 'general_mechanics',
  Suspension: 'general_mechanics',
  Steering: 'general_mechanics',
  Transmission: 'general_mechanics',
  Mechanical: 'general_mechanics',
  Engine: 'general_mechanics',
};
