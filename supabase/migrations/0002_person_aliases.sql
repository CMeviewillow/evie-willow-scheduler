-- Time tracker, phase 1: person_aliases
--
-- Every name variant that has ever appeared in a Clockify export maps to
-- one person row. This is what lets imported Clockify history pool
-- correctly with live entries after a rename — the importer (a later
-- branch) resolves whatever name string it finds against this table, not
-- against people.name directly.

create table if not exists person_aliases (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id),
  alias text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_person_aliases_person_id on person_aliases (person_id);

-- Seed: one alias per person matching their current name, so every person
-- has at least a self-referential alias to resolve against from day one.
insert into person_aliases (person_id, alias)
select id, name from people;

-- Plus known historical name variants from before the team list was
-- corrected — so a Clockify export using the old name still resolves.
insert into person_aliases (person_id, alias)
select id, 'Victoria Pearce' from people where name = 'Victoria';
