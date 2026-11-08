import * as schema from "../../db/schema";

export interface AdminMovie {
  id: string;
  title: string;
  synopsis: string | null;
  durationMinutes: number;
  posterUrl: string | null;
  rating: string | null;
}

export function toAdminMovie(movie: schema.Movie): AdminMovie {
  return {
    id: movie.id,
    title: movie.title,
    synopsis: movie.synopsis,
    durationMinutes: movie.durationMinutes,
    posterUrl: movie.posterUrl,
    rating: movie.rating,
  };
}
