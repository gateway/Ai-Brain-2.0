import Link from "next/link";
import { OperatorShell } from "@/components/operator-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function HelpPage() {
  return (
    <OperatorShell
      currentPath="/help"
      title="Docs"
      subtitle="Use this page as the in-app guide for install, setup order, provider choices, and what each major surface in AI Brain 2.0 is for."
    >
      <div className="space-y-6">
        <section className="overflow-hidden rounded-[32px] border border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.10),_transparent_24%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] px-5 py-6 shadow-[0_24px_80px_rgba(0,0,0,0.24)] sm:px-6">
          <p className="premium-eyebrow text-slate-300">What to read first</p>
          <h3 className="mt-3 text-[1.8rem] font-semibold tracking-[-0.04em] text-white">Start with setup, then move into sessions and the console.</h3>
          <p className="mt-3 max-w-3xl text-[15px] leading-8 text-slate-300">
            The repository docs still exist as source-of-truth markdown, but this page gives the high-level sequence inside the app so a new operator does not have to assemble the workflow from scattered files.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href="/setup" className="inline-flex min-h-10 items-center rounded-2xl bg-cyan-300 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-200">
              Go to Start Here
            </Link>
            <Link href="/bootstrap" className="inline-flex min-h-10 items-center rounded-2xl border border-white/10 bg-white/6 px-4 py-2 text-sm text-white hover:bg-white/10">
              Open guided setup
            </Link>
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-2">
          <Card id="install-first-run" className="overflow-hidden rounded-[28px] border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
            <CardHeader>
              <CardDescription>Install and first run</CardDescription>
              <CardTitle>Recommended sequence</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-[15px] leading-8 text-slate-300">
              <p>1. Prepare PostgreSQL 18 and required extensions.</p>
              <p>2. Create `ai_brain_local` and run migrations.</p>
              <p>3. Choose local runtime or OpenRouter.</p>
              <p>4. Start the root app with `npm run dev`.</p>
              <p>5. Finish `Start Here`, `Guided Setup`, then `Settings`.</p>
              <p>6. Move into `Sessions` for normal operator work.</p>
            </CardContent>
          </Card>

          <Card id="startup-commands" className="overflow-hidden rounded-[28px] border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
            <CardHeader>
              <CardDescription>Command path</CardDescription>
              <CardTitle>Core startup commands</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-[15px] leading-8 text-slate-300">
              <p>From the repo root:</p>
              <pre className="overflow-x-auto rounded-[20px] border border-white/10 bg-black/25 p-4 text-sm leading-7 text-slate-100"><code>{`cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm install
npm install --workspace local-brain
npm install --workspace brain-console
cp .env.example .env`}</code></pre>
              <p>Create the database and run migrations:</p>
              <pre className="overflow-x-auto rounded-[20px] border border-white/10 bg-black/25 p-4 text-sm leading-7 text-slate-100"><code>{`/opt/homebrew/opt/postgresql@18/bin/createdb ai_brain_local
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run migrate`}</code></pre>
              <p>Start the full app:</p>
              <pre className="overflow-x-auto rounded-[20px] border border-white/10 bg-black/25 p-4 text-sm leading-7 text-slate-100"><code>{`cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run dev`}</code></pre>
            </CardContent>
          </Card>

          <Card id="provider-choices" className="overflow-hidden rounded-[28px] border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
            <CardHeader>
              <CardDescription>Provider choices</CardDescription>
              <CardTitle>Local runtime vs OpenRouter</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-[15px] leading-8 text-slate-300">
              <p><span className="font-medium text-white">external</span> means your own local or private model endpoint. Pick this if your local runtime is already reachable and you want the most private default.</p>
              <p><span className="font-medium text-white">openrouter</span> means hosted models and embeddings. Pick this if you want the easiest hosted path and do not mind remote provider calls.</p>
              <p><span className="font-medium text-white">none</span> keeps retrieval lexical-only. Pick this if you want to finish setup now and connect model intelligence later.</p>
              <p>If you already have OpenClaw-style markdown memory, use Guided Setup import as the recommended historical bootstrap path.</p>
              <pre className="overflow-x-auto rounded-[20px] border border-white/10 bg-black/25 p-4 text-sm leading-7 text-slate-100"><code>{`# Local runtime
BRAIN_MODEL_RUNTIME_BASE_URL=http://your-runtime:8000
BRAIN_EXTERNAL_AI_BASE_URL=http://your-runtime:8000

# OpenRouter
OPENROUTER_API_KEY=your_key_here
BRAIN_OPENROUTER_CLASSIFY_MODEL=openai/gpt-4.1-mini
BRAIN_OPENROUTER_EMBEDDING_MODEL=text-embedding-3-small`}</code></pre>
            </CardContent>
          </Card>

          <Card id="app-surfaces" className="overflow-hidden rounded-[28px] border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
            <CardHeader>
              <CardDescription>In-app areas</CardDescription>
              <CardTitle>What each section does</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-[15px] leading-8 text-slate-300">
              <p><span className="font-medium text-white">Dashboard</span>: the daily operator loop, the current state, and the advanced controls you only open when needed.</p>
              <p><span className="font-medium text-white">Start Here</span>: first-run checklist.</p>
              <p><span className="font-medium text-white">Guided Setup</span>: owner bootstrap, sources, verification.</p>
              <p><span className="font-medium text-white">Clarifications</span>: ranked queue/list for ambiguous people, places, aliases, and relation fixes.</p>
              <p><span className="font-medium text-white">Sessions</span>: intake, review, artifacts, clarifications.</p>
              <p><span className="font-medium text-white">Legacy Console</span>: advanced query, graph, timeline, benchmark, and the current derived atlas.</p>
            </CardContent>
          </Card>

          <Card id="repo-docs" className="overflow-hidden rounded-[28px] border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
            <CardHeader>
              <CardDescription>Repo docs</CardDescription>
              <CardTitle>Source-of-truth markdown</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-[15px] leading-8 text-slate-300">
              <p>`docs/FIRST_RUN_SETUP.md`</p>
              <p>`docs/OPERATOR_WORKBENCH_GUIDE.md`</p>
              <p>`local-brain/QUICKSTART.md`</p>
              <p>`docs/LIFE_ONTOLOGY.md`</p>
              <p>`docs/ROUTING_RULES.md`</p>
            </CardContent>
          </Card>

          <Card id="openclaw-path" className="overflow-hidden rounded-[28px] border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)] xl:col-span-2">
            <CardHeader>
              <CardDescription>OpenClaw path</CardDescription>
              <CardTitle>Recommended when you already have markdown memory</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-[15px] leading-8 text-slate-300">
              <p>
                If you already have OpenClaw-style markdown files, use them as your trusted historical bootstrap source instead of inventing a new import format.
                That is the cleanest path for initial grounding.
              </p>
              <pre className="overflow-x-auto rounded-[20px] border border-white/10 bg-black/25 p-4 text-sm leading-7 text-slate-100"><code>{`cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run reconcile:dir -- /absolute/path/to/folder --namespace personal --source-type markdown_session --source-channel openclaw`}</code></pre>
              <p>Inside the app, the equivalent operator flow is <span className="font-medium text-white">Guided Setup to Trusted Source Import</span> with an OpenClaw-style source.</p>
            </CardContent>
          </Card>

          <Card id="owner-bootstrap" className="overflow-hidden rounded-[28px] border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
            <CardHeader>
              <CardDescription>Owner step</CardDescription>
              <CardTitle>What to write in “Tell the brain who you are”</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-[15px] leading-8 text-slate-300">
              <p>Give the brain a short, plain-language narrative. Three to six sentences is enough.</p>
              <p>Good example: <span className="font-medium text-white">“I’m Steve. I live in Bangkok. I’m building AI Brain 2.0 and related products. I care about local-first systems, durable memory, and clean interfaces. I often work with personal notes, transcripts, and project docs.”</span></p>
              <p>You can type, speak, or upload. Raw evidence still lands even if classification is skipped or unavailable.</p>
            </CardContent>
          </Card>

          <Card id="trusted-import" className="overflow-hidden rounded-[28px] border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
            <CardHeader>
              <CardDescription>Source import</CardDescription>
              <CardTitle>Which import lane to use</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-[15px] leading-8 text-slate-300">
              <p><span className="font-medium text-white">Historical archive</span>: old notes or memory folders you want imported once.</p>
              <p><span className="font-medium text-white">Ongoing folder monitor</span>: a folder that changes over time and should keep syncing.</p>
              <p><span className="font-medium text-white">Project source</span>: a specific active project folder with documents worth tracking.</p>
              <p><span className="font-medium text-white">Owner bootstrap</span>: small, high-trust personal files used during identity grounding.</p>
            </CardContent>
          </Card>

          <Card id="verification" className="overflow-hidden rounded-[28px] border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)] xl:col-span-2">
            <CardHeader>
              <CardDescription>Verification</CardDescription>
              <CardTitle>What a good result looks like</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-[15px] leading-8 text-slate-300">
              <p><span className="font-medium text-white">Good</span>: the brain answers a simple question and shows evidence for it.</p>
              <p><span className="font-medium text-white">Needs work</span>: the answer is vague, unsupported, or the search falls back with weak evidence.</p>
              <p>The smoke pack is not trying to impress you. It is trying to prove the substrate can recall useful truth without improvising fiction.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </OperatorShell>
  );
}
