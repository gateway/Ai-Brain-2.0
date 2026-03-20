import { redirect } from "next/navigation";

export default async function SessionIndexPage({
  params
}: {
  readonly params: Promise<{ readonly sessionId: string }>;
}) {
  const { sessionId } = await params;
  redirect(`/sessions/${sessionId}/overview`);
}
