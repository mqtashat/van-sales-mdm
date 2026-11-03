# INJAZ MDM 0.3 pilot — one-time push setup

## Scope and compatibility

The Android package and signing key are unchanged. Install over 0.2, preserving
Device Owner, anonymous UID, local restrictions and policies:

```powershell
.\adb.exe install --no-streaming -r -t "C:\path\app-debug.apk"
```

This is still a debug/testOnly pilot, not a hardened production fleet release.
Do not uninstall, clear app data, reset the phone, or create another anonymous UID.
Open once after upgrade to confirm notification permission and register FCM. Afterwards,
policy changes in the existing dashboard automatically trigger the backend. No dashboard
code change is required: `deviceStatus.applied_revision` and `error` remain the only
policy-application acknowledgement. A push accepted by FCM is not delivery or enforcement.

## Deploy backend once in the EXISTING vansales-mdm project

Cloud Functions deployment needs Firebase Blaze billing and an account with deployment
permissions. Budget alerts are NOT a spending cap. Functions use maxInstances=2 each,
no minimum warm instances and a 60 second timeout; four functions are deployed.
No service-account private key belongs in the APK, dashboard, GitHub source or this archive.
The deployed runtime uses its platform identity. Anonymous clients authenticate only to
the registration callable; it verifies their existing enrollment server-side.

Use the `injaz-mdm-push-server` CI artifact (extract the ZIP), or this branch checkout.
In an authenticated Google Cloud Shell terminal in that directory:

```sh
npm ci --prefix functions --ignore-scripts
npm --prefix functions test
npx firebase-tools login --no-localhost
npx firebase-tools deploy --config firebase.push.json --only functions:mdm-push --project vansales-mdm
```

If Cloud Shell already has working Firebase CLI authentication, skip login.
Use exactly the functions-only config/target above. Do NOT run a bare `firebase deploy`.
The repository's `firestore.rules` predates the web dashboard's production rules:
DO NOT replace the live rules with that file. This change never deploys rules.

New `devicePush/{uid}` documents contain private routing tokens. Existing production rules
must default-deny unknown collections (as in the supplied dashboard rules). Verify there
is no permissive wildcard allowing clients to read/write `devicePush`. No new client rule
is needed. The Admin SDK registration callable writes it, and server triggers read it.
Existing enrollments/policies/deviceStatus fields and rules stay unchanged.

In Google Cloud/Firebase, verify the Firebase Cloud Messaging API is enabled. The deployed
function runtime identity must have cloudmessaging.messages.create (Firebase Cloud Messaging
API Admin role) plus Firestore access. Do not grant broad project Owner to solve IAM errors.
A missing API/permission is an explicit deployment/runtime error, not an APK issue.
Callable and Android region: us-central1. Changing the callable region requires rebuilding
Android's PushRegistration region too.

## Flow and limits

1. An approved Device Owner obtains an FCM token and calls registerMdmPush.
2. Server uses request.auth.uid, never a caller-provided UID. No client can self-approve.
3. Policy writes, re-approval, or initial/rotated token registration send a data-only hint.
4. Android checks the hint UID/type, displays an administrative update notification,
   starts/reuses its eligible foreground service, and reads current approval + policy
   using Source.SERVER. An expedited WorkManager fallback is requested for high-priority
   delivery. Revocation preserves previously enforced restrictions.
5. Backend reads current state on each event, tolerates unordered/duplicate events and
   retries transient failures for up to the one-hour event age cutoff. Invalid-token cleanup
   compares the attempted token transactionally so it cannot erase a newly rotated token.
6. Token registration refreshes once daily while syncing, after token rotation, or after
   notification capability changes. Timestamp-only registration writes do not send hints.

High-priority messages correspond to a visible policy-update notice; when notification
permission/channel is disabled, registration requests normal priority. FCM can still delay
or lower priority, especially if permissions change after registration. It is not a guaranteed
real-time transport. No policy, token, or credentials are included in application logs.

Application startup also listens for restoration of Firebase identity, attempts eligible
foreground-service recovery, and retains BOOT_COMPLETED/package-replaced and periodic backup
paths. This addresses a missed early-identity check but is not proof of the OEM failure cause.
The first unlock after reboot is required; direct-boot delivery is not implemented.
Force-stop, offline devices, and OEM power restrictions can still prevent immediate delivery.

## Test before fleet rollout

- Confirm 0.5.0-pilot, same UID, owner active, notifications allowed, registration successful.
- Close UI, unplug USB, lock screen; save both allow and block policies and record ack delay.
- Restart; unlock once without opening agent; change policy and verify applied_revision.
- Disconnect all internet; change policy; reconnect and verify latest policy catches up.
- Repeat after at least 30–60 minutes idle unplugged; check actual hotspot restriction.
- Verify token rotation/re-approval and backend logs; monitor battery/data over a workday.
- Tests/CI prove code paths and build/signature, not OEM physical-device reliability.

## Server-side APK Inspection & Isolated Cloud Run Container Runtime

Cryptographic APK verification (`v1`/`v2`/`v3`) and binary `AndroidManifest.xml` extraction are executed exclusively on the server using the official Android `apksigner` tool (`functions/bin/apksigner.jar`).

1. **Delivery Artifact Completeness**:
   - The `injaz-mdm-push-server` artifact includes `functions/bin/apksigner.jar`, `functions/Dockerfile`, and `functions/cloudRunInspectorServer.js`, alongside all Cloud Functions triggers (`registerMdmPush`, `inspectCompanyApk`, `getTaskDownloadAuthorization`, `mdmPolicyChanged`, `mdmEnrollmentChanged`, `mdmPushRegistered`, `mdmKioskChanged`, `cleanupOldLocationPoints`, `onCommandCompletedKioskSync`, `onInventoryUpdatedKioskSync`).
2. **Isolated Cloud Run Container Option (Guaranteed JRE + `apksigner.jar`)**:
   - Because standard managed Cloud Functions Node buildpacks may not guarantee a system `java` binary in every environment, `functions/Dockerfile` and `functions/cloudRunInspectorServer.js` provide a self-contained Cloud Run container bundling Node.js 22 + OpenJDK 17 Headless JRE + `functions/bin/apksigner.jar`.
   - Deploy from the extracted `injaz-mdm-push-server` artifact directory when ready (do NOT run automatically in CI/dev):
     ```sh
     gcloud run deploy injaz-apk-inspector \
       --source functions \
       --region us-central1 \
       --project vansales-mdm \
       --max-instances=2 \
       --memory=512Mi
     ```
   - The service requires a verified Firebase Auth ID token (`Authorization: Bearer <token>`), enforces `verifyAdminAuth` (verified email + `admin === true` or `/admins/{uid}.active === true`), binds the verified status to the exact Storage path, object `generation`, and `sha256_apk`, and fails closed (`inspection_status: 'pending_inspection'`, `inspected_by_server: false`) if the inspection runtime is unavailable—never falling back to heuristic or client-side approval.

