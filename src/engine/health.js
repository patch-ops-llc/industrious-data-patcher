// Link health: for every kind of record a rule links, how many records are
// associated in HubSpot with the record their ID matches. Worked out by each
// run from what the rules found, without any extra call to HubSpot.
//
// Rules that link the same two objects (for example a quote to its deal by
// the deal ID, and by the quote number typed on the deal) count as one: a
// record is linked when any of them found it linked.

/** What a rule found for one record, from best to worst. The best one found by any rule counts. */
const RANK = {
  gone: 7,
  linked: 6,
  pending: 5,
  failed: 4,
  held: 3,
  noMatch: 2,
  noKey: 1,
};

export const pairOf = (rule) => `${rule.from}>${rule.to}`;

/** Returns the function a rule uses to record what it found for a record. */
export function outcomeRecorder(outcomes, rule) {
  if (!outcomes) return () => {};
  const key = pairOf(rule);
  if (!outcomes.has(key)) outcomes.set(key, new Map());
  const found = outcomes.get(key);
  return (id, outcome) => {
    const before = found.get(id);
    if (!before || RANK[outcome] > RANK[before]) found.set(id, outcome);
  };
}

/**
 * One entry per pair of objects, in the order of the rules:
 *
 *   records   records of the "from" object in HubSpot
 *   noKey     the ID the match needs is blank on the record
 *   withKey   records - noKey
 *   linked    associated with the record the ID matches
 *   pending   not linked yet: a dry run would have linked it, or a run with a limit did not get to it
 *   failed    HubSpot refused the association
 *   held      held for review (the ID matches more than one record, or the record is linked to another one)
 *   noMatch   the ID matches no record
 *
 * linked + pending + failed + held + noMatch = withKey.
 */
export function linkHealth(mapping, rules, outcomes) {
  const groups = new Map();
  for (const rule of rules) {
    const key = pairOf(rule);
    if (!groups.has(key)) {
      groups.set(key, {
        from: rule.from,
        to: rule.to,
        fromLabel: mapping.objects[rule.from].label || rule.from,
        toLabel: mapping.objects[rule.to].label || rule.to,
        rules: [],
        keys: [],
        records: 0,
        withKey: 0,
        linked: 0,
        pending: 0,
        failed: 0,
        held: 0,
        noMatch: 0,
        noKey: 0,
      });
    }
    const group = groups.get(key);
    group.rules.push(rule.id);
    const matchedOn = rule.match.map((m) => mapping.objects[rule.from].properties[m.from]).join(' + ');
    if (!group.keys.includes(matchedOn)) group.keys.push(matchedOn);
  }
  for (const [key, group] of groups) {
    for (const outcome of (outcomes.get(key) || new Map()).values()) {
      // A record that turned out to be deleted in HubSpot during the run is not a record any more.
      if (outcome === 'gone') continue;
      group.records += 1;
      group[outcome] += 1;
    }
    group.withKey = group.records - group.noKey;
  }
  return [...groups.values()];
}
