// Sets the `admin` claim gating /logger; needs ./service-account.json from the Firebase console.

import { readFileSync } from "node:fs";
import { cert, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const [, , email, valueArg] = process.argv;
if (!email) {
  console.error("usage: bun run set-admin <email> [true|false]");
  process.exit(1);
}
const admin = valueArg !== "false";

const serviceAccount = JSON.parse(
  readFileSync("./service-account.json", "utf-8"),
) as ServiceAccount;

initializeApp({ credential: cert(serviceAccount) });

const user = await getAuth().getUserByEmail(email);
await getAuth().setCustomUserClaims(user.uid, { admin });

console.log(
  `Set admin=${admin} on ${email} (uid: ${user.uid}). They need to sign out and back in, click "Check again" on the access-pending screen, or wait up to an hour for the token to refresh.`,
);
