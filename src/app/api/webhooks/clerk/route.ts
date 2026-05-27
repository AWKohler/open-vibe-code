/**
 * Clerk webhook receiver.
 *
 * Fires on user lifecycle events. We care about plan transitions:
 *   - free → paid: clear becameReapableAt on the user's projects; cancel
 *     in-flight reaper warnings; send a "you're safe" email for projects
 *     that had received warn90/warn104 in the previous free interval.
 *   - paid → free: set becameReapableAt = now on the user's non-archived
 *     projects so the reaper's idle clock starts from the downgrade. This
 *     gives a freshly-downgraded user the full warning window instead of
 *     inheriting two-year-old paid-era inactivity.
 *
 * Clerk dispatches `user.created`, `user.updated`, `user.deleted`, and
 * `session.*` events. We listen to user.updated because Clerk pushes
 * publicMetadata.plan changes through there. (Clerk Billing also surfaces
 * `subscription.*` events; we treat user.updated as the source of truth so
 * BOTH Clerk Billing and manually-set publicMetadata.plan flow through here.)
 *
 * Set CLERK_WEBHOOK_SECRET in the Clerk dashboard under the webhook endpoint
 * and replay events to test.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { Webhook } from "svix";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { invalidateTierCache, type Tier } from "@/lib/tier";
import { getEmailForClerkUser } from "@/lib/email";
import { sendRestoredEmail } from "@/lib/reaper/emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ClerkUserUpdated = {
  type: "user.updated" | "user.created" | "user.deleted";
  data: {
    id: string;
    public_metadata?: Record<string, unknown>;
  };
};

function planFromMetadata(md: Record<string, unknown> | undefined): Tier {
  const plan = (md as { plan?: string } | undefined)?.plan;
  return plan === "pro" ? "pro" : plan === "max" ? "max" : "free";
}

export async function POST(req: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[clerk-webhook] CLERK_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const hdrs = await headers();
  const svixId = hdrs.get("svix-id");
  const svixTimestamp = hdrs.get("svix-timestamp");
  const svixSignature = hdrs.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing svix headers" }, { status: 400 });
  }

  const body = await req.text();
  let evt: ClerkUserUpdated;
  try {
    const wh = new Webhook(secret);
    evt = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkUserUpdated;
  } catch (e) {
    console.warn("[clerk-webhook] signature verification failed:", e);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (evt.type === "user.created" || evt.type === "user.updated") {
    await handlePlanChange(evt.data.id, planFromMetadata(evt.data.public_metadata));
  }
  // user.deleted: leave projects alone; admin/console flow handles user removal.

  return NextResponse.json({ ok: true });
}

async function handlePlanChange(userId: string, newTier: Tier): Promise<void> {
  await invalidateTierCache(userId);
  const db = getDb();

  if (newTier === "free") {
    // Downgrade: stamp becameReapableAt on all of this user's non-archived
    // projects that don't already have it set.
    await db
      .update(projects)
      .set({ becameReapableAt: new Date() })
      .where(
        and(
          eq(projects.userId, userId),
          isNull(projects.deletedAt),
          isNull(projects.becameReapableAt),
          ne(projects.reapStage, "deleted"),
        ),
      );
    return;
  }

  // Upgrade (or stays paid): clear becameReapableAt and rewind any
  // in-warning reap stages back to active. Send a restoration email for
  // projects that had actually received a warning so the user gets explicit
  // closure on any "we'll delete your project" message in their inbox.
  const wasInWarning = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        inArray(projects.reapStage, ["warned_90d", "warned_104d"]),
      ),
    );

  await db
    .update(projects)
    .set({
      becameReapableAt: null,
      // Don't rescue archived/deleted projects automatically — those need a
      // deliberate restore flow. Just rewind in-progress warnings.
      reapStage: "active",
      lastReapWarningSentAt: null,
    })
    .where(
      and(
        eq(projects.userId, userId),
        inArray(projects.reapStage, ["active", "warned_90d", "warned_104d"]),
      ),
    );

  if (wasInWarning.length === 0) return;
  const contact = await getEmailForClerkUser(userId);
  if (!contact) return;
  for (const p of wasInWarning) {
    await sendRestoredEmail({
      to: contact.email,
      name: contact.name,
      projectName: p.name,
      projectId: p.id,
    }).catch((e) => console.warn("[clerk-webhook] restored email failed:", e));
  }
}
