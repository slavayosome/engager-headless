/** How many days before `trial_end` the trial-ending reminder goes out —
 * Stripe's own `customer.subscription.trial_will_end` lead (O-1). The email
 * (US-ONI-03) and the app's in-app trial note (US-ONC-08) read this one
 * number, so the note appears exactly when the reminder is due. */
export const TRIAL_REMINDER_LEAD_DAYS = 3;
