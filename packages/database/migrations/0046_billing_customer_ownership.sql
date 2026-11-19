DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "organizations"
		WHERE "billing_customer_id" IS NOT NULL
		GROUP BY "billing_customer_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'billing customer ownership cutover blocked: duplicate billing_customer_id values exist';
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_billing_customer_uidx" ON "organizations" USING btree ("billing_customer_id") WHERE "organizations"."billing_customer_id" is not null;
