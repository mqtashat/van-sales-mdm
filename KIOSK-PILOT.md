# INJAZ company home — 0.4.0-pilot (versionCode 7)

This is an opt-in, one-device pilot. Upgrading alone does not activate kiosk mode.

## Deployment order
1. Review/deploy **admin-web/firestore.rules** to the existing dashboard Firebase project. Do not deploy the root pilot rules over the dashboard rules: those deliberately do not grant web administrators access.
2. Build/deploy `admin-web` using its existing Firebase configuration flow. Source starts from the supplied dashboard archive `(5)`; no production data or configuration is bundled.
3. Optional immediate push: deploy the new `mdmKioskChanged` function from `functions`. The running foreground listener also observes kiosk policy changes; periodic sync is the fallback.
4. Update the existing test phone with the signed APK: `adb install -r -t app-debug.apk`.
5. Open INJAZ and synchronize once. The phone publishes its actual user-facing package inventory to `deviceAppInventory/{uid}`. Disabled/hidden apps are distinguishable; OS-only services are excluded. No fake app catalog is presented as an installed inventory.
6. Open device details → **شاشة الشركة**. Choose installed/enabled/unblocked apps and set/confirm a unique maintenance password (12+ characters). Save it securely before activation. Select at least one work app. Android 11+ and Device Owner required.
7. Enable, save, and wait for **phone confirmation**, not just saved policy. Check HOME returns to INJAZ; non-allowed apps/settings/store cannot open through recents/links; install UI is blocked; approved work apps still function. Check offline/reboot, blacklist/tethering independence, and local recovery.

## Maintenance and rollback
The company home has **دخول المدير للصيانة**. Password verification is PBKDF2-HMAC-SHA256, 120000 iterations, random 16-byte per-device salt; plaintext passwords are not stored or audited. Failed attempts are throttled and persisted. Correct recovery clears only kiosk-owned restrictions and preserves app hiding/tethering. The same policy revision cannot reactivate a device after local recovery; save a new revision from the panel to resume.

An administrator can install an additional app in local maintenance mode, then select it from the refreshed inventory and re-enable the company home. This release does **not** implement remote APK distribution or a Managed Google Play approval catalog. Allowing a package to run does not install it.

Remote disable is an explicit higher revision with `enabled: false`. Deleting/malformed/stale policies or network failures do not unlock the device. Kiosk configuration/status uses separate collections so old blacklist editors cannot erase it.

The lock task allowlist controls access to activities; essential system services continue in the background. It is not a claim that all non-allowlisted processes are terminated. Pilot keeps ADB access for recovery/testing; production USB hardening is not enabled yet. Notification shade/overview are disabled in lock task; power menu/keyguard are retained.

No production rules, functions, dashboard or device policies were deployed by creating this PR. CI tests cannot prove OEM launcher/lock-task behavior; one-device field validation remains required.
