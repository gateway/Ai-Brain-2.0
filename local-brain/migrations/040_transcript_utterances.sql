-- 040_transcript_utterances.sql

CREATE TABLE IF NOT EXISTS transcript_utterances (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    artifact_observation_id uuid NOT NULL REFERENCES artifact_observations(id) ON DELETE CASCADE,
    derivation_id uuid REFERENCES artifact_derivations(id) ON DELETE SET NULL,
    utterance_index integer NOT NULL,
    speaker_label text,
    speaker_name text,
    start_ms integer,
    end_ms integer,
    normalized_text text NOT NULL,
    utterance_text text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    confidence double precision,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (artifact_observation_id, utterance_index)
);

CREATE INDEX IF NOT EXISTS idx_transcript_utterances_namespace_occurred
    ON transcript_utterances (namespace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_transcript_utterances_observation
    ON transcript_utterances (artifact_observation_id, utterance_index);

CREATE INDEX IF NOT EXISTS idx_transcript_utterances_speaker
    ON transcript_utterances (namespace_id, lower(coalesce(speaker_name, speaker_label, '')), occurred_at DESC);
