-- 037_episodic_loose_provenance.sql

-- Clear the inbound foreign-key wall to allow authoritative episodic_memory
-- to become a Timescale hypertable when the extension is available.
-- Provenance remains via indexed UUID pointers and audit queries.

ALTER TABLE semantic_memory
    DROP CONSTRAINT IF EXISTS semantic_memory_source_episodic_id_fkey;

ALTER TABLE memory_candidates
    DROP CONSTRAINT IF EXISTS memory_candidates_source_memory_id_fkey;

ALTER TABLE memory_entity_mentions
    DROP CONSTRAINT IF EXISTS memory_entity_mentions_source_memory_id_fkey;

ALTER TABLE relationship_candidates
    DROP CONSTRAINT IF EXISTS relationship_candidates_source_memory_id_fkey;

ALTER TABLE temporal_node_members
    DROP CONSTRAINT IF EXISTS temporal_node_members_source_memory_id_fkey;

ALTER TABLE claim_candidates
    DROP CONSTRAINT IF EXISTS claim_candidates_source_memory_id_fkey;

ALTER TABLE narrative_event_members
    DROP CONSTRAINT IF EXISTS narrative_event_members_source_memory_id_fkey;

ALTER TABLE memory_reconsolidation_events
    DROP CONSTRAINT IF EXISTS memory_reconsolidation_events_source_episodic_id_fkey;

DO $$
BEGIN
    IF to_regclass('public.episodic_timeline_legacy') IS NOT NULL
        AND EXISTS (
            SELECT 1
            FROM pg_class
            WHERE oid = 'public.episodic_timeline_legacy'::regclass
              AND relkind = 'r'
        ) THEN
        EXECUTE 'ALTER TABLE episodic_timeline_legacy DROP CONSTRAINT IF EXISTS episodic_timeline_memory_id_fkey';
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_semantic_source_episodic
    ON semantic_memory (source_episodic_id)
    WHERE source_episodic_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_source_memory
    ON memory_candidates (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mentions_source_memory
    ON memory_entity_mentions (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_relationship_candidates_source_memory
    ON relationship_candidates (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_temporal_node_members_source_memory
    ON temporal_node_members (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_candidates_source_memory
    ON claim_candidates (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_narrative_event_members_source_memory
    ON narrative_event_members (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reconsolidation_source_episodic
    ON memory_reconsolidation_events (source_episodic_id)
    WHERE source_episodic_id IS NOT NULL;

CREATE OR REPLACE VIEW episodic_loose_provenance_audit AS
SELECT
    'semantic_memory.source_episodic_id'::text AS reference_name,
    count(*)::bigint AS orphan_count
FROM semantic_memory sm
WHERE sm.source_episodic_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM episodic_memory em
      WHERE em.id = sm.source_episodic_id
  )
UNION ALL
SELECT
    'memory_candidates.source_memory_id'::text AS reference_name,
    count(*)::bigint AS orphan_count
FROM memory_candidates mc
WHERE mc.source_memory_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM episodic_memory em
      WHERE em.id = mc.source_memory_id
  )
UNION ALL
SELECT
    'memory_entity_mentions.source_memory_id'::text AS reference_name,
    count(*)::bigint AS orphan_count
FROM memory_entity_mentions mem
WHERE mem.source_memory_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM episodic_memory em
      WHERE em.id = mem.source_memory_id
  )
UNION ALL
SELECT
    'relationship_candidates.source_memory_id'::text AS reference_name,
    count(*)::bigint AS orphan_count
FROM relationship_candidates rc
WHERE rc.source_memory_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM episodic_memory em
      WHERE em.id = rc.source_memory_id
  )
UNION ALL
SELECT
    'temporal_node_members.source_memory_id'::text AS reference_name,
    count(*)::bigint AS orphan_count
FROM temporal_node_members tnm
WHERE tnm.source_memory_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM episodic_memory em
      WHERE em.id = tnm.source_memory_id
  )
UNION ALL
SELECT
    'claim_candidates.source_memory_id'::text AS reference_name,
    count(*)::bigint AS orphan_count
FROM claim_candidates cc
WHERE cc.source_memory_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM episodic_memory em
      WHERE em.id = cc.source_memory_id
  )
UNION ALL
SELECT
    'narrative_event_members.source_memory_id'::text AS reference_name,
    count(*)::bigint AS orphan_count
FROM narrative_event_members nem
WHERE nem.source_memory_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM episodic_memory em
      WHERE em.id = nem.source_memory_id
  )
UNION ALL
SELECT
    'memory_reconsolidation_events.source_episodic_id'::text AS reference_name,
    count(*)::bigint AS orphan_count
FROM memory_reconsolidation_events mre
WHERE mre.source_episodic_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM episodic_memory em
      WHERE em.id = mre.source_episodic_id
  );
