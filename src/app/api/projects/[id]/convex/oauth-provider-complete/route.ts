/**
 * POST /api/projects/[id]/convex/oauth-provider-complete
 *
 * Called by the workspace modal when the user either:
 *   a) saves credentials → sets AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET on the
 *      Convex deployment and marks the request as 'completed'.
 *   b) dismisses the modal → marks the request as 'dismissed'.
 *
 * The credentials are set server-side and NEVER returned to the client.
 *
 * Body:
 *   { requestId: string, dismissed?: true }              — dismiss
 *   { requestId: string, clientId: string, clientSecret: string } — save
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { projects, oauthProviderRequests } from "@/db/schema";
import { setOAuthProviderEnvVars } from "@/lib/convex-auth-setup";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const { id: projectId } = await params;
    const body = (await req.json()) as {
      requestId: string;
      dismissed?: boolean;
      clientId?: string;
      clientSecret?: string;
    };

    const { requestId, dismissed, clientId, clientSecret } = body;
    if (!requestId) {
      return NextResponse.json({ ok: false, error: "requestId is required." }, { status: 400 });
    }

    const db = getDb();

    // Ownership check
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
    }

    // Find the pending request
    const [oauthReq] = await db
      .select()
      .from(oauthProviderRequests)
      .where(
        and(
          eq(oauthProviderRequests.id, requestId),
          eq(oauthProviderRequests.projectId, projectId),
          eq(oauthProviderRequests.status, "pending"),
        ),
      )
      .limit(1);

    if (!oauthReq) {
      return NextResponse.json(
        { ok: false, error: "No pending OAuth request found with that ID." },
        { status: 404 },
      );
    }

    if (dismissed) {
      await db
        .update(oauthProviderRequests)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(eq(oauthProviderRequests.id, requestId));
      return NextResponse.json({ ok: true, status: "dismissed" });
    }

    // Validate credentials before touching Convex
    if (!clientId?.trim() || !clientSecret?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Both Client ID and Client Secret are required." },
        { status: 400 },
      );
    }

    // Set the env vars server-side — credentials never leave this function
    await setOAuthProviderEnvVars(
      projectId,
      oauthReq.provider as "google",
      clientId.trim(),
      clientSecret.trim(),
    );

    await db
      .update(oauthProviderRequests)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(oauthProviderRequests.id, requestId));

    return NextResponse.json({ ok: true, status: "completed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[oauth-provider-complete] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
