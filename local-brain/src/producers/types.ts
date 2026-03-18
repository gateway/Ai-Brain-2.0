export type ProducerProvider = "generic" | "slack" | "discord";

export interface ProducerWebhookIngestRequest {
  readonly namespaceId: string;
  readonly provider: ProducerProvider;
  readonly payload: Record<string, unknown>;
  readonly sourceChannel?: string;
  readonly capturedAt?: string;
}

export interface ProducerWebhookIngestResult {
  readonly provider: ProducerProvider;
  readonly eventId: string;
  readonly payloadUri: string;
  readonly normalizedUri: string;
  readonly artifactId: string;
  readonly observationId?: string;
  readonly fragments: number;
  readonly candidateWrites: number;
  readonly episodicInsertCount: number;
}

