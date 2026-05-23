export function artifactDerivationSearchContentExpression(derivationAlias = "ad", artifactAlias = "a"): string {
  return `
    CASE
      WHEN ${derivationAlias}.derivation_type = 'transcription'
        AND coalesce(
          ${derivationAlias}.metadata->>'primary_speaker_name',
          ${artifactAlias}.metadata->>'primary_speaker_name',
          ${derivationAlias}.metadata->>'transcript_speaker_name',
          ${artifactAlias}.metadata->>'transcript_speaker_name',
          ${derivationAlias}.metadata->>'speaker_name',
          ${artifactAlias}.metadata->>'speaker_name',
          ''
        ) <> ''
      THEN
        coalesce(
          ${derivationAlias}.metadata->>'primary_speaker_name',
          ${artifactAlias}.metadata->>'primary_speaker_name',
          ${derivationAlias}.metadata->>'transcript_speaker_name',
          ${artifactAlias}.metadata->>'transcript_speaker_name',
          ${derivationAlias}.metadata->>'speaker_name',
          ${artifactAlias}.metadata->>'speaker_name'
        ) || ' said: ' || coalesce(${derivationAlias}.content_text, '')
      WHEN coalesce(${derivationAlias}.metadata->>'source_turn_text', ${artifactAlias}.metadata->>'source_turn_text', '') <> ''
        AND (
          ${derivationAlias}.derivation_type ILIKE '%image%'
          OR coalesce(${derivationAlias}.metadata->>'image_query', ${artifactAlias}.metadata->>'image_query', '') <> ''
          OR coalesce(${derivationAlias}.metadata->>'image_caption', ${artifactAlias}.metadata->>'image_caption', '') <> ''
          OR coalesce(${derivationAlias}.metadata->>'blip_caption', ${artifactAlias}.metadata->>'blip_caption', '') <> ''
        )
      THEN concat_ws(
        ' ',
        nullif(coalesce(${derivationAlias}.metadata->>'source_sentence_text', ${artifactAlias}.metadata->>'source_sentence_text', ''), ''),
        nullif(coalesce(${derivationAlias}.metadata->>'source_turn_text', ${artifactAlias}.metadata->>'source_turn_text', ''), ''),
        nullif(coalesce(${derivationAlias}.content_text, ''), ''),
        nullif(coalesce(${derivationAlias}.metadata->>'image_caption', ${artifactAlias}.metadata->>'image_caption', ''), ''),
        nullif(coalesce(${derivationAlias}.metadata->>'image_query', ${artifactAlias}.metadata->>'image_query', ''), '')
      )
      ELSE coalesce(${derivationAlias}.content_text, '')
    END
  `;
}

export function artifactDerivationSearchMetadataExpression(derivationAlias = "ad", artifactAlias = "a"): string {
  return `
    jsonb_strip_nulls(
      coalesce(${derivationAlias}.metadata, '{}'::jsonb) ||
      jsonb_build_object(
        'primary_speaker_name', nullif(coalesce(${derivationAlias}.metadata->>'primary_speaker_name', ${artifactAlias}.metadata->>'primary_speaker_name', ''), ''),
        'transcript_speaker_name', nullif(coalesce(${derivationAlias}.metadata->>'transcript_speaker_name', ${artifactAlias}.metadata->>'transcript_speaker_name', ''), ''),
        'speaker_name', nullif(coalesce(${derivationAlias}.metadata->>'speaker_name', ${artifactAlias}.metadata->>'speaker_name', ''), ''),
        'turn_text', nullif(coalesce(${derivationAlias}.metadata->>'turn_text', ${artifactAlias}.metadata->>'turn_text', ''), ''),
        'source_turn_text', nullif(coalesce(${derivationAlias}.metadata->>'source_turn_text', ${artifactAlias}.metadata->>'source_turn_text', ''), ''),
        'source_sentence_text', nullif(coalesce(${derivationAlias}.metadata->>'source_sentence_text', ${artifactAlias}.metadata->>'source_sentence_text', ''), ''),
        'image_query', nullif(coalesce(${derivationAlias}.metadata->>'image_query', ${artifactAlias}.metadata->>'image_query', ''), ''),
        'image_caption', nullif(coalesce(${derivationAlias}.metadata->>'image_caption', ${artifactAlias}.metadata->>'image_caption', ''), ''),
        'blip_caption', nullif(coalesce(${derivationAlias}.metadata->>'blip_caption', ${artifactAlias}.metadata->>'blip_caption', ''), ''),
        'query', nullif(coalesce(${derivationAlias}.metadata->>'query', ${artifactAlias}.metadata->>'query', ''), '')
      )
    )
  `;
}
