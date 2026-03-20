import { saveBootstrapPurposeAction } from "@/app/bootstrap/actions";
import { OperatorShell } from "@/components/operator-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SetupStepGuide } from "@/components/setup-step-guide";
import { Textarea } from "@/components/ui/textarea";
import { getBootstrapState } from "@/lib/operator-workbench";

const selectClassName =
  "h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0";

export default async function BootstrapPurposePage() {
  const bootstrap = await getBootstrapState();
  const purpose = bootstrap.metadata.brainPurposeMode ?? "personal";
  const purposeNotes = typeof bootstrap.metadata.brainPurposeNotes === "string" ? bootstrap.metadata.brainPurposeNotes : "";
  const defaultNamespaceId = bootstrap.metadata.defaultNamespaceId ?? "personal";
  const ingestEmphasis = bootstrap.metadata.ingestEmphasis ?? "life history and durable context";
  const verificationHints = bootstrap.metadata.verificationHints ?? [];

  return (
    <OperatorShell
      currentPath="/bootstrap"
      title="Brain Purpose"
      subtitle="Choose what kind of brain this is before you add a lot of data. This step defines the operating lane the rest of setup will use."
    >
      <div className="mx-auto max-w-4xl space-y-5">
        <SetupStepGuide
          step="Step 1"
          title="Choose the kind of brain you are setting up"
          statusLabel={purpose.replace(/_/g, " ")}
          whatToDo="Pick the mode that best matches what this brain should primarily hold: personal life context, business context, creative work, or a hybrid of those."
          whyItMatters="This sets the default namespace, source posture, and verification hints used by the rest of setup. It tells the system what belongs in this lane."
          nextHref="/bootstrap/owner"
          nextLabel="Next: owner setup"
        />
        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Step 1</CardDescription>
            <CardTitle>Set the brain purpose</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveBootstrapPurposeAction} className="grid max-w-3xl gap-5">
              <label className="grid max-w-sm gap-2">
                <span className="text-sm font-medium text-slate-100">Purpose mode</span>
                <select name="brain_purpose" defaultValue={purpose} className={selectClassName}>
                  <option value="personal">Personal</option>
                  <option value="business">Business</option>
                  <option value="creative">Creative</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </label>

              <div className="rounded-[20px] border border-white/10 bg-white/4 p-4 text-sm leading-7 text-slate-300">
                This is a typed operating mode, not just a label. It sets the default namespace, the default posture for sources, and the verification language the bootstrap flow will use.
              </div>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Operator notes</span>
                <Textarea
                  name="brain_purpose_notes"
                  defaultValue={purposeNotes}
                  placeholder="Optional notes about the lane, privacy boundary, or what should stay out of scope."
                />
              </label>

              <div className="rounded-[20px] border border-white/10 bg-white/4 p-4 text-sm leading-7 text-slate-300">
                Current defaults for this step:
                <div className="mt-3 grid gap-2 text-sm text-slate-200">
                  <p>Default namespace: <span className="font-medium text-white">{defaultNamespaceId}</span></p>
                  <p>Ingest emphasis: <span className="font-medium text-white">{ingestEmphasis}</span></p>
                  <p>Verification hints: <span className="font-medium text-white">{verificationHints.join(", ") || "not set yet"}</span></p>
                </div>
              </div>

              <div className="flex justify-end gap-3">
                <Button type="submit" size="lg" className="rounded-2xl bg-amber-300 text-stone-950 hover:bg-amber-200">
                  Save purpose
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Guidance</CardDescription>
            <CardTitle>How to choose a purpose</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm leading-7 text-slate-300">
            <div className="rounded-[20px] border border-white/10 bg-white/4 p-4 text-sm leading-7 text-slate-300">
              Expand the sections below if you want examples before choosing a mode. Keep the selection broad enough to reflect the lane this brain should operate in, but specific enough that an operator can tell what belongs here and what does not.
            </div>

            <details className="group rounded-[20px] border border-white/8 bg-white/5 p-4 open:border-amber-300/20 open:bg-amber-300/8">
              <summary className="cursor-pointer list-none">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-xl font-semibold tracking-tight text-white">Personal</h2>
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-400 transition group-open:text-amber-100">Expand</span>
                </div>
              </summary>
              <div className="mt-4 border-t border-white/8 pt-4">
                <p>Use this when the brain is mainly about your life, family, relationships, travel, preferences, health context, and personal history.</p>
                <p className="mt-2 text-slate-400">Default namespace <code>personal</code>. Verification should focus on home base, important people, and preferences.</p>
              </div>
            </details>

            <details className="group rounded-[20px] border border-white/8 bg-white/5 p-4 open:border-amber-300/20 open:bg-amber-300/8">
              <summary className="cursor-pointer list-none">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-xl font-semibold tracking-tight text-white">Business</h2>
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-400 transition group-open:text-amber-100">Expand</span>
                </div>
              </summary>
              <div className="mt-4 border-t border-white/8 pt-4">
                <p>Use this when the brain is mainly for work operations, projects, clients, meetings, product decisions, research, and business relationships.</p>
                <p className="mt-2 text-slate-400">Default namespace <code>business</code>. Monitoring defaults lean toward active folder watch and work-oriented verification queries.</p>
              </div>
            </details>

            <details className="group rounded-[20px] border border-white/8 bg-white/5 p-4 open:border-amber-300/20 open:bg-amber-300/8">
              <summary className="cursor-pointer list-none">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-xl font-semibold tracking-tight text-white">Creative</h2>
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-400 transition group-open:text-amber-100">Expand</span>
                </div>
              </summary>
              <div className="mt-4 border-t border-white/8 pt-4">
                <p>Use this when the brain is mainly for ideas, works in progress, references, inspirations, and creative collaborators.</p>
                <p className="mt-2 text-slate-400">Default namespace <code>creative</code>. Verification should focus on active pieces, inspirations, and who you create with.</p>
              </div>
            </details>

            <details className="group rounded-[20px] border border-cyan-300/20 bg-cyan-300/10 p-4 open:border-cyan-300/30 open:bg-cyan-300/14">
              <summary className="cursor-pointer list-none">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-xl font-semibold tracking-tight text-white">Hybrid</h2>
                  <span className="text-xs uppercase tracking-[0.2em] text-cyan-100/70 transition group-open:text-cyan-50">Expand</span>
                </div>
              </summary>
              <div className="mt-4 border-t border-cyan-200/10 pt-4">
                <p>Use this when your life and work context are intentionally mixed and one memory lane should preserve the cross-over.</p>
                <p className="mt-2 text-slate-300">Default namespace <code>hybrid</code>. Verification should prove both personal and project context can be recalled with evidence.</p>
              </div>
            </details>
          </CardContent>
        </Card>
      </div>
    </OperatorShell>
  );
}
