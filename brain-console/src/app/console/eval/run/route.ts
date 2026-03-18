import { NextResponse } from "next/server";
import { runLocalBrainScript } from "@/lib/local-brain-runner";

export async function POST(request: Request) {
  const url = new URL(request.url);

  try {
    await runLocalBrainScript("eval");
    return NextResponse.redirect(new URL("/console/eval?status=ok", url), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.redirect(new URL(`/console/eval?status=error&message=${encodeURIComponent(message)}`, url), 303);
  }
}
