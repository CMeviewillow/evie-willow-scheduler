-- Time tracker, phase 1: row level security
--
-- The scheduler's existing kv_store table has no auth.* calls anywhere
-- in the codebase (confirmed against src/storage.js — createClient with
-- just the anon key, no supabase.auth usage), so it runs on permissive
-- RLS for the anon role. These tables match that same pattern so the
-- app keeps working exactly as it does today.
--
-- TODO: this has no real access control — anyone with the anon key can
-- read and write everything. Proper auth (per-role policies, PIN-gated
-- writes from the floor board, etc.) is separate work, out of scope for
-- this branch.

alter table people enable row level security;
alter table person_aliases enable row level security;
alter table jobs enable row level security;
alter table rooms enable row level security;
alter table cabinet_types enable row level security;
alter table stages enable row level security;
alter table a4_imports enable row level security;
alter table cabinets enable row level security;
alter table time_entries enable row level security;

create policy "allow all - people" on people for all using (true) with check (true);
create policy "allow all - person_aliases" on person_aliases for all using (true) with check (true);
create policy "allow all - jobs" on jobs for all using (true) with check (true);
create policy "allow all - rooms" on rooms for all using (true) with check (true);
create policy "allow all - cabinet_types" on cabinet_types for all using (true) with check (true);
create policy "allow all - stages" on stages for all using (true) with check (true);
create policy "allow all - a4_imports" on a4_imports for all using (true) with check (true);
create policy "allow all - cabinets" on cabinets for all using (true) with check (true);
create policy "allow all - time_entries" on time_entries for all using (true) with check (true);
