export const SERVICE_CATEGORIES = ['maintenance', 'general_mechanics', 'diagnostics'] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

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
