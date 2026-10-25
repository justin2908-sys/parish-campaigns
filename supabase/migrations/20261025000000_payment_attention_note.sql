-- A payment that SumUp has taken the money for, but whose tickets had already been given to somebody else, is shown to an Admin in
-- Needs Attention until they have dealt with it. This is the note that says so (no names or contact details: only ticket numbers and the
-- SumUp code). Empty for every payment that is as it should be. Additive: one nullable column, nothing else changes.
alter table payments add column if not exists attention_note text;
