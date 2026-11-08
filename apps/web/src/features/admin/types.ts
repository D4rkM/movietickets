export const MOVIE_RATINGS = ["L", "10", "12", "14", "16", "18"] as const;
export type MovieRating = (typeof MOVIE_RATINGS)[number];

export interface AdminMovie {
  id: string;
  title: string;
  synopsis: string | null;
  durationMinutes: number;
  posterUrl: string | null;
  rating: string | null;
}

export interface CreateMovieInput {
  title: string;
  synopsis?: string | null;
  durationMinutes: number;
  posterUrl?: string | null;
  rating?: string | null;
}

export type UpdateMovieInput = Partial<CreateMovieInput>;

export interface AdminCinema {
  id: string;
  name: string;
  address: string;
  city: string;
}

export interface CreateCinemaInput {
  name: string;
  address: string;
  city: string;
}

export type UpdateCinemaInput = Partial<CreateCinemaInput>;

export interface AdminRoom {
  id: string;
  name: string;
  rows: number;
  seatsPerRow: number;
  cinemaId: string;
  cinemaName: string;
}

export interface CreateRoomInput {
  cinemaId: string;
  name: string;
  rows: number;
  seatsPerRow: number;
}

export interface UpdateRoomInput {
  name?: string;
  rows?: number;
  seatsPerRow?: number;
}

export interface AdminSession {
  id: string;
  startsAt: string;
  endsAt: string;
  priceCents: number;
  movie: { id: string; title: string; durationMinutes: number };
  room: { id: string; name: string };
  cinema: { id: string; name: string };
}

export interface CreateSessionInput {
  movieId: string;
  roomId: string;
  startsAt: string;
  priceCents: number;
}

export type UpdateSessionInput = Partial<CreateSessionInput>;
