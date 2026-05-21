/**
 * GET / POST /api/projects/[id]/agent-backend
 *
 * GET: returns the project's current agent_backend + current_segment_id,
 *      alongside the user's full resolution (so the client can render the
 *      chip/badge without a separate call to /api/user-settings).
 *
 * POST: switches the project to a new agent_backend. Validates the requested
 *       backend is available to this user for this project (via
 *       resolveBackends). On success, mints a fresh current_segment_id so the
 *       new agent reads a clean slate (old messages stay in DB under their
 *       previous segment_id).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getUserCredentials } from "@/lib/user-credentials";
import { resolveModelId } from "@/lib/agent/models";
import { normalizeProjectPlatform } from "@/lib/project-platform";
import {
  isAgentBackend,
  resolveBackends,
  type AgentBackend,
} from "@/lib/agent/backend-resolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  /** Canonical field. `agentBackend` accepted for back-compat. */
  backend?: AgentBackend;
  agentBackend?: AgentBackend;
  /**
   * Whether to mint a new segment id so the new agent reads an empty
   * conversation. Default true — only the silent coerce path (creds
   * went stale, not a deliberate user switch) passes false.
   */
  mintNewSegment?: boolean;
}

async function authorized(projectId: string) {
  const { userId } = await auth();
  if (!userId) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return { userId, project };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await authorized(id);
  if ("error" in result) return result.error;
  const { userId, project } = result;

  const creds = await getUserCredentials(userId);
  const resolution = resolveBackends({
    model: resolveModelId(project.model),
    platform: normalizeProjectPlatform(project.platform),
    creds: {
      hasClaudeOAuth: Boolean(creds.claudeOAuthAccessToken),
      hasAnthropicKey: Boolean(creds.anthropicApiKey),
    },
  });

  return NextResponse.json({
    agentBackend: project.agentBackend,
    currentSegmentId: project.currentSegmentId,
    resolution,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await authorized(id);
  if ("error" in result) return result.error;
  const { userId, project } = result;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const requested = body.backend ?? body.agentBackend;
  if (!requested || !isAgentBackend(requested)) {
    return NextResponse.json({ error: "Invalid backend value" }, { status: 400 });
  }

  // No-op when picking the current backend (don't mint a segment for nothing).
  if (requested === project.agentBackend) {
    return NextResponse.json({
      agentBackend: project.agentBackend,
      currentSegmentId: project.currentSegmentId,
      changed: false,
    });
  }

  // Validate the requested backend is actually available to this user.
  const creds = await getUserCredentials(userId);
  const resolution = resolveBackends({
    model: resolveModelId(project.model),
    platform: normalizeProjectPlatform(project.platform),
    creds: {
      hasClaudeOAuth: Boolean(creds.claudeOAuthAccessToken),
      hasAnthropicKey: Boolean(creds.anthropicApiKey),
    },
  });
  if (!resolution.available.includes(requested)) {
    return NextResponse.json(
      {
        error: "Backend not available",
        reason: resolution.reason,
        available: resolution.available,
      },
      { status: 409 },
    );
  }

  // Mint a fresh segment id by default. The silent coerce path (creds went
  // stale, not a deliberate switch) passes mintNewSegment: false so the user
  // doesn't lose conversation context to a behind-the-scenes correction.
  const mintNewSegment = body.mintNewSegment !== false;
  const nextSegmentId = mintNewSegment ? randomUUID() : project.currentSegmentId;

  const db = getDb();
  await db
    .update(projects)
    .set({
      agentBackend: requested,
      ...(mintNewSegment ? { currentSegmentId: nextSegmentId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id));

  return NextResponse.json({
    agentBackend: requested,
    currentSegmentId: nextSegmentId,
    changed: true,
    segmentChanged: mintNewSegment,
  });
}
