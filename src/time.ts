const MOSCOW_TIME_ZONE = 'Europe/Moscow';
const MOSCOW_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOSCOW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function moscowDateKey(now: Date): string {
  const parts = MOSCOW_DATE_FORMATTER.formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${values.year!}-${values.month!}-${values.day!}`;
}

export function nextMoscowMidnight(now: Date): Date {
  const [year, month, day] = moscowDateKey(now).split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1, -3));
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}
