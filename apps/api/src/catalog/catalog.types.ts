export interface CatalogSession {
  id: string;
  startsAt: string;
  priceCents: number;
  room: { id: string; name: string };
  cinema: { id: string; name: string; city: string };
}

export interface CatalogMovie {
  id: string;
  title: string;
  synopsis: string | null;
  durationMinutes: number;
  posterUrl: string | null;
  rating: string | null;
  sessions: CatalogSession[];
}
