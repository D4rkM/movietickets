ALTER TABLE "booking_seats" ADD COLUMN "ticket_type" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_seats" ADD COLUMN "half_price_document" text;--> statement-breakpoint
ALTER TABLE "booking_seats" ADD COLUMN "price_cents" integer DEFAULT 0 NOT NULL;