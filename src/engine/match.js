/**
 * Matching on the Epicor IDs, done in the staging database.
 *
 * For one rule this returns a row per source record with:
 *   id          HubSpot ID of the source record
 *   raw         the raw key values on the source (for reports)
 *   missingKey  true when any part of the key is blank
 *   targetIds   HubSpot IDs of the records whose key equals the source's key
 *   knownIds    records of the target type the source is associated to,
 *               as last read from HubSpot (staging_associations)
 *
 * Keys are compared after trimming and, by default, ignoring case. Values
 * listed under keyNormalization.treatAsBlank count as blank.
 */
export async function matchRule(db, mapping, rule) {
  const fromObj = mapping.objects[rule.from];
  const toObj = mapping.objects[rule.to];
  const norm = mapping.keyNormalization;
  const params = [];
  const p = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const blank = p(JSON.stringify(norm.treatAsBlank || []));
  const keyExpr = (propertyName) => {
    const raw = `btrim(properties->>${p(propertyName)}, E' \\t\\r\\n\\u00a0')`;
    const value = norm.caseInsensitive === false ? raw : `lower(${raw})`;
    return `CASE WHEN ${raw} IS NULL OR ${raw} = '' OR lower(${raw}) IN (SELECT jsonb_array_elements_text(${blank}::jsonb)) THEN NULL ELSE ${value} END`;
  };

  const n = rule.match.length;
  const fromProps = rule.match.map((m) => fromObj.properties[m.from]);
  const toProps = rule.match.map((m) => toObj.properties[m.to]);
  const cols = (props) => props.map((name, i) => `${keyExpr(name)} AS k${i}`).join(', ');
  const rawCols = fromProps.map((name) => `properties->>${p(name)}`).join(', ');
  const live = 'hubspot_id IS NOT NULL AND missing_since IS NULL';
  const join = Array.from({ length: n }, (_, i) => `s.k${i} = t.k${i}`).join(' AND ');
  const anyBlank = Array.from({ length: n }, (_, i) => `s.k${i} IS NULL`).join(' OR ');

  const sql = `
    WITH src AS MATERIALIZED (
      SELECT hubspot_id, ARRAY[${rawCols}] AS raw, ${cols(fromProps)}
      FROM staging_records WHERE object_key = ${p(rule.from)} AND ${live}
    ),
    tgt AS MATERIALIZED (
      SELECT hubspot_id, ${cols(toProps)}
      FROM staging_records WHERE object_key = ${p(rule.to)} AND ${live}
    ),
    matched AS (
      SELECT s.hubspot_id, array_agg(t.hubspot_id ORDER BY length(t.hubspot_id), t.hubspot_id) AS target_ids
      FROM src s JOIN tgt t ON ${join}
      GROUP BY s.hubspot_id
    ),
    known AS (
      SELECT from_id, array_agg(to_id) AS to_ids
      FROM staging_associations
      WHERE from_object_type = ${p(fromObj.objectType)} AND to_object_type = ${p(toObj.objectType)}
      GROUP BY from_id
    )
    SELECT s.hubspot_id AS id, s.raw, (${anyBlank}) AS missing_key,
           COALESCE(m.target_ids, ARRAY[]::text[]) AS target_ids,
           COALESCE(k.to_ids, ARRAY[]::text[]) AS known_ids
    FROM src s
    LEFT JOIN matched m ON m.hubspot_id = s.hubspot_id
    LEFT JOIN known k ON k.from_id = s.hubspot_id
    ORDER BY length(s.hubspot_id), s.hubspot_id`;

  const { rows } = await db.query(sql, params);
  return rows.map((row) => ({
    id: row.id,
    raw: row.raw,
    missingKey: row.missing_key,
    targetIds: row.target_ids,
    knownIds: row.known_ids,
  }));
}

export function describeRawKey(propertyNames, raw) {
  return propertyNames.map((name, i) => `${name}=${raw?.[i] ?? ''}`).join(', ');
}
