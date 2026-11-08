export interface AdminSession {
  id: string;
  /** ISO 8601, UTC. */
  startsAt: string;
  /** `startsAt + movie.durationMinutes`, ISO 8601, UTC. */
  endsAt: string;
  priceCents: number;
  movie: { id: string; title: string; durationMinutes: number };
  room: { id: string; name: string };
  cinema: { id: string; name: string };
}
