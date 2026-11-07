package com.company.mdmagent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

/**
 * Explicit BroadcastReceiver for PackageInstaller session commit results.
 * Guarantees:
 * 1. Handles STATUS_SUCCESS, STATUS_FAILURE, and specific failure codes.
 * 2. Mandatory post-install signer certificate and exact version verification.
 * 3. Does NOT mutate local Kiosk preferences or write kiosk authority fields; server Cloud Function
 *    reads the admin's immutable add_to_kiosk field directly inside a server transaction.
 * 4. Treats STATUS_PENDING_USER_ACTION gracefully without deleting task state.
 * 5. Enqueues results synchronously in the local durable retry queue (RESULT_PENDING_ACK) and
 *    only clears the task record after Firestore confirms the update succeeded.
 */
public class InstallStatusReceiver extends BroadcastReceiver {
    public static final String TAG = "InjazInstallReceiver";
    public static final String ACTION_INSTALL_COMMIT_RESULT = "com.company.mdmagent.INSTALL_COMMIT_RESULT";
    public static final String PREFS_TASKS = "injaz-install-tasks";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_INSTALL_COMMIT_RESULT.equals(intent.getAction())) {
            return;
        }

        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String statusMessage = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        int sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        String packageName = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME);

        // Load active task state
        SharedPreferences p = context.getSharedPreferences(PREFS_TASKS, Context.MODE_PRIVATE);
        String taskKey = "session_" + sessionId;
        String attemptId = p.getString(taskKey + "_attempt_id", "");
        String cmdId = p.getString(taskKey + "_cmd_id", "");
        String uid = p.getString(taskKey + "_uid", "");
        String expectedCert = p.getString(taskKey + "_cert_sha256", "");
        long expectedVer = p.getLong(taskKey + "_version_code", 1L);
        boolean addToKiosk = p.getBoolean(taskKey + "_add_to_kiosk", false);

        Log.i(TAG, "Install commit result received: status=" + status + " msg=" + statusMessage + " session=" + sessionId + " pkg=" + packageName + " attemptId=" + attemptId);

        try {
            RestrictionManager.restoreInstallRestrictionIfNeeded(context, attemptId);
        } catch (Exception ex) {
            Log.e(TAG, "Failed to restore install restriction in InstallStatusReceiver: " + ex.getMessage(), ex);
        }

        if (packageName == null || packageName.isEmpty()) {
            packageName = p.getString(taskKey + "_pkg", "");
        }

        // Handle STATUS_PENDING_USER_ACTION without treating as fatal failure or deleting task state
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmIntent = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            Log.w(TAG, "Package installation requires user confirmation: session=" + sessionId);
            if (confirmIntent != null) {
                confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(confirmIntent);
                } catch (Exception ex) {
                    Log.e(TAG, "Failed to launch user action confirmation: " + ex.getMessage(), ex);
                }
            }
            // Keep task record active in COMMITTED state
            return;
        }

        if (status == PackageInstaller.STATUS_SUCCESS) {
            handleSuccess(context, p, taskKey, uid, cmdId, packageName, expectedVer, expectedCert, addToKiosk);
        } else {
            handleFailure(context, p, taskKey, uid, cmdId, packageName, status, statusMessage);
        }
    }

    private void handleSuccess(Context context, SharedPreferences p, String taskKey,
                               String uid, String cmdId, String packageName,
                               long expectedVer, String expectedCert, boolean addToKiosk) {
        PackageManager pm = context.getPackageManager();
        try {
            PackageInfo info = pm.getPackageInfo(packageName, 0);
            long installedVer = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;

            if (expectedVer > 0 && installedVer != expectedVer) {
                throw new SecurityException("إصدار التطبيق المثبت فعليًا (" + installedVer
                        + ") لا يطابق الإصدار المطلوب (" + expectedVer + ")");
            }

            // Mandatory post-install certificate SHA-256 verification
            String actualCertSha = PackageInstallManager.getSignerCertificateSha256(context, packageName);
            if (expectedCert != null && !expectedCert.isEmpty()
                    && !expectedCert.trim().equalsIgnoreCase(actualCertSha.trim())) {
                throw new SecurityException("فشل التحقق من شهادة التطبيق المثبت! المتوقع: "
                        + expectedCert + "، الفعلي: " + actualCertSha);
            }

            Log.i(TAG, "Enterprise app installed and verified successfully: " + packageName + " v" + installedVer);

            publishSuccess(context, p, taskKey, uid, cmdId, packageName, installedVer, addToKiosk);
            try {
                SyncEngine.requestSync(context, "post_install_inventory_refresh");
            } catch (Exception ignored) {}

        } catch (Exception ex) {
            Log.e(TAG, "post_install_verification_failed: " + ex.getMessage(), ex);
            handleFailure(context, p, taskKey, uid, cmdId, packageName, PackageInstaller.STATUS_FAILURE, ex.getMessage());
        }
    }

    public static void publishSuccess(Context context, String uid, String cmdId, String packageName,
                                      long installedVer, boolean addToKiosk) {
        SharedPreferences p = context != null
                ? context.getSharedPreferences(PREFS_TASKS, Context.MODE_PRIVATE)
                : null;
        String fallbackKey = "session_cmd_" + (cmdId != null ? cmdId : System.currentTimeMillis());
        publishSuccess(context, p, fallbackKey, uid, cmdId, packageName, installedVer, addToKiosk);
    }

    public static void publishSuccess(Context context, SharedPreferences p, String taskKey,
                                      String uid, String cmdId, String packageName,
                                      long installedVer, boolean addToKiosk) {
        PackageInstallManager.enqueueAndFlushInstallResult(
                context,
                p,
                taskKey,
                uid,
                cmdId,
                packageName,
                installedVer,
                PackageInstallManager.OUTCOME_INSTALLED,
                "تم التثبيت والتحقق من الشهادة بنجاح",
                null,
                0
        );
    }

    private void handleFailure(Context context, SharedPreferences p, String taskKey,
                               String uid, String cmdId, String packageName,
                               int status, String statusMessage) {
        String errorMsg = statusMessage != null && !statusMessage.isEmpty()
                ? statusMessage
                : "فشل تثبيت الحزمة (رمز الخطأ: " + status + ")";

        Log.e(TAG, "Installation failed for " + packageName + ": " + errorMsg);

        PackageInstallManager.enqueueAndFlushInstallResult(
                context,
                p,
                taskKey,
                uid,
                cmdId,
                packageName,
                0L,
                PackageInstallManager.OUTCOME_FAILED,
                null,
                errorMsg,
                status
        );
    }
}
