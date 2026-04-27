import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { sandboxGrep } from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project || project.userId !== userId || project.platform !== "persistent") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json() as {
    pattern: string;
    path?: string;
    glob?: string;
    caseInsensitive?: boolean;
    maxResults?: number;
  };

  if (!body.pattern) {
    return NextResponse.json({ error: "pattern required" }, { status: 400 });
  }

  try {
    const results = await sandboxGrep(project.id, body.pattern, {
      path: body.path,
      glob: body.glob,
      caseInsensitive: body.caseInsensitive,
      maxResults: body.maxResults,
    });
    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed" },
      { status: 500 },
    );
  }
}
