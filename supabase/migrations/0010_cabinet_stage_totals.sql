-- Time tracker, phase 1: cabinet_stage_totals view
--
-- The scheduler needs elapsed span (for capacity planning) while the
-- benchmark library needs labour minutes (for costing) — this view
-- exposes both per cabinet/stage so neither side has to recompute it.

create or replace view cabinet_stage_totals as
select
  cabinet_id,
  stage_id,
  sum(net_minutes) filter (where net_minutes is not null) as labour_minutes,
  (extract(epoch from (max(stopped_at) - min(started_at))) / 60)::int
    - sum(break_minutes_deducted) as elapsed_minutes,
  count(distinct person_id) as distinct_people,
  count(*) as session_count
from time_entries
where cabinet_id is not null
  and stopped_at is not null
group by cabinet_id, stage_id;
