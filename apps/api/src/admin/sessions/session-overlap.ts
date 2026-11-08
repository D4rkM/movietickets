const MS_PER_MINUTE = 60 * 1000;

export interface TimeInterval {
  start: Date;
  end: Date;
}

/** A session occupies its room during `[startsAt, startsAt + duration)`. */
export function sessionInterval(startsAt: Date, durationMinutes: number): TimeInterval {
  return { start: startsAt, end: new Date(startsAt.getTime() + durationMinutes * MS_PER_MINUTE) };
}

/**
 * Half-open intervals overlap when each starts before the other ends. A
 * session starting exactly when another ends does not overlap it (no cleaning
 * gap between sessions in this version).
 */
export function intervalsOverlap(a: TimeInterval, b: TimeInterval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}
