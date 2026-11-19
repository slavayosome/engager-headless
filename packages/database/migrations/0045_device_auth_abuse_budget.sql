CREATE TABLE "device_auth_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" bigint NOT NULL,
	"count" integer NOT NULL,
	"updated_at" bigint NOT NULL
);
