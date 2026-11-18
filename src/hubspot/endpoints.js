const enc = encodeURIComponent;

/**
 * URL paths for the HubSpot APIs the middleware uses.
 *
 * HubSpot moved to date-based API versions in March 2026. A date version such
 * as "2026-09" uses those paths; "legacy" uses the older v3/v4 paths, which
 * HubSpot still serves. Request and response bodies are the same in both.
 */
export function endpoints(version) {
  if (version === 'legacy') {
    const assoc = (from, to) => `/crm/v4/associations/${enc(from)}/${enc(to)}`;
    return {
      search: (type) => `/crm/v3/objects/${enc(type)}/search`,
      batchRead: (type) => `/crm/v3/objects/${enc(type)}/batch/read`,
      batchUpdate: (type) => `/crm/v3/objects/${enc(type)}/batch/update`,
      associationsRead: (from, to) => `${assoc(from, to)}/batch/read`,
      associationsCreate: (from, to) => `${assoc(from, to)}/batch/create`,
      associationsCreateDefault: (from, to) => `${assoc(from, to)}/batch/associate/default`,
      associationsArchive: (from, to) => `${assoc(from, to)}/batch/archive`,
      associationLabels: (from, to) => `${assoc(from, to)}/labels`,
      schemas: () => '/crm/v3/schemas',
      properties: (type) => `/crm/v3/properties/${enc(type)}`,
    };
  }
  const v = enc(version);
  const assoc = (from, to) => `/crm/associations/${v}/${enc(from)}/${enc(to)}`;
  return {
    search: (type) => `/crm/objects/${v}/${enc(type)}/search`,
    batchRead: (type) => `/crm/objects/${v}/${enc(type)}/batch/read`,
    batchUpdate: (type) => `/crm/objects/${v}/${enc(type)}/batch/update`,
    associationsRead: (from, to) => `${assoc(from, to)}/batch/read`,
    associationsCreate: (from, to) => `${assoc(from, to)}/batch/create`,
    associationsCreateDefault: (from, to) => `${assoc(from, to)}/batch/associate/default`,
    associationsArchive: (from, to) => `${assoc(from, to)}/batch/archive`,
    associationLabels: (from, to) => `${assoc(from, to)}/labels`,
    schemas: () => `/crm-object-schemas/${v}/schemas`,
    properties: (type) => `/crm/properties/${v}/${enc(type)}`,
  };
}
