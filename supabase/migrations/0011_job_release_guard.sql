-- Time tracker, phase 1: job release guard
--
-- A job cannot move to status='released' while any of its cabinets still
-- has a null cabinet_type_id — enforced here at the database level, not
-- just the UI, per the spec ("Enforce in a database trigger, not just
-- the UI"). Every other status transition is unrestricted.

create or replace function enforce_job_release_requires_typed_cabinets()
returns trigger as $$
declare
  untyped_count int;
begin
  if new.status = 'released' and (old.status is distinct from 'released') then
    select count(*) into untyped_count
    from cabinets c
    join rooms r on r.id = c.room_id
    where r.job_id = new.id
      and c.cabinet_type_id is null;

    if untyped_count > 0 then
      raise exception 'Cannot release job %: % cabinet(s) still have no cabinet_type_id', new.da_number, untyped_count;
    end if;

    if new.released_at is null then
      new.released_at = now();
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_job_release_guard on jobs;
create trigger trg_job_release_guard
  before update on jobs
  for each row execute function enforce_job_release_requires_typed_cabinets();
