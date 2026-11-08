CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"payment_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_booking_id_unique";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "status_detail" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "installments" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_method_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_booking_id_created_at_idx" ON "payment_events" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_booking_id_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_external_payment_id_uq" ON "payments" USING btree ("external_payment_id") WHERE "payments"."external_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION forbid_payment_events_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'payment_events is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER payment_events_append_only
BEFORE UPDATE OR DELETE ON "payment_events"
FOR EACH ROW EXECUTE FUNCTION forbid_payment_events_mutation();