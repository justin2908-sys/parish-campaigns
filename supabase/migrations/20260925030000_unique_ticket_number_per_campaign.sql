-- A ticket number belongs to exactly one series in a campaign, physical or online. Physical sales
-- and the buyer page both look tickets up by campaign + number, so a number existing twice
-- would be ambiguous. This is the last line of defence behind the checks in the app.
create unique index tickets_campaign_id_ticket_number_key on tickets (campaign_id, ticket_number);
