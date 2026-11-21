CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"external_refund_id" text,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_seat_labels" text[];--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_booking_id_idx" ON "refunds" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_external_refund_id_uq" ON "refunds" USING btree ("external_refund_id") WHERE "refunds"."external_refund_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_active_per_payment_uq" ON "refunds" USING btree ("payment_id") WHERE "refunds"."status" IN ('requested', 'in_process', 'approved');