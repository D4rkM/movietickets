import { useEffect, useState } from "react";
import { getSeatMap } from "./api";
import type { SeatMapResponse, SeatMapSeat, SeatState } from "./types";

interface SeatMapProps {
  sessionId: string;
  accessToken: string;
  selectedSeatIds?: string[];
  onToggleSeat?: (seat: SeatMapSeat) => void;
}

const STATUS_LABEL: Record<SeatState, string> = {
  free: "Disponível",
  held_by_other: "Bloqueado",
  held_by_me: "Selecionado",
  booked: "Reservado",
};

const STATUS_CLASSES: Record<SeatState, string> = {
  free: "bg-green-500 text-white",
  held_by_other: "bg-gray-400 text-white",
  held_by_me: "bg-red-800 text-white",
  booked: "bg-gray-200 text-gray-400",
};

const SELECTED_CLASSES = "bg-red-800 text-white";

const SEAT_SIZE_PX = 32;
const SEAT_GAP_PX = 8;
const SIDE_BLOCK_SIZE = 4;
const AISLE_MIN_ROW_SIZE = SIDE_BLOCK_SIZE * 2 + 8;
// Aisle width = 2 seats + 3 gaps, so seat 5 of an aisled row lines up with seat 7
// of the back row (no aisle) — see splitIntoBlocks.spec.ts for the worked example.
const AISLE_WIDTH_PX = 2 * SEAT_SIZE_PX + 3 * SEAT_GAP_PX;
const SIDE_BLOCK_WIDTH_PX = SIDE_BLOCK_SIZE * SEAT_SIZE_PX + (SIDE_BLOCK_SIZE - 1) * SEAT_GAP_PX;
// Front rows with no side seats (e.g. rows A-C) have only the middle block's worth
// of seats. The blank gap flanking them must span a full side block PLUS its aisle
// (not just the aisle) so seat 1 of these rows lines up with seat 5 of a full row.
const SIDE_GAP_WITH_AISLE_PX = SIDE_BLOCK_WIDTH_PX + AISLE_WIDTH_PX;
const MIDDLE_ONLY_ROW_SIZE = 20;

function groupByRow(seats: SeatMapSeat[]): [string, SeatMapSeat[]][] {
  const rows = new Map<string, SeatMapSeat[]>();
  for (const seat of seats) {
    const row = rows.get(seat.rowLabel) ?? [];
    row.push(seat);
    rows.set(seat.rowLabel, row);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.seatNumber - b.seatNumber);
  }
  // Back rows (further from the screen) render on top, row "A" sits right above the screen.
  return [...rows.entries()].sort(([a], [b]) => b.localeCompare(a));
}

/** Splits a row into left/middle/right seat blocks so an aisle can render between them. */
export function splitIntoBlocks(seats: SeatMapSeat[]): SeatMapSeat[][] {
  if (seats.length < AISLE_MIN_ROW_SIZE) {
    return [seats];
  }
  return [
    seats.slice(0, SIDE_BLOCK_SIZE),
    seats.slice(SIDE_BLOCK_SIZE, -SIDE_BLOCK_SIZE),
    seats.slice(-SIDE_BLOCK_SIZE),
  ];
}

export type RowSegment = { seats: SeatMapSeat[] } | { gapPx: number };

/** Turns a row's seats into seat/gap segments to render, given its shape. */
export function buildRowSegments(seats: SeatMapSeat[], isBackRow: boolean): RowSegment[] {
  if (isBackRow) {
    return [{ seats }];
  }
  if (seats.length === MIDDLE_ONLY_ROW_SIZE) {
    return [{ gapPx: SIDE_GAP_WITH_AISLE_PX }, { seats }, { gapPx: SIDE_GAP_WITH_AISLE_PX }];
  }
  const blocks = splitIntoBlocks(seats);
  return blocks.flatMap((block, index) =>
    index === 0 ? [{ seats: block }] : [{ gapPx: AISLE_WIDTH_PX }, { seats: block }],
  );
}

export function SeatMap({ sessionId, accessToken, selectedSeatIds, onToggleSeat }: SeatMapProps) {
  const [seatMap, setSeatMap] = useState<SeatMapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getSeatMap(sessionId, accessToken)
      .then((data) => {
        if (!cancelled) {
          setSeatMap(data);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, accessToken]);

  if (error) {
    return (
      <p role="alert" className="text-red-600">
        Não foi possível carregar o mapa de assentos: {error}
      </p>
    );
  }

  if (!seatMap) {
    return <p>Carregando mapa de assentos…</p>;
  }

  const rows = groupByRow(seatMap.seats);
  // The back row (rendered first, furthest from the screen) has no aisle: seats run edge to edge.
  const backRowLabel = rows[0]?.[0];

  function renderSeat(seat: SeatMapSeat) {
    const isSelected = selectedSeatIds?.includes(seat.id) ?? false;
    const clickable = onToggleSeat != null && (seat.status === "free" || isSelected);
    return (
      <button
        key={seat.id}
        type="button"
        disabled={!clickable}
        onClick={() => onToggleSeat?.(seat)}
        title={`${seat.rowLabel}${seat.seatNumber} — ${
          isSelected ? "Selecionado" : STATUS_LABEL[seat.status]
        }`}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] ${
          clickable ? "cursor-pointer" : "cursor-not-allowed"
        } ${isSelected ? SELECTED_CLASSES : STATUS_CLASSES[seat.status]}`}
      >
        {seat.seatNumber}
      </button>
    );
  }

  return (
    <div>
      <p className="mb-4 font-semibold">Preço: R$ {(seatMap.priceCents / 100).toFixed(2)}</p>

      <div className="overflow-x-auto">
        <div className="mx-auto w-fit rounded border border-gray-200 bg-gray-50 p-6">
          <div className="flex flex-col gap-2">
            {rows.map(([rowLabel, seats]) => {
              const segments = buildRowSegments(seats, rowLabel === backRowLabel);
              return (
                <div key={rowLabel} className="flex items-center gap-3">
                  <span className="w-5 shrink-0 text-center text-xs font-medium text-gray-500">
                    {rowLabel}
                  </span>
                  <div className="flex items-center">
                    {segments.map((segment, index) =>
                      "gapPx" in segment ? (
                        <div key={index} className="shrink-0" style={{ width: segment.gapPx }} />
                      ) : (
                        <div key={index} className="flex gap-2">
                          {segment.seats.map(renderSeat)}
                        </div>
                      ),
                    )}
                  </div>
                  <span className="w-5 shrink-0 text-center text-xs font-medium text-gray-500">
                    {rowLabel}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-12 rounded bg-indigo-600 py-2 text-center text-sm font-medium tracking-widest text-white">
            TELA
          </div>
        </div>
      </div>

      <ul className="mt-4 flex flex-wrap gap-4 text-sm">
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-green-500" /> Disponível
        </li>
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-red-800" /> Selecionado
        </li>
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-gray-200" /> Reservado
        </li>
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-gray-400" /> Bloqueado
        </li>
      </ul>
    </div>
  );
}
