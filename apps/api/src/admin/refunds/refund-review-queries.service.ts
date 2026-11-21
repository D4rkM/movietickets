import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../../db/drizzle.module";
import * as schema from "../../db/schema";
import { STALE_REQUESTED_REFUND_MINUTES } from "../../refund/refund-status";
import { RefundReviewItem } from "./admin-refund.types";
import { buildRefundReviewItem } from "./refund-review";

@Injectable()
export class RefundReviewQueriesService {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

  /**
   * `GET /admin/refunds/review`: bookings flagged with `needs_refund_review`
   * or with a `requested` refund stalled for more than 2 minutes (DB clock),
   * most recently created first. No pagination (low expected volume).
   */
  async listReviewQueue(): Promise<RefundReviewItem[]> {
    const staleRefunds = await this.db
      .select({ id: schema.refunds.id, bookingId: schema.refunds.bookingId })
      .from(schema.refunds)
      .where(
        and(
          eq(schema.refunds.status, "requested"),
          sql`${schema.refunds.updatedAt} <= now() - make_interval(mins => ${STALE_REQUESTED_REFUND_MINUTES})`,
        ),
      );
    const staleBookingIds = [...new Set(staleRefunds.map((refund) => refund.bookingId))];

    const bookings = await this.db.query.bookings.findMany({
      where:
        staleBookingIds.length > 0
          ? or(eq(schema.bookings.needsRefundReview, true), inArray(schema.bookings.id, staleBookingIds))
          : eq(schema.bookings.needsRefundReview, true),
      orderBy: desc(schema.bookings.createdAt),
      with: {
        user: true,
        session: { with: { movie: true } },
        payments: true,
        refunds: { orderBy: (refunds, { desc: descending }) => [descending(refunds.createdAt)] },
      },
    });

    const staleRefundIds = new Set(staleRefunds.map((refund) => refund.id));
    return bookings.map((booking) => buildRefundReviewItem(booking, staleRefundIds));
  }
}
