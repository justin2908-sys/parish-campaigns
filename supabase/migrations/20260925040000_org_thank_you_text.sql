-- The thank-you line added to the public page and to every payment-link / ticket message the
-- church sends. Set once by the SuperAdmin; if empty, the app falls back to a plain thank-you
-- using the church's name.
alter table organizations add column thank_you_text text;
