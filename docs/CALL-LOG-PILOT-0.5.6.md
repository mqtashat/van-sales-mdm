# Call log compatibility pilot — 0.5.6 / versionCode 15

This release is phase one of the explicitly requested employee-call dashboard.
It does NOT implement fleet monitoring, background collection, upload, or web analytics.
The APK is based on 0.5.5 commit 5cb26ba; location sampling and filtering are unchanged.
Web presentation that recognizes adaptive location timing by exact version must also recognize
0.5.6-pilot after this release is validated (do not assume arbitrary future versions).

## Scope and access

- Non-exported CallLogPilotActivity, reachable from the maintenance screen.
- Requires Device Owner, locally cached enrollment approval for current UID, and active
  maintenance mode entered using the existing admin maintenance code.
- Explicit disclosure/confirmation before requesting READ_CALL_LOG; never auto-granted.
- Disabled by default. Session starts AFTER permission is granted; query DATE >= start.
- Only the session start, elapsed time, boot counter and owning UID are persisted.
- Calls are read on demand from Android's CallLog provider, displayed in memory, and
  cleared from the UI on leaving the activity. No content observer/background collection.
- Session expires after 24 hours or reboot; stop clears the local session, not system calls.
- Permission denial/null provider/cancelled read differ from a successful empty result.
- Maximum 100 displayed entries; 101st marks partial results. Dates shown Asia/Amman.
- No Firebase reads/writes by the reader, no names/contact lookup, audio, SMS, or raw logs.
- Android's restricted permission may require installer allowlisting. Do not bypass a
  refusal or change the default dialer. Validate standard installation on the test device.
- Local diagnostic does not establish readiness of background collection or all OEM models.

## Physical acceptance checklist (pending)

1. Retain the installed APK backup and existing signing identity. Enter maintenance.
2. Install the signed 0.5.6 pilot update; verify versionCode 15/versionName 0.5.6-pilot.
3. In maintenance choose «فتح اختبار المكالمات». Confirm disclosure and permission.
4. Note permission state. If denied, report that state; do not factory-reset or disable security.
5. With agreed test numbers, place a 20+ second outgoing call, receive an answered call,
   and leave one incoming call unanswered. Do not use emergency or premium-rate numbers.
6. Return to maintenance -> pilot -> «قراءة مكالمات الاختبار الآن».
7. Compare number, direction, time and duration to the native call log. Old calls must not appear.
8. Re-read: result reflects provider rows once, no accumulating duplicates.
9. Leave screen: previously displayed numbers disappear. Stop and re-enter: session disabled.
10. Restart test and reboot: session disabled. Verify company screen, app restrictions and
    location tracking still work. These are field checks, not claims from unit tests.

## Next stage only after permission/device check

Implement approved opt-in policy + visible employee disclosure, bounded offline queue,
strict Firestore policy/status/event contracts, server aggregates and retention, and the
Google AI Studio web dashboard prompt. Link employee numbers with effective dates; normalize
Jordan numbers while preserving unknown/private numbers; never infer SIM identity from a
missing field. A cross-device match is a candidate until confidently correlated; do not
silently double-count one internal call. Distinguish zero duration from confirmed answered.
No production rules changes are included in this pilot.
