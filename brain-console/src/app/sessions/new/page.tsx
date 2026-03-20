import { createSessionAction } from "@/app/sessions/actions";
import { OperatorShell } from "@/components/operator-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getNamespaceCatalog } from "@/lib/operator-workbench";

const providerSelectClassName =
  "h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0";

export default async function NewSessionPage() {
  const namespaces = await getNamespaceCatalog();

  return (
    <OperatorShell
      currentPath="/sessions"
      title="Create Session"
      subtitle="A session is a bounded operator-run ingestion context. Create it once, then keep intake, review, and later corrections tied to that explicit scope."
    >
      <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
        <CardHeader>
          <CardDescription>Session metadata</CardDescription>
          <CardTitle>New ingestion session</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createSessionAction} className="grid gap-5">
            <div className="grid gap-5 lg:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Title</span>
                <Input name="title" required placeholder="Steve background intake" />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Namespace</span>
                <Input
                  name="namespace_id"
                  list="namespace-options"
                  defaultValue={namespaces.defaultNamespaceId}
                  placeholder="personal"
                />
                <datalist id="namespace-options">
                  {namespaces.namespaces.map((namespace) => (
                    <option key={namespace.namespaceId} value={namespace.namespaceId}>
                      {namespace.namespaceId}
                    </option>
                  ))}
                </datalist>
              </label>
            </div>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-slate-100">Notes</span>
              <Textarea
                name="notes"
                placeholder="What this session is for, what material you expect to ingest, and anything operators should know."
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-slate-100">Tags</span>
              <Input name="tags" placeholder="bio, people, research" />
            </label>

            <div className="grid gap-5 lg:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Default LLM provider</span>
                <select name="default_llm_provider" defaultValue="external" className={providerSelectClassName}>
                  <option value="external">Local runtime</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Default embedding provider</span>
                <select name="default_embedding_provider" defaultValue="external" className={providerSelectClassName}>
                  <option value="external">Local runtime</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </label>
            </div>

            <div className="grid gap-5 lg:grid-cols-4">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Default LLM model</span>
                <Input name="default_llm_model" placeholder="unsloth/Qwen3.5-35B-A3B-GGUF" />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Default LLM preset</span>
                <Input name="default_llm_preset" placeholder="research-analyst" />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Default ASR model</span>
                <Input name="default_asr_model" placeholder="Qwen/Qwen3-ASR-1.7B" />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Default embedding model</span>
                <Input name="default_embedding_model" placeholder="Qwen/Qwen3-Embedding-4B" />
              </label>
            </div>

            <p className="rounded-[18px] border border-white/10 bg-white/4 px-4 py-3 text-sm leading-7 text-slate-300">
              Local runtime remains the safe default. OpenRouter is optional and only works when the server has
              <code className="mx-1 rounded bg-white/8 px-1.5 py-0.5 text-xs">OPENROUTER_API_KEY</code>
              configured.
            </p>

            <div className="flex justify-end">
              <Button type="submit" size="lg" className="rounded-2xl">
                Create session
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </OperatorShell>
  );
}
