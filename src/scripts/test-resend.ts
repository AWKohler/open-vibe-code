/**
 * Smoke-test the Resend integration by sending the three reaper email
 * templates to a single recipient.
 *
 *   tsx src/scripts/test-resend.ts you@example.com
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { sendWarn90Email, sendWarn104Email, sendRestoredEmail } from "@/lib/reaper/emails";

const to = process.argv[2];
if (!to || !to.includes("@")) {
  console.error("usage: tsx src/scripts/test-resend.ts <email>");
  process.exit(1);
}

const PROJECT_NAME = "Reaper Test Project";
const PROJECT_ID = "00000000-0000-0000-0000-000000000000";
const NAME = "Andrew";

(async () => {
  const stamp = new Date().toISOString();
  console.log(`Sending three test emails to ${to} (${stamp})...`);

  const r1 = await sendWarn90Email({
    to,
    name: NAME,
    projectName: `${PROJECT_NAME} (warn-90)`,
    projectId: PROJECT_ID,
  });
  console.log("warn90:", r1);

  const r2 = await sendWarn104Email({
    to,
    name: NAME,
    projectName: `${PROJECT_NAME} (warn-104)`,
    projectId: PROJECT_ID,
  });
  console.log("warn104:", r2);

  const r3 = await sendRestoredEmail({
    to,
    name: NAME,
    projectName: `${PROJECT_NAME} (restored)`,
    projectId: PROJECT_ID,
  });
  console.log("restored:", r3);

  const allOk = r1.ok && r2.ok && r3.ok;
  process.exit(allOk ? 0 : 1);
})().catch((e) => {
  console.error("test-resend crashed:", e);
  process.exit(1);
});
