/**
 * Server-side Convex Auth provisioning.
 *
 * Generates RSA signing keys and sets them on a Convex deployment via the
 * Convex Management API. Called by the `setupAuth` agent tool so that
 * @convex-dev/auth can be used in the sandbox project without exposing keys.
 *
 * Platform-managed backends use the team token; BYOC backends use the
 * user's stored OAuth access token.
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
  nextSteps: string[];
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
  // Add your own tables here
});

export default schema;
`,
    },
  ];
}

/**
 * Set environment variables on a Convex deployment using its own HTTP API.
 * This mirrors what the Convex CLI does when running `convex env set`.
 *
 * URL format:  POST {deploymentUrl}/api/update_environment_variables
 * Auth format: Authorization: Convex {adminKey}
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

  const { privateKeyPem, jwksJson } = generateConvexAuthSecrets();

  await setEnvVarsViaDeployKey(deployUrl, deployKey, {
    CONVEX_AUTH_PRIVATE_KEY: privateKeyPem,
    JWKS: jwksJson,
    SITE_URL: opts.siteUrl,
  });

  return {
    ok: true,
    files: buildAuthBoilerplate(),
    packagesToInstall: ["@convex-dev/auth", "@auth/core"],
    nextSteps: [
      "Write each file in the `files` array to the project.",
      "Run: pnpm add @convex-dev/auth @auth/core",
      "Run convexDeploy to push the auth schema and functions.",
      "Wrap your app's root in <ConvexAuthProvider> from @convex-dev/auth/react in src/main.tsx.",
      "Build sign-in/sign-up UI using the useAuthActions hook from @convex-dev/auth/react.",
    ],
  };
}
