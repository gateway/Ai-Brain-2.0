-- 045_typed_fact_lanes.sql

CREATE TABLE IF NOT EXISTS transaction_items (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_memory_id uuid,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
    purchaser_name text,
    item_label text NOT NULL,
    normalized_item_label text NOT NULL,
    quantity_text text,
    price_text text,
    currency_code text,
    total_price_text text,
    total_currency_code text,
    occurred_at timestamptz,
    context_text text,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (
        namespace_id,
        source_memory_id,
        normalized_item_label,
        quantity_text,
        price_text,
        total_price_text
    )
);

CREATE INDEX IF NOT EXISTS idx_transaction_items_namespace_time
    ON transaction_items (namespace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_transaction_items_namespace_item
    ON transaction_items (namespace_id, normalized_item_label, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_transaction_items_source_memory
    ON transaction_items (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS media_mentions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_memory_id uuid,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
    subject_name text,
    media_title text NOT NULL,
    normalized_media_title text NOT NULL,
    media_kind text NOT NULL DEFAULT 'unknown'
        CHECK (media_kind IN ('movie', 'show', 'book', 'song', 'anime', 'unknown')),
    mention_kind text NOT NULL DEFAULT 'mentioned'
        CHECK (mention_kind IN ('mentioned', 'watched', 'wants_to_watch', 'liked', 'disliked', 'unknown')),
    time_hint_text text,
    location_text text,
    context_text text,
    occurred_at timestamptz,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (
        namespace_id,
        source_memory_id,
        normalized_media_title,
        subject_name,
        mention_kind
    )
);

CREATE INDEX IF NOT EXISTS idx_media_mentions_namespace_title
    ON media_mentions (namespace_id, normalized_media_title, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_mentions_namespace_subject
    ON media_mentions (namespace_id, subject_name, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_mentions_source_memory
    ON media_mentions (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS preference_facts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_memory_id uuid,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
    subject_name text,
    predicate text NOT NULL
        CHECK (predicate IN ('likes', 'dislikes', 'prefers', 'avoids')),
    object_text text NOT NULL,
    normalized_object_text text NOT NULL,
    domain text NOT NULL DEFAULT 'unknown'
        CHECK (domain IN ('food', 'media', 'activity', 'general', 'unknown')),
    qualifier text,
    occurred_at timestamptz,
    context_text text,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (
        namespace_id,
        source_memory_id,
        predicate,
        normalized_object_text,
        subject_name
    )
);

CREATE INDEX IF NOT EXISTS idx_preference_facts_namespace_domain
    ON preference_facts (namespace_id, domain, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_preference_facts_namespace_subject
    ON preference_facts (namespace_id, subject_name, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_preference_facts_source_memory
    ON preference_facts (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS person_time_facts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_memory_id uuid,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
    person_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
    person_name text NOT NULL,
    fact_text text NOT NULL,
    normalized_fact_text text NOT NULL,
    time_hint_text text,
    window_start timestamptz,
    window_end timestamptz,
    location_text text,
    occurred_at timestamptz,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (
        namespace_id,
        source_memory_id,
        person_name,
        normalized_fact_text,
        time_hint_text
    )
);

CREATE INDEX IF NOT EXISTS idx_person_time_facts_namespace_person_time
    ON person_time_facts (namespace_id, person_name, COALESCE(window_start, occurred_at) DESC);

CREATE INDEX IF NOT EXISTS idx_person_time_facts_namespace_fact
    ON person_time_facts (namespace_id, normalized_fact_text, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_person_time_facts_source_memory
    ON person_time_facts (source_memory_id)
    WHERE source_memory_id IS NOT NULL;
