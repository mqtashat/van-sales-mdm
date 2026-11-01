# Android 0.2 pilot validation

This change imports the reviewed Android foreground-sync implementation. Firestore rules,
Firebase configuration, existing policies, and the web dashboard are unchanged.

## Signing

The CI build requires four GitHub Actions secrets: ANDROID_KEYSTORE_BASE64,
ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD.
The keystore is PKCS12. The expected public certificate SHA-256 is:
`9EDB78F38ADD9EEC104A510A5B7995EFFC1AA6B29C91081F6EB73144CB1AEED4`.
Missing or invalid credentials stop the build; CI must never substitute a random debug key.
The temporary keystore is removed and is never uploaded as an artifact.

## Dedicated test device only

The debug manifest sets android:testOnly=true. Install with adb install -t.
This allows the authorized tester to remove the test device owner via ADB if necessary.
This is not a production fleet release. The new key cannot update the previous differently
signed 0.1 APK in place. Do not wipe any device until a verified APK is available and the
owner has confirmed that its data can be erased. Re-enrollment creates a new Firebase UID.

## Required physical checks (not proven by unit tests)

- Confirm the foreground service and notification permission/channel status.
- Change policy while the app is in background and the screen is locked; record delay.
- Confirm requests settle without an ongoing self-triggered read/write loop.
- Disconnect/reconnect internet, switch network, and restart/unlock the device.
- Revoke enrollment; confirm service stops and applied restrictions remain.
- Re-approve; open the app or allow the backup worker to recover the service.
- Check OEM power management behavior and battery consumption over a workday.

Unit tests exercise queue and service-session logic, not Android/Firestore integration.
The old synthetic EnforcementSnapshot test helper was removed because production did not
call it and its test did not establish actual device-policy behavior.
