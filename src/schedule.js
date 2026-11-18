import { getScheduleSettings } from './db/store.js';

/**
 * The schedule of the service's runs.
 *
 * Until it is changed on the admin page the schedule is on and its interval
 * is the RUN_INTERVAL_MINUTES service variable. Once it has been saved on the
 * page, the staging database holds it and the variable no longer applies.
 *
 * The page offers a fixed list of intervals. There is no free-form schedule.
 */
export const INTERVAL_CHOICES = [15, 30, 60, 120, 240, 360, 720, 1440];

export function intervalLabel(minutes) {
  if (minutes === 1440) return 'Once a day';
  if (minutes === 60) return 'Every hour';
  if (minutes === 1) return 'Every minute';
  if (minutes > 60 && minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** The intervals that can be chosen: the fixed list, plus the variable's value when it is not on the list. */
export function intervalChoices(settings) {
  const fromVariable = settings.runIntervalMinutes;
  return INTERVAL_CHOICES.includes(fromVariable) ? [...INTERVAL_CHOICES] : [...INTERVAL_CHOICES, fromVariable].sort((a, b) => a - b);
}

/** { enabled, intervalMinutes, source: 'page' | 'variable', updatedAt } */
export async function effectiveSchedule(db, settings) {
  const saved = await getScheduleSettings(db);
  if (saved) return { enabled: saved.enabled, intervalMinutes: saved.intervalMinutes, source: 'page', updatedAt: saved.updatedAt };
  return { enabled: true, intervalMinutes: settings.runIntervalMinutes, source: 'variable', updatedAt: null };
}
