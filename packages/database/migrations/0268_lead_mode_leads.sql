ALTER TABLE "leads" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "researched_at" bigint;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "fit" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "intent_quote" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "intent_at" bigint;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "rating" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "rated_at" bigint;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "set_aside_at" bigint;--> statement-breakpoint
CREATE INDEX "leads_org_campaign_stage_idx" ON "leads" USING btree ("organization_id","campaign_id","stage");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_stage_check" CHECK ("leads"."stage" is null or "leads"."stage" in ('signal', 'lead', 'contacted', 'relationship', 'no_answer'));--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_role_check" CHECK ("leads"."role" is null or "leads"."role" in ('buyer', 'peer', 'competitor', 'partner', 'noise'));--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_origin_check" CHECK ("leads"."origin" is null or "leads"."origin" in ('inbound', 'find_leads'));--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_fit_check" CHECK ("leads"."fit" is null or "leads"."fit" in ('strong', 'fits', 'weak'));--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_intent_check" CHECK ("leads"."intent" is null or "leads"."intent" in ('asking', 'has_problem', 'topic_only'));--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_intent_quote_check" CHECK ("leads"."intent" is null or "leads"."intent" = 'topic_only'
        or (char_length(btrim(coalesce("leads"."intent_quote", ''))) > 0 and "leads"."intent_at" is not null));--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_rating_check" CHECK (("leads"."rating" is null or "leads"."rating" in ('right_person', 'a_peer', 'not_a_fit', 'wrong_intent'))
        and ("leads"."rating" is null) = ("leads"."rated_at" is null));