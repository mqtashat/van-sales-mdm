package com.company.mdmagent;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.UserManager;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Unified, multi-feature device restrictions manager.
 * Reconciles user restrictions from:
 * 1. Company Kiosk Policy (DISALLOW_INSTALL_APPS, DISALLOW_UNINSTALL_APPS, DISALLOW_INSTALL_UNKNOWN_SOURCES,
 *    DISALLOW_SAFE_BOOT, DISALLOW_ADD_USER, DISALLOW_CREATE_WINDOWS)
 * 2. Independent App Install Policy (DISALLOW_INSTALL_APPS, DISALLOW_INSTALL_UNKNOWN_SOURCES)
 * 3. Tethering Policy (DISALLOW_CONFIG_TETHERING)
 * 4. Location Policy (DISALLOW_CONFIG_LOCATION)
 *
 * Guarantees:
 * - Persistent ownership journal ("owned_restrictions").
 * - Pre-existing restrictions (not applied by Injaz) are NEVER removed.
 * - Lifting restrictions for one feature (e.g. Kiosk maintenance or disable) NEVER lifts restrictions
 *   still demanded by another active feature (e.g. independent install policy).
 */
public final class RestrictionManager {
    public static final String PREFS_NAME = "injaz-restrictions";
    public static final String KEY_OWNED_RESTRICTIONS = "owned_restrictions";
    public static final String KEY_SUSPENSION_ACTIVE = "install_suspension_active";
    public static final String KEY_SUSPENSION_CMD_ID = "install_suspension_cmd_id";
    public static final String KEY_SUSPENSION_ATTEMPT_ID = "install_suspension_attempt_id";
    public static final String KEY_SUSPENSION_SESSION_ID = "install_suspension_session_id";
    public static final String KEY_SUSPENSION_PKG = "install_suspension_pkg";
    public static final String KEY_SUSPENSION_TIME = "install_suspension_time";
    private static final long MAX_SUSPENSION_WINDOW_MS = 60000L; // 60 seconds
    private static final long SESSION_STALL_TIMEOUT_MS = 30L * 60L * 1000L;

    private static final Set<String> LIVE_IN_PROCESS_ATTEMPTS =
            Collections.synchronizedSet(new HashSet<>());

    interface RestrictionClearHook {
        void beforeClear(String restriction);
    }
    interface RestrictionPostClearHook {
        void afterClear(String restriction);
    }
    interface RestrictionApplyHook {
        void beforeApply(String restriction);
    }
    interface CommitInterceptor {
        boolean commit(SharedPreferences.Editor editor, String operation);
    }

    static RestrictionClearHook clearHookForTest;
    static RestrictionPostClearHook postClearHookForTest;
    static RestrictionApplyHook applyHookForTest;
    static CommitInterceptor commitInterceptorForTest;

    private RestrictionManager() {}

    private static boolean commitEditor(SharedPreferences.Editor editor, String operation) {
        if (commitInterceptorForTest != null) {
            return commitInterceptorForTest.commit(editor, operation);
        }
        return editor.commit();
    }

    public static void registerLiveAttempt(String attemptId) {
        if (attemptId != null && !attemptId.trim().isEmpty()) {
            LIVE_IN_PROCESS_ATTEMPTS.add(attemptId.trim());
        }
    }

    public static void unregisterLiveAttempt(String attemptId) {
        if (attemptId != null && !attemptId.trim().isEmpty()) {
            LIVE_IN_PROCESS_ATTEMPTS.remove(attemptId.trim());
        }
    }

    public static boolean isAttemptLiveInProcess(String attemptId) {
        if (attemptId == null || attemptId.trim().isEmpty()) return false;
        return LIVE_IN_PROCESS_ATTEMPTS.contains(attemptId.trim());
    }

    public static boolean hasAnyLiveInProcessAttempt() {
        return !LIVE_IN_PROCESS_ATTEMPTS.isEmpty();
    }

    public static void clearLiveAttemptsForTest() {
        LIVE_IN_PROCESS_ATTEMPTS.clear();
    }

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static Set<String> getOwnedRestrictions(Context context) {
        return prefs(context).getStringSet(KEY_OWNED_RESTRICTIONS, Collections.emptySet());
    }

    public static boolean isInstallRestrictionSuspended(Context context) {
        if (context == null) return false;
        SharedPreferences p = prefs(context);
        // Unclosed or partially-cleared suspension MUST remain active and block replacement
        // until a complete, verified restoration clears all suspension journal fields.
        return p.getBoolean(KEY_SUSPENSION_ACTIVE, false)
                || !p.getString(KEY_SUSPENSION_ATTEMPT_ID, "").trim().isEmpty()
                || !p.getString(KEY_SUSPENSION_CMD_ID, "").trim().isEmpty()
                || !p.getString("restriction_restoration_error", "").trim().isEmpty();
    }

    public static synchronized void bindSessionToAttempt(Context context, String attemptId, int sessionId) {
        if (context == null || attemptId == null || attemptId.trim().isEmpty() || sessionId < 0) {
            return;
        }
        SharedPreferences p = prefs(context);
        if (!p.getBoolean(KEY_SUSPENSION_ACTIVE, false)) {
            return;
        }
        String activeAttempt = p.getString(KEY_SUSPENSION_ATTEMPT_ID, "");
        if (!attemptId.trim().equals(activeAttempt)) {
            return;
        }
        boolean bound = commitEditor(
                p.edit().putInt(KEY_SUSPENSION_SESSION_ID, sessionId),
                "bind_session_to_attempt"
        );
        if (!bound) {
            throw new IllegalStateException("تعذر ربط معرف جلسة التثبيت بمعرف محاولة التنفيذ بشكل متزامن");
        }
    }

    public static synchronized void suspendInstallRestrictionForApprovedTask(Context context, String cmdId, String attemptId, String packageName) throws Exception {
        suspendInstallRestrictionForApprovedTask(context, cmdId, attemptId, packageName, -1);
    }

    public static synchronized void suspendInstallRestrictionForApprovedTask(Context context, String cmdId, String attemptId, String packageName, int sessionId) throws Exception {
        if (context == null) {
            throw new IllegalArgumentException("Context required for restriction suspension");
        }
        if (cmdId == null || cmdId.trim().isEmpty()) {
            throw new IllegalArgumentException("معرف أمر التثبيت (cmdId) فارغ أو مفقود؛ لا يمكن تعليق قيد التثبيت بدون مهمة محددة.");
        }
        if (attemptId == null || attemptId.trim().isEmpty()) {
            throw new IllegalArgumentException("معرف محاولة التنفيذ (attemptId) فارغ أو مفقود.");
        }
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(context, AdminReceiver.class);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) {
            throw new IllegalStateException("صلاحية Device Owner غير متوفرة لتعليق قيد التثبيت الإداري");
        }

        SharedPreferences p = prefs(context);

        // Prevent any second attempt from replacing active unclosed journal even if cmdId is the same
        if (isInstallRestrictionSuspended(context)) {
            String activeAttempt = p.getString(KEY_SUSPENSION_ATTEMPT_ID, "unknown");
            throw new IllegalStateException("توجد عملية تعليق قيد نشطة لمحاولة تنفيذ أخرى (" + activeAttempt + ")؛ يمنع بدء محاولة جديدة (" + attemptId + ") حتى لو كان معرف الأمر نفسه.");
        }

        // Check if Injaz actually owns DISALLOW_INSTALL_APPS (or if it was pre-existing before Injaz enrollment)
        Set<String> owned = getOwnedRestrictions(context);
        boolean inOwned = owned.contains(UserManager.DISALLOW_INSTALL_APPS);
        boolean inSystem = dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false);

        if (inSystem && !inOwned) {
            throw new IllegalStateException("قيد التثبيت مفعّل بموجب سياسة نظام غير مملوكة لـ Injaz؛ لا يمكن تعليق القيد.");
        }

        // Write persistent journal BEFORE clearing restriction
        SharedPreferences.Editor journalEditor = p.edit()
                .putBoolean(KEY_SUSPENSION_ACTIVE, true)
                .putString(KEY_SUSPENSION_CMD_ID, cmdId.trim())
                .putString(KEY_SUSPENSION_ATTEMPT_ID, attemptId.trim())
                .putString(KEY_SUSPENSION_PKG, packageName != null ? packageName : "")
                .putLong(KEY_SUSPENSION_TIME, System.currentTimeMillis());
        if (sessionId >= 0) {
            journalEditor.putInt(KEY_SUSPENSION_SESSION_ID, sessionId);
        } else {
            journalEditor.remove(KEY_SUSPENSION_SESSION_ID);
        }
        boolean saved = commitEditor(journalEditor, "save_suspension_journal");
        if (!saved) {
            throw new IllegalStateException("تعذر حفظ سجل تعليق قيد التثبيت بشكل متزامن");
        }

        try {
            if (clearHookForTest != null) {
                clearHookForTest.beforeClear(UserManager.DISALLOW_INSTALL_APPS);
            }
            dpm.clearUserRestriction(admin, UserManager.DISALLOW_INSTALL_APPS);
            if (postClearHookForTest != null) {
                postClearHookForTest.afterClear(UserManager.DISALLOW_INSTALL_APPS);
            }
            if (dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false)) {
                throw new IllegalStateException("فشل إزالة قيد التثبيت الفعلي عبر DPM");
            }
        } catch (Exception ex) {
            Exception restoreEx = null;
            try {
                boolean kioskActiveAndEnabled = KioskController.enabled(context) && !KioskController.inMaintenance(context);
                boolean blockAppInstalls = AppInstallPolicy.getLocal(context).blockAppInstalls;
                boolean blockTethering = dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING);
                boolean blockLocationConfig = LocationPolicy.getLocal(context).enabled;
                Set<String> required = computeRequiredRestrictionsInternal(context, kioskActiveAndEnabled, blockAppInstalls, blockTethering, blockLocationConfig, false);
                reconcile(context, required);
                if (required.contains(UserManager.DISALLOW_INSTALL_APPS)) {
                    if (!dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false)) {
                        throw new IllegalStateException("فشل تأكيد استعادة القيد بعد فشل التعليق");
                    }
                }
            } catch (Exception e) {
                restoreEx = e;
            }

            if (restoreEx != null) {
                // Retention: keep KEY_SUSPENSION_ACTIVE = true and store both primary and secondary error, verifying commit
                String combinedError = "فشل تعليق قيد التثبيت: " + ex.getMessage() + " | وفشلت محاولة الاستعادة: " + restoreEx.getMessage();
                boolean errorCommitted = commitEditor(
                        p.edit()
                                .putBoolean(KEY_SUSPENSION_ACTIVE, true)
                                .putString(KEY_SUSPENSION_CMD_ID, cmdId.trim())
                                .putString(KEY_SUSPENSION_ATTEMPT_ID, attemptId.trim())
                                .putString("restriction_restoration_error", combinedError),
                        "save_combined_error"
                );
                if (!errorCommitted) {
                    throw new IllegalStateException("تعذر حفظ سجل الخطأ المركب بشكل متزامن: " + combinedError, ex);
                }
                throw new IllegalStateException(combinedError, ex);
            } else {
                // Restoration succeeded and verified: clear journal
                boolean cleared = commitEditor(
                        p.edit()
                                .putBoolean(KEY_SUSPENSION_ACTIVE, false)
                                .remove(KEY_SUSPENSION_CMD_ID)
                                .remove(KEY_SUSPENSION_ATTEMPT_ID)
                                .remove(KEY_SUSPENSION_SESSION_ID)
                                .remove(KEY_SUSPENSION_PKG)
                                .remove(KEY_SUSPENSION_TIME)
                                .remove("restriction_restoration_error"),
                        "clear_rollback_journal"
                );
                if (!cleared) {
                    throw new IllegalStateException("تعذر مسح سجل التعليق الفاشل بشكل متزامن");
                }
                throw new IllegalStateException("فشل تعليق قيد التثبيت في DPM وتمت الاستعادة بنجاح: " + ex.getMessage(), ex);
            }
        }
    }

    public static synchronized void restoreInstallRestrictionIfNeeded(Context context, String expectedAttemptId) throws Exception {
        if (context == null) return;
        if (expectedAttemptId == null || expectedAttemptId.trim().isEmpty()) {
            // Anonymous or empty attemptId cannot clear or touch an active suspension!
            return;
        }
        if (!isInstallRestrictionSuspended(context)) {
            return;
        }
        SharedPreferences p = prefs(context);
        String activeAttempt = p.getString(KEY_SUSPENSION_ATTEMPT_ID, "");
        if (!expectedAttemptId.trim().equals(activeAttempt)) {
            // Ownership mismatch: do not touch or clear another attempt's suspension!
            return;
        }
        restoreInstallRestrictionInternal(context);
    }

    public static synchronized void restoreInstallRestrictionIfNeeded(Context context) throws Exception {
        restoreInstallRestrictionIfNeeded(context, null);
    }

    private static synchronized void restoreInstallRestrictionInternal(Context context) {
        if (context == null) return;
        SharedPreferences p = prefs(context);
        final String priorAttemptId = p.getString(KEY_SUSPENSION_ATTEMPT_ID, "");
        final String priorCmdId = p.getString(KEY_SUSPENSION_CMD_ID, "");
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(context, AdminReceiver.class);

        try {
            if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) {
                throw new IllegalStateException("صلاحية Device Owner غير متوفرة لاستعادة قيود النظام");
            }

            boolean kioskActiveAndEnabled = KioskController.enabled(context) && !KioskController.inMaintenance(context);
            boolean blockAppInstalls = AppInstallPolicy.getLocal(context).blockAppInstalls;
            boolean blockTethering = dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_CONFIG_TETHERING);
            boolean blockLocationConfig = LocationPolicy.getLocal(context).enabled;

            Set<String> required = computeRequiredRestrictionsInternal(
                    context,
                    kioskActiveAndEnabled,
                    blockAppInstalls,
                    blockTethering,
                    blockLocationConfig,
                    false
            );

            reconcile(context, required);

            if (required.contains(UserManager.DISALLOW_INSTALL_APPS)) {
                boolean verifiedApplied = dpm.getUserRestrictions(admin).getBoolean(UserManager.DISALLOW_INSTALL_APPS, false);
                if (!verifiedApplied) {
                    throw new IllegalStateException("فشل تأكيد استعادة قيد التثبيت عبر dpm.getUserRestrictions");
                }
            }

            boolean cleared = commitEditor(
                    p.edit()
                            .putBoolean(KEY_SUSPENSION_ACTIVE, false)
                            .remove(KEY_SUSPENSION_CMD_ID)
                            .remove(KEY_SUSPENSION_ATTEMPT_ID)
                            .remove(KEY_SUSPENSION_SESSION_ID)
                            .remove(KEY_SUSPENSION_PKG)
                            .remove(KEY_SUSPENSION_TIME)
                            .remove("restriction_restoration_error"),
                    "clear_suspension_journal"
            );
            if (!cleared) {
                throw new IllegalStateException("تعذر تحديث سجل استعادة القيود بشكل متزامن");
            }
        } catch (Exception ex) {
            String errorMsg = "فشلت استعادة حماية التثبيت: " + ex.getMessage();
            SharedPreferences.Editor errEditor = p.edit()
                    .putBoolean(KEY_SUSPENSION_ACTIVE, true)
                    .putString("restriction_restoration_error", errorMsg);
            if (priorAttemptId != null && !priorAttemptId.trim().isEmpty()) {
                errEditor.putString(KEY_SUSPENSION_ATTEMPT_ID, priorAttemptId.trim());
            }
            if (priorCmdId != null && !priorCmdId.trim().isEmpty()) {
                errEditor.putString(KEY_SUSPENSION_CMD_ID, priorCmdId.trim());
            }
            boolean errSaved = commitEditor(errEditor, "save_restore_error");
            if (!errSaved) {
                throw new IllegalStateException("فشلت الاستعادة وتعذر حفظ سجل الخطأ: " + errorMsg, ex);
            }
            throw new IllegalStateException(errorMsg, ex);
        }
    }

    /**
     * Recovers orphaned or legacy install restriction suspensions after process death.
     * Separates committed session tracking from install restriction restoration:
     * 1. Legacy or partially-cleared records without attemptId -> recovered immediately.
     * 2. In-process live execution (LIVE_IN_PROCESS_ATTEMPTS) -> protected during critical operations.
     * 3. After process death (not live in-process):
     *    - If boundSessionId is NOT a COMMITTED task in PREFS_TASKS (died before commit), abandon the uncommitted session.
     *    - If boundSessionId IS a COMMITTED task in PREFS_TASKS, keep the session and task record intact to receive its result.
     *    - In BOTH cases, immediately restore DISALLOW_INSTALL_APPS so the restriction never remains lifted awaiting session completion.
     * Propagates restoration exceptions without swallowing.
     */
    public static synchronized void recoverOrphanedSuspensionsIfNeeded(Context context) {
        if (context == null) return;
        if (!isInstallRestrictionSuspended(context)) {
            return;
        }
        SharedPreferences p = prefs(context);
        String activeAttempt = p.getString(KEY_SUSPENSION_ATTEMPT_ID, "");
        int boundSessionId = p.getInt(KEY_SUSPENSION_SESSION_ID, -1);

        // 1. Legacy record without attemptId: recover immediately through explicit recovery path
        if (activeAttempt == null || activeAttempt.trim().isEmpty()) {
            restoreInstallRestrictionInternal(context);
            return;
        }

        String trimmedAttempt = activeAttempt.trim();

        // 2. Live attempt currently executing in memory in this process: do NOT interfere
        if (isAttemptLiveInProcess(trimmedAttempt)) {
            return;
        }

        // 3. Process has died (attempt is not live in memory).
        // Do NOT leave DISALLOW_INSTALL_APPS lifted while waiting for a COMMITTED session result.
        // Only abandon boundSessionId if the process died before the task reached COMMITTED state.
        if (boundSessionId >= 0 && !isBoundSessionCommittedInTaskPrefs(context, trimmedAttempt, boundSessionId)) {
            try {
                PackageManager pm = context.getPackageManager();
                if (pm != null && pm.getPackageInstaller() != null) {
                    pm.getPackageInstaller().abandonSession(boundSessionId);
                }
            } catch (Exception ignored) {}
        }

        restoreInstallRestrictionInternal(context);
    }

    private static boolean isBoundSessionCommittedInTaskPrefs(Context context, String activeAttempt, int boundSessionId) {
        if (context == null || activeAttempt == null || activeAttempt.trim().isEmpty() || boundSessionId < 0) {
            return false;
        }
        SharedPreferences taskPrefs = context.getSharedPreferences(PackageInstallManager.PREFS_TASKS, Context.MODE_PRIVATE);
        String prefix = "session_" + boundSessionId;
        String state = taskPrefs.getString(prefix + "_state", "");
        if (!"COMMITTED".equals(state)) {
            return false;
        }
        String taskAttemptId = taskPrefs.getString(prefix + "_attempt_id", "");
        int taskSessionId = taskPrefs.getInt(prefix + "_session_id", -1);
        return activeAttempt.trim().equals(taskAttemptId) && taskSessionId == boundSessionId;
    }

    /**
     * Safely migrates legacy Kiosk-owned restrictions from injaz-kiosk into the unified manager
     * without treating existing Injaz restrictions as external pre-existing ones.
     */
    public static synchronized void migrateLegacyKioskRestrictions(Context context) {
        SharedPreferences legacyPrefs = context.getSharedPreferences(KioskController.PREFS, Context.MODE_PRIVATE);
        if (legacyPrefs.contains("owned_restrictions")) {
            Set<String> legacyOwned = legacyPrefs.getStringSet("owned_restrictions", Collections.emptySet());
            if (legacyOwned != null && !legacyOwned.isEmpty()) {
                SharedPreferences unifiedPrefs = prefs(context);
                Set<String> currentUnified = new HashSet<>(unifiedPrefs.getStringSet(KEY_OWNED_RESTRICTIONS, Collections.emptySet()));
                currentUnified.addAll(legacyOwned);
                unifiedPrefs.edit().putStringSet(KEY_OWNED_RESTRICTIONS, currentUnified).apply();
            }
        }
    }

    private static void requireSave(boolean ok) {
        if (!ok) throw new IllegalStateException("تعذر حفظ سجل ملكية قيود النظام");
    }

    public static Set<String> computeRequiredRestrictions(Context context,
                                                           boolean kioskActiveAndEnabled,
                                                           boolean blockAppInstalls,
                                                           boolean blockTethering,
                                                           boolean blockLocationConfig) {
        return computeRequiredRestrictionsInternal(context, kioskActiveAndEnabled, blockAppInstalls, blockTethering, blockLocationConfig, true);
    }

    private static Set<String> computeRequiredRestrictionsInternal(Context context,
                                                                   boolean kioskActiveAndEnabled,
                                                                   boolean blockAppInstalls,
                                                                   boolean blockTethering,
                                                                   boolean blockLocationConfig,
                                                                   boolean checkSuspension) {
        Set<String> required = new HashSet<>();

        if (blockTethering) {
            required.add(UserManager.DISALLOW_CONFIG_TETHERING);
        }

        if (blockLocationConfig) {
            required.add(UserManager.DISALLOW_CONFIG_LOCATION);
        }

        boolean suspendActive = checkSuspension && context != null && isInstallRestrictionSuspended(context);

        if (kioskActiveAndEnabled) {
            if (!suspendActive) {
                required.add(UserManager.DISALLOW_INSTALL_APPS);
            }
            required.add(UserManager.DISALLOW_UNINSTALL_APPS);
            required.add(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES);
            required.add(UserManager.DISALLOW_SAFE_BOOT);
            required.add(UserManager.DISALLOW_ADD_USER);
            required.add(UserManager.DISALLOW_CREATE_WINDOWS);
        }

        if (blockAppInstalls) {
            if (!suspendActive) {
                required.add(UserManager.DISALLOW_INSTALL_APPS);
            }
            required.add(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES);
        }

        return required;
    }

    /**
     * Atomically reconciles current system restrictions with the set of required restrictions.
     */
    public static synchronized void reconcile(Context context,
                                               Set<String> requiredRestrictions) throws Exception {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(context, AdminReceiver.class);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) {
            throw new IllegalStateException("صلاحية Device Owner غير متوفرة لإدارة قيود النظام");
        }

        SharedPreferences p = prefs(context);
        Set<String> previouslyOwned = new HashSet<>(p.getStringSet(KEY_OWNED_RESTRICTIONS, Collections.emptySet()));
        Bundle currentSystem = dpm.getUserRestrictions(admin);

        // 1. Identify new restrictions to apply and own
        Set<String> newlyOwned = new HashSet<>(previouslyOwned);
        for (String req : requiredRestrictions) {
            if (!currentSystem.getBoolean(req, false)) {
                newlyOwned.add(req);
            }
        }
        requireSave(commitEditor(p.edit().putStringSet(KEY_OWNED_RESTRICTIONS, newlyOwned), "save_owned_restrictions"));

        // 2. Apply all required restrictions
        List<String> applyErrors = new ArrayList<>();
        for (String req : requiredRestrictions) {
            try {
                if (applyHookForTest != null) {
                    applyHookForTest.beforeApply(req);
                }
                dpm.addUserRestriction(admin, req);
                if (!dpm.getUserRestrictions(admin).getBoolean(req, false)) {
                    applyErrors.add("applyFailed:" + req);
                }
            } catch (Exception ex) {
                applyErrors.add(req + ": " + ex.getMessage());
            }
        }
        if (!applyErrors.isEmpty()) {
            throw new IllegalStateException("فشل تطبيق بعض قيود النظام: " + String.join(", ", applyErrors));
        }

        // 3. Clear restrictions that are owned by Injaz but NO LONGER required by ANY active feature
        Set<String> toRemove = new HashSet<>(newlyOwned);
        toRemove.removeAll(requiredRestrictions);

        List<String> clearErrors = new ArrayList<>();
        Set<String> remainingOwned = new HashSet<>(newlyOwned);

        for (String rem : toRemove) {
            try {
                if (clearHookForTest != null) {
                    clearHookForTest.beforeClear(rem);
                }
                dpm.clearUserRestriction(admin, rem);
                if (dpm.getUserRestrictions(admin).getBoolean(rem, false)) {
                    clearErrors.add("clearFailed:" + rem);
                } else {
                    remainingOwned.remove(rem);
                }
            } catch (Exception ex) {
                clearErrors.add(rem + ": " + ex.getMessage());
            }
        }
        requireSave(commitEditor(p.edit().putStringSet(KEY_OWNED_RESTRICTIONS, remainingOwned), "save_remaining_owned_restrictions"));

        if (!clearErrors.isEmpty()) {
            throw new IllegalStateException("فشل إزالة بعض قيود النظام: " + String.join(", ", clearErrors));
        }
    }

    /**
     * Clears ALL Injaz-owned restrictions during authorized deprovisioning.
     * Pre-existing restrictions are untouched.
     */
    public static synchronized void clearAllOwned(Context context) throws Exception {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(context, AdminReceiver.class);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) {
            return;
        }

        SharedPreferences p = prefs(context);
        Set<String> owned = new HashSet<>(p.getStringSet(KEY_OWNED_RESTRICTIONS, Collections.emptySet()));
        List<String> errors = new ArrayList<>();
        Set<String> remaining = new HashSet<>(owned);

        for (String r : owned) {
            try {
                dpm.clearUserRestriction(admin, r);
                if (dpm.getUserRestrictions(admin).getBoolean(r, false)) {
                    errors.add("clearFailed:" + r);
                } else {
                    remaining.remove(r);
                }
            } catch (Exception ex) {
                errors.add(r + ": " + ex.getMessage());
            }
        }
        requireSave(commitEditor(p.edit().putStringSet(KEY_OWNED_RESTRICTIONS, remaining), "clear_all_owned"));
        if (!errors.isEmpty()) {
            throw new IllegalStateException("فشل إزالة بعض القيود المملوكة: " + String.join(", ", errors));
        }
    }
}
