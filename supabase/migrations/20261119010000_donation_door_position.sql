-- Where "Make a Donation" appears among the big buttons on the parish page: 1 = first (the default), 2 = after the first link, and so on.
alter table donation_settings add column if not exists door_position integer not null default 1 check (door_position between 1 and 10);
