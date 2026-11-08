import * as schema from "../../db/schema";

export interface AdminCinema {
  id: string;
  name: string;
  address: string;
  city: string;
}

export function toAdminCinema(cinema: schema.Cinema): AdminCinema {
  return { id: cinema.id, name: cinema.name, address: cinema.address, city: cinema.city };
}
