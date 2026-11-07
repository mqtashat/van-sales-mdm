# Call log sync v1 — Android 0.5.7-pilot / versionCode 16

Draft integration, disabled by default. Requires current Studio dashboard/rules integration before activating. Do not deploy the repository's old root/admin-web rules over production.

## Delivery order
1. Give Google AI Studio AI-STUDIO-PROMPT-AR.md and firestore.calls.fragment.rules; apply to the CURRENT dashboard.
2. Review returned ZIP and actual emulator tests, then manually publish only reviewed Firestore rules to vansales-mdm.
3. Configure server TTL on collection group `calls`, field `expires_at`, after reviewing project scope. Example: `gcloud firestore fields ttls update expires_at --collection-group=calls --enable-ttl --project=vansales-mdm`. This command is NOT executed by this change. TTL is asynchronous; dashboard must hide records older than 30 days independently.
4. Install signed v16 APK with `adb install -r -t`. No uninstall/data reset.
5. In dashboard enable call policy for ONE approved company device. Explain collection to employee. On phone enter maintenance → إعداد مزامنة مكالمات الشركة → confirm activation. This is separate from the local pilot test.
6. Make new outgoing/incoming/missed calls, wait for call termination/provider save, then sync calls. Verify number/direction/duration and matching revision/session/status in dashboard. Old pilot calls must NOT upload.
7. Repeat sync: call document count must stay constant. Disable policy: next uploads rejected. Re-enable: new collection id and local confirmation required. Test offline then reconnect; calls must appear once. Test reboot, permission revocation, long idle, and two-device pair matching before fleet rollout.

## Behavior and limits
- Reuses existing sync executor/foreground service. Debounced call-provider observer (10 s) requests server-verified sync; existing WorkManager cycle (~15 min or longer under Android scheduling), manual sync, and network recovery provide fallback. Not a promise of real-time upload. If observer registration was denied before permission was granted, periodic/manual fallback remains until service recreation.
- Per sync up to 5 pages of 100 rows with `(DATE,_ID)` ascending checkpoint; explicit partial status. Checkpoint advances only after server transaction confirmation. Completed scans restart with a 24-hour overlap for late final duration/type updates. Very late provider edits older than that overlap are not guaranteed to update already-sent records.
- Calls are read from the system provider on reconnect; records deleted there before sync cannot be recovered. Recoverable window is at most 30 days and begins at local confirmation/server activation, whichever is later. No raw local private queue, contact database, audio, SMS or historical import.
- Provider ids reused with a different start time produce different hashed document ids. Retry writes the same id; a local digest cache avoids unchanged writes. Clearing cache can cause harmless overwrites; document identity remains stable.
- Cloud write transaction rechecks policy and local activation; rules recheck server enabled/session/approval. A local stop cannot retract an already submitted server write; disabling server policy also stops acceptance. Status older than policy must not imply current enforcement.
- Metadata only; no guaranteed WhatsApp/VoIP coverage. `duration=0` alone does not establish answered/unanswered. Source records are separate from dashboard pair-level deduplication.
- No production Firestore data, rules, TTL, functions, or website published by this PR. Existing Android location acquisition/filtering is unchanged.
