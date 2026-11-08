ALTER TABLE "bookings" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "bookings" SET "expires_at" = "created_at" + interval '10 minutes';--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '10 minutes'), ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "needs_refund_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "stale_payment_alerted_at" timestamp with time zone;
