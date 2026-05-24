/**
 * Server-side Convex Auth provisioning.
 *
 * Generates RSA signing keys and sets them (plus SITE_URL and CONVEX_SITE_URL)
 * on a Convex deployment via its own HTTP admin API — the same mechanism the
 * Convex CLI uses for `convex env set`. Called by the `setupAuth` agent tool
 * so credentials never enter the sandbox.
 */

import { generateKeyPairSync, createPublicKey } from "crypto";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { provisionConvexBackend } from "./convex-platform";

export interface ConvexAuthFile {
  path: string;
  content: string;
}

export interface SetupConvexAuthResult {
  ok: true;
  files: ConvexAuthFile[];
  packagesToInstall: string[];
  /** Rich reference context for the agent — patterns, snippets, env vars. */
  context: string;
}

export interface SetupConvexAuthError {
  ok: false;
  error: string;
}

function generateConvexAuthSecrets(): { privateKeyPem: string; jwksJson: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const pubKeyObj = createPublicKey(publicKey);
  const jwk = pubKeyObj.export({ format: "jwk" }) as Record<string, unknown>;
  const jwksJson = JSON.stringify({
    keys: [{ ...jwk, use: "sig", alg: "RS256", kid: "default" }],
  });

  return { privateKeyPem: privateKey, jwksJson };
}

function buildAuthBoilerplate(): ConvexAuthFile[] {
  return [
    {
      path: "convex/auth.config.ts",
      content: `// Required by @convex-dev/auth — tells Convex to trust JWTs issued by
// this deployment's own HTTP actions endpoint.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
`,
    },
    {
      path: "convex/auth.ts",
      content: `import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
});
`,
    },
    {
      path: "convex/http.ts",
      content: `import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();
auth.addHttpRoutes(http);

export default http;
`,
    },
    {
      path: "convex/schema.ts",
      content: `import { defineSchema } from "convex/server";
import { authTables } from "@convex-dev/auth/server";

const schema = defineSchema({
  ...authTables,
  // Add your own tables below
});

export default schema;
`,
    },
    {
      path: "convex/users.ts",
      content: `import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Returns the currently authenticated user document, or null if signed out.
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return userId !== null ? ctx.db.get(userId) : null;
  },
});
`,
    },
  ];
}

/**
 * Build the rich context string that helps the AI agent understand the full
 * Convex Auth surface: file roles, frontend wiring, provider patterns, and
 * how to protect queries/mutations.
 */
function buildAgentContext(convexSiteUrl: string): string {
  return `
=== CONVEX AUTH REFERENCE ===

ENVIRONMENT VARIABLES SET ON YOUR CONVEX DEPLOYMENT:
  JWT_PRIVATE_KEY          — RSA-2048 private key for signing auth JWTs
                             (this is the name @convex-dev/auth actually reads)
  CONVEX_AUTH_PRIVATE_KEY  — Same value, mirror name set for forward-compat
  JWKS                     — Public key set for JWT verification
  SITE_URL                 — Your frontend app URL (used in email links)

ENVIRONMENT VARIABLES AUTO-PROVIDED BY CONVEX (do not try to set these):
  CONVEX_SITE_URL          — ${convexSiteUrl}
                             Convex sets this automatically. auth.config.ts reads
                             process.env.CONVEX_SITE_URL to register the deployment
                             as its own trusted JWT issuer.

FILES WRITTEN (WRITE THESE EXACTLY AS PROVIDED IN THE files ARRAY):
  convex/auth.config.ts  — Registers this deployment as a trusted JWT issuer.
                           Must exist or auth will silently fail.
  convex/auth.ts         — Configures providers. Export: auth, signIn, signOut, store.
  convex/http.ts         — Mounts auth's OAuth callback/sign-out HTTP routes.
  convex/schema.ts       — Spreads authTables so built-in auth tables exist in DB.
  convex/users.ts        — viewer query: returns the current user doc (or null).

REQUIRED SEQUENCE AFTER WRITING FILES:
  1. pnpm add @convex-dev/auth @auth/core
  2. convexDeploy  ← MUST run this before the frontend can sign in
  3. After wiring the sign-in form, sign up with a test email then call
     getBrowserLog. If the catch handler fires, READ the logged error before
     deciding what to tell the user — do NOT assume "email taken." Most auth
     bugs surface as console errors here.

─────────────────────────────────────────────────────────────
BACKEND PATTERN — protecting queries and mutations:
─────────────────────────────────────────────────────────────

  import { query, mutation } from "./_generated/server";
  import { getAuthUserId } from "@convex-dev/auth/server";

  export const myProtectedQuery = query({
    handler: async (ctx) => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) throw new Error("Not authenticated");
      return ctx.db.get(userId);
    },
  });

  // getAuthUserId returns null when not authenticated — it never throws.
  // Always check for null before using the id.

─────────────────────────────────────────────────────────────
FRONTEND PATTERN — main.tsx setup:
─────────────────────────────────────────────────────────────

  import { ConvexAuthProvider } from "@convex-dev/auth/react";
  import { ConvexReactClient } from "convex/react";

  const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

  // Replace <ConvexProvider client={convex}> with:
  <ConvexAuthProvider client={convex}>
    <App />
  </ConvexAuthProvider>

─────────────────────────────────────────────────────────────
FRONTEND PATTERN — conditional rendering:
─────────────────────────────────────────────────────────────

  import { Authenticated, Unauthenticated, useQuery } from "convex/react";
  import { api } from "../convex/_generated/api";

  // Authenticated / Unauthenticated are convex/react components, not @convex-dev/auth
  <Authenticated>
    <Dashboard />
  </Authenticated>
  <Unauthenticated>
    <SignInPage />
  </Unauthenticated>

  // Get the current user:
  const user = useQuery(api.users.viewer); // null = signed out

─────────────────────────────────────────────────────────────
FRONTEND PATTERN — sign-in/sign-up form (Password provider):
─────────────────────────────────────────────────────────────

  import { useAuthActions } from "@convex-dev/auth/react";

  function SignInForm() {
    const { signIn } = useAuthActions();
    const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
    const [error, setError] = useState<string | null>(null);

    return (
      <form onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const formData = new FormData(e.currentTarget);
        formData.set("flow", flow);
        try {
          await signIn("password", formData);
          // On success: do NOT navigate or setState. The <Authenticated>
          // block in the parent will swap the view automatically.
        } catch (err) {
          // CRITICAL: log the error so you can diagnose with getBrowserLog.
          // Do NOT invent specific causes — @convex-dev/auth throws for many
          // reasons (validation, session conflict, token storage, etc.).
          // Use the hedged "may" phrasing from the official Convex example.
          console.error("Auth error:", err);
          setError(
            flow === "signIn"
              ? "Could not sign in. Check your email and password."
              : "Could not sign up. The email may already be in use, or your password may not meet requirements."
          );
        }
      }}>
        <input name="email" type="email" required />
        <input name="password" type="password" required minLength={8} />
        {/* CRITICAL: the "flow" field tells the server signIn vs signUp */}
        <input name="flow" value={flow} type="hidden" />
        {error && <div role="alert">{error}</div>}
        <button type="submit">{flow === "signIn" ? "Sign in" : "Sign up"}</button>
        <button type="button" onClick={() => { setFlow(f => f === "signIn" ? "signUp" : "signIn"); setError(null); }}>
          {flow === "signIn" ? "Need an account?" : "Have an account?"}
        </button>
      </form>
    );
  }

─────────────────────────────────────────────────────────────
FRONTEND PATTERN — sign out:
─────────────────────────────────────────────────────────────

  const { signOut } = useAuthActions();
  <button onClick={() => void signOut()}>Sign out</button>

─────────────────────────────────────────────────────────────
ADDING OAUTH PROVIDERS (Google):
─────────────────────────────────────────────────────────────

  THIS PLATFORM PROVIDES A DEDICATED TOOL: setupOAuthProvider
  DO NOT use bash or npx convex env set to set OAuth credentials.
  The setupOAuthProvider tool handles credential collection securely
  via a modal in the user's workspace.

  CORRECT SEQUENCE FOR GOOGLE SIGN-IN:

  Step 1 — Call setupOAuthProvider({ provider: "google" }).
           This opens a modal in the workspace where the user pastes their
           Google OAuth Client ID and Client Secret. The tool BLOCKS until
           the user completes or dismisses the modal (up to 5 minutes).
           The credentials are saved as AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET
           on the Convex deployment — you never see them.

           The modal shows the user the redirect URI they need to register
           in Google Cloud Console: ${convexSiteUrl}/api/auth/callback/google
           (this URL is stable and never changes for this project).

  Step 2 — After setupOAuthProvider returns ok: true, update convex/auth.ts:
           import Google from "@auth/core/providers/google";
           // add Google to the providers array alongside Password

  Step 3 — Run convexDeploy to push the updated auth config.

  Step 4 — Add a Google sign-in button to the UI:
           const { signIn } = useAuthActions();
           <button onClick={() => void signIn("google")}>Sign in with Google</button>

  If the user clicks Cancel in the modal, setupOAuthProvider returns
  ok: false. In that case, do NOT retry automatically — just acknowledge
  the cancellation and continue with other work.

─────────────────────────────────────────────────────────────
ADDING ANONYMOUS AUTH:
─────────────────────────────────────────────────────────────

  Add to convex/auth.ts:
    import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
    // add Anonymous to providers array

  Frontend:
    <button onClick={() => void signIn("anonymous")}>Continue as guest</button>

  Upgrade anonymous → real user later:
    // Sign in with any real provider while already signed in as anonymous
    // @convex-dev/auth merges the sessions automatically

─────────────────────────────────────────────────────────────
IMPORTANT NOTES:
─────────────────────────────────────────────────────────────
  - convexDeploy MUST be run after every edit to files in /convex
  - The Password provider's "flow" hidden input ("signIn" | "signUp") is mandatory
  - getAuthUserId() returns null (never throws) — always null-check the result
  - CONVEX_SITE_URL ends in .convex.site; VITE_CONVEX_URL ends in .convex.cloud
  - OAuth providers need their own env vars set on the Convex deployment (not .env)
  - authTables in schema.ts stores users, sessions, accounts, verifications
`.trim();
}

/**
 * Set environment variables on a Convex deployment using its own HTTP admin API.
 * This is the same mechanism the Convex CLI uses for `convex env set`.
 */
async function setEnvVarsViaDeployKey(
  deploymentUrl: string,
  deployKey: string,
  vars: Record<string, string>,
): Promise<void> {
  const changes = Object.entries(vars).map(([name, value]) => ({ name, value }));
  const response = await fetch(`${deploymentUrl}/api/update_environment_variables`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${deployKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ changes }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to set Convex env vars (${response.status}): ${errorText}`);
  }
}

export async function setupConvexAuth(
  projectId: string,
  opts: { siteUrl: string; userConvexOAuthToken?: string | null },
): Promise<SetupConvexAuthResult | SetupConvexAuthError> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));

  if (!project) {
    return { ok: false, error: "Project not found." };
  }
  if (project.backendType === "none") {
    return { ok: false, error: "This project has no backend — Convex Auth is not available." };
  }

  // Resolve deploy URL and key based on backend type
  let deployUrl: string | null;
  let deployKey: string | null;

  if (project.backendType === "user") {
    deployUrl = project.userConvexUrl ?? null;
    deployKey = project.userConvexDeployKey ?? null;
    if (!deployUrl || !deployKey) {
      return {
        ok: false,
        error: "No Convex deployment is linked to this project. Connect your Convex account in Settings.",
      };
    }
  } else {
    // Platform backend — auto-provision if not yet created
    deployUrl = project.convexDeployUrl ?? null;
    deployKey = project.convexDeployKey ?? null;

    if (!project.convexDeploymentId || !deployKey) {
      const convexProjectName = `ide-${project.id.slice(0, 8)}`;
      const convex = await provisionConvexBackend(convexProjectName);
      await db.update(projects)
        .set({
          convexProjectId: convex.projectId,
          convexDeploymentId: convex.deploymentId,
          convexDeployUrl: convex.deployUrl,
          convexDeployKey: convex.deployKey,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));
      deployUrl = convex.deployUrl;
      deployKey = convex.deployKey;
    }

    if (!deployUrl) {
      deployUrl = `https://${project.convexDeploymentId}.convex.cloud`;
    }
  }

  if (!deployKey) {
    return { ok: false, error: "No Convex deploy key available. Try reconnecting your Convex backend in Settings." };
  }

  // CONVEX_SITE_URL is auto-provided by Convex (built-in env var, cannot be set).
  // Compute it here only for use in agent-facing docs (OAuth callback URLs).
  const convexSiteUrl = deployUrl.replace(".convex.cloud", ".convex.site");

  const { privateKeyPem, jwksJson } = generateConvexAuthSecrets();

  // @convex-dev/auth reads JWT_PRIVATE_KEY (matches the official `npx
  // @convex-dev/auth` setup script). We also set CONVEX_AUTH_PRIVATE_KEY for
  // forward-compatibility in case a future version renames it.
  await setEnvVarsViaDeployKey(deployUrl, deployKey, {
    JWT_PRIVATE_KEY: privateKeyPem,
    CONVEX_AUTH_PRIVATE_KEY: privateKeyPem,
    JWKS: jwksJson,
    SITE_URL: opts.siteUrl,
  });

  // Mark the project as having auth configured so the workspace can show
  // the OAuth provider modal UI and SITE_URL auto-refresh can run.
  await db.update(projects)
    .set({ authConfigured: true, updatedAt: new Date() })
    .where(eq(projects.id, projectId));

  return {
    ok: true,
    files: buildAuthBoilerplate(),
    packagesToInstall: ["@convex-dev/auth", "@auth/core"],
    context: buildAgentContext(convexSiteUrl),
  };
}

/**
 * Re-set SITE_URL on a deployment whenever the frontend URL changes (e.g.
 * every time the dev server starts). No-ops silently when auth is not yet
 * configured or the project has no deploy key.
 */
export async function refreshAuthSiteUrl(
  projectId: string,
  newSiteUrl: string,
): Promise<void> {
  try {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project?.authConfigured) return; // nothing to refresh

    const deployUrl = project.userConvexUrl ?? project.convexDeployUrl ?? null;
    const deployKey = project.userConvexDeployKey ?? project.convexDeployKey ?? null;
    if (!deployUrl || !deployKey) return;

    await setEnvVarsViaDeployKey(deployUrl, deployKey, { SITE_URL: newSiteUrl });
  } catch (err) {
    // Non-fatal — a stale SITE_URL only breaks magic links, not password auth.
    console.warn("[refreshAuthSiteUrl] non-fatal error:", err);
  }
}

/**
 * Set OAuth provider credentials (CLIENT_ID / CLIENT_SECRET) on the Convex
 * deployment. Called server-side after the user fills in the workspace modal.
 */
export async function setOAuthProviderEnvVars(
  projectId: string,
  provider: "google",
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("Project not found.");

  const deployUrl = project.userConvexUrl ?? project.convexDeployUrl ?? null;
  const deployKey = project.userConvexDeployKey ?? project.convexDeployKey ?? null;
  if (!deployUrl || !deployKey) {
    throw new Error("No Convex deployment is configured for this project.");
  }

  const vars: Record<string, string> =
    provider === "google"
      ? { AUTH_GOOGLE_ID: clientId, AUTH_GOOGLE_SECRET: clientSecret }
      : {};

  if (Object.keys(vars).length === 0) {
    throw new Error(`Unknown OAuth provider: ${provider}`);
  }

  await setEnvVarsViaDeployKey(deployUrl, deployKey, vars);
}
