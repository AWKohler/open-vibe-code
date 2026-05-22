/**
 * POST /api/projects/[id]/convex/setup-auth
 *
 * Provisions Convex Auth on a sandboxed-web project:
 *   1. Generates an RSA-256 key pair server-side.
 *   2. Sets CONVEX_AUTH_PRIVATE_KEY, JWKS, and SITE_URL on the Convex
 *      deployment via the Convex Management API (credentials never enter
 *      the sandbox).
 *   3. Returns boilerplate file templates for the agent to write.
 *
 * Safe to call multiple times — it just rotates the signing keys.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { setupConvexAuth } from "@/lib/convex-auth-setup";
import { getUserCredentials } from "@/lib/user-credentials";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId } = await params;
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }
  if (project.backendType === "none") {
    return NextResponse.json(
      { ok: false, error: "This project has no backend — Convex Auth is not available." },
      { status: 400 },
    );
  }
  if (project.platform !== "sandboxed-web") {
    return NextResponse.json(
      { ok: false, error: "setupAuth is only available for sandboxed-web projects." },
      { status: 400 },
    );
  }

  // Resolve SITE_URL from the sandbox's stable preview domain
  let siteUrl = "https://placeholder.example.com";
  try {
    const sandbox = await getOrCreatePersistentSandbox(projectId);
    siteUrl = sandbox.domain(5173);
  } catch {
    // Non-fatal — placeholder is good enough for most auth flows
  }

  // For BYOC backends, use the user's Convex OAuth access token
  let userConvexOAuthToken: string | null = null;
  if (project.backendType === "user") {
    const creds = await getUserCredentials(userId);
    userConvexOAuthToken = creds.convexOAuthAccessToken;
    if (!userConvexOAuthToken) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Your Convex account is not connected. Please reconnect it in Settings → Connections before setting up auth.",
        },
        { status: 402 },
      );
    }
  }

  const result = await setupConvexAuth(projectId, { siteUrl, userConvexOAuthToken });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  return NextResponse.json(result);
}
