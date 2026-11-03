package com.company.mdmagent;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.FirebaseApp;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.auth.GetTokenResult;
import com.google.firebase.firestore.DocumentSnapshot;
import com.google.firebase.firestore.FieldValue;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.Source;
import com.google.firebase.functions.FirebaseFunctions;
import com.google.firebase.functions.HttpsCallableResult;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Enterprise Application Package Installer and Verification Manager.
 * Guarantees:
 * 1. Verification of command expiration, cancellation, and device approval before download AND right before session.commit().
 * 2. Distinguishes between "installed_new_or_updated" («تم التثبيت») and "already_installed" («الإصدار المطلوب موجود مسبقًا»).
 * 3. Protected task-bound download:
 *    - Validates HTTPS protocol and strict Google/Firebase Storage host allowlist; rejects any external download_url.
 *    - Never sends Firebase ID token with a pre-signed download URL (storage.googleapis.com with X-Goog-Signature).
 *    - Only attaches Firebase ID token to firebasestorage.googleapis.com for a validated company_apps/ object path when not pre-signed.
 *    - Disables automatic HTTP redirects (setInstanceFollowRedirects(false)) and rejects 3xx responses to prevent cross-host token leak.
 * 4. File SHA-256 verification against server-inspected authoritative record.
 * 5. Pre-session verification of package name, version, and mandatory signer certificate SHA-256 from downloaded archive.
 * 6. Synchronous (.commit()) persistence of session task state before session.commit() with result verification.
 * 7. Durable local result queue (RESULT_PENDING_ACK) that preserves task records until Firestore acknowledgement.
 * 8. Recovery of active, stalled, and completed PackageInstaller sessions upon process restart.
 */
public final class PackageInstallManager {
    public static final String TAG = "InjazPkgInstaller";
    public static final String ACTION_INSTALL_COMPLETE = "com.company.mdmagent.INSTALL_COMMIT_RESULT";
    public static final String PREFS_TASKS = "injaz-install-tasks";

    public static final String OUTCOME_INSTALLED = "installed_new_or_updated";
    public static final String OUTCOME_ALREADY_INSTALLED = "already_installed";
    public static final String OUTCOME_FAILED = "failed";

    private static final long SESSION_STALL_TIMEOUT_MS = 30L * 60L * 1000L;

    private static final ExecutorService INSTALL_EXECUTOR =
            Executors.newSingleThreadExecutor();

    public interface InstallCallback {
        void onProgress(String status);
        void onSuccess(String packageName, int versionCode);
        void onFailure(String error);
    }

    /**
     * Immutable representation of a validated download target and its authentication policy.
     */
    public static final class ValidatedDownloadTarget {
        public final String url;
        public final String host;
        public final boolean isSignedStorageUrl;
        public final boolean requiresFirebaseAuthToken;

        public ValidatedDownloadTarget(
                String url,
                String host,
                boolean isSignedStorageUrl,
                boolean requiresFirebaseAuthToken
        ) {
            this.url = url;
            this.host = host;
            this.isSignedStorageUrl = isSignedStorageUrl;
            this.requiresFirebaseAuthToken = requiresFirebaseAuthToken;
        }
    }

    private PackageInstallManager() {}

    public static String computeFileSha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream is = new FileInputStream(file)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) {
                digest.update(buf, 0, n);
            }
        }
        byte[] hash = digest.digest();
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    public static String getSignerCertificateSha256(Context context, String packageName) throws Exception {
        PackageManager pm = context.getPackageManager();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageInfo info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES);
            SigningInfo signingInfo = info.signingInfo;
            if (signingInfo == null) return "";
            Signature[] sigs = signingInfo.hasMultipleSigners()
                    ? signingInfo.getApkContentsSigners()
                    : signingInfo.getSigningCertificateHistory();
            if (sigs == null || sigs.length == 0) return "";
            return computeCertDigest(sigs[0]);
        } else {
            PackageInfo info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES);
            if (info.signatures == null || info.signatures.length == 0) return "";
            return computeCertDigest(info.signatures[0]);
        }
    }

    public static String extractArchiveSignerSha256(Context context, File apkFile) throws Exception {
        PackageManager pm = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;

        PackageInfo info = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
        if (info == null) {
            throw new IllegalArgumentException("الملف المنزّل ليس ملف حزمة Android APK صالح");
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningInfo signingInfo = info.signingInfo;
            if (signingInfo != null) {
                Signature[] sigs = signingInfo.hasMultipleSigners()
                        ? signingInfo.getApkContentsSigners()
                        : signingInfo.getSigningCertificateHistory();
                if (sigs != null && sigs.length > 0) {
                    return computeCertDigest(sigs[0]);
                }
            }
        }

        if (info.signatures != null && info.signatures.length > 0) {
            return computeCertDigest(info.signatures[0]);
        }

        return "";
    }

    private static String computeCertDigest(Signature sig) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] digest = md.digest(sig.toByteArray());
        StringBuilder sb = new StringBuilder();
        for (byte b : digest) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    /**
     * Strictly validates a download URL before opening any network connection:
     * 1. Requires HTTPS scheme; rejects http, file, javascript, etc.
     * 2. Rejects embedded userInfo (user@host) and non-443 ports.
     * 3. Enforces a strict host allowlist: ONLY firebasestorage.googleapis.com or storage.googleapis.com
     *    (or <bucket>.storage.googleapis.com). Any external/arbitrary download_url throws SecurityException!
     * 4. Prevents path traversal ("..") and requires a valid company_apps/ object path.
     * 5. Determines whether the URL is a pre-signed URL (X-Goog-Signature / Signature):
     *    - Pre-signed URLs NEVER receive the Firebase ID token (requiresFirebaseAuthToken = false).
     *    - Only non-signed firebasestorage.googleapis.com URLs for the expected bucket and company_apps/ path
     *      may receive the Firebase ID token (requiresFirebaseAuthToken = true).
     */
    public static ValidatedDownloadTarget validateAndClassifyDownloadUrl(
            String candidateUrl,
            String expectedBucket,
            String expectedAppId
    ) {
        if (candidateUrl == null || candidateUrl.trim().isEmpty()) {
            throw new SecurityException("رفض أمني: رابط التنزيل فارغ أو مفقود.");
        }
        URI uri;
        try {
            uri = new URI(candidateUrl.trim());
        } catch (Exception ex) {
            throw new SecurityException("رفض أمني: صيغة رابط التنزيل غير صالحة.");
        }

        String scheme = uri.getScheme();
        if (scheme == null || !"https".equalsIgnoreCase(scheme)) {
            throw new SecurityException("رفض أمني: يُسمح فقط ببروتوكول HTTPS لتنزيل الحزم المعتمدة.");
        }
        if (uri.getRawUserInfo() != null && !uri.getRawUserInfo().isEmpty()) {
            throw new SecurityException("رفض أمني: يُمنع تضمين بيانات مستخدم (userInfo) في رابط التنزيل.");
        }
        int port = uri.getPort();
        if (port != -1 && port != 443) {
            throw new SecurityException("رفض أمني: منفذ الاتصال (" + port + ") غير مسموح به.");
        }

        String host = uri.getHost();
        if (host == null || host.trim().isEmpty()) {
            throw new SecurityException("رفض أمني: مضيف رابط التنزيل مفقود.");
        }
        String normalizedHost = host.trim().toLowerCase(Locale.US);
        String cleanBucket = expectedBucket != null ? expectedBucket.trim().toLowerCase(Locale.US) : "";

        boolean isFirebaseStorageHost = "firebasestorage.googleapis.com".equals(normalizedHost);
        boolean isGcsHost = "storage.googleapis.com".equals(normalizedHost)
                || (!cleanBucket.isEmpty() && (cleanBucket + ".storage.googleapis.com").equals(normalizedHost));

        if (!isFirebaseStorageHost && !isGcsHost) {
            throw new SecurityException("رفض أمني: المضيف الخارجي (" + normalizedHost
                    + ") غير مدرج في قائمة مضيفي التخزين الموثوقين؛ يُمنع تنزيل الحزمة أو إرسال توكن المصادقة إليه.");
        }

        String rawPath = uri.getRawPath() != null ? uri.getRawPath() : "";
        String decodedPath;
        try {
            decodedPath = URLDecoder.decode(rawPath, "UTF-8");
        } catch (Exception ex) {
            decodedPath = rawPath;
        }
        if (rawPath.contains("..") || decodedPath.contains("..")) {
            throw new SecurityException("رفض أمني: مسار التنزيل يحتوي على تسلسل اجتياز مسار غير مسموح (..).");
        }

        String requiredPrefix = (expectedAppId != null && !expectedAppId.trim().isEmpty())
                ? "company_apps/" + expectedAppId.trim() + "/"
                : "company_apps/";
        if (!decodedPath.contains(requiredPrefix)) {
            throw new SecurityException("رفض أمني: مسار الملف في الرابط لا يطابق مسار تطبيق الشركة المعتمد (" + requiredPrefix + ").");
        }

        String rawQuery = uri.getRawQuery() != null ? uri.getRawQuery() : "";
        boolean hasPreSignedParams = rawQuery.contains("X-Goog-Signature=")
                || rawQuery.contains("x-goog-signature=")
                || rawQuery.contains("Signature=")
                || rawQuery.contains("GoogleAccessId=");

        if (isGcsHost) {
            if (!hasPreSignedParams) {
                throw new SecurityException("رفض أمني: رابط storage.googleapis.com يجب أن يكون موقعًا مسبقًا من الخادم (X-Goog-Signature).");
            }
            // Pre-signed GCS URLs NEVER need or receive the Firebase ID token!
            return new ValidatedDownloadTarget(candidateUrl.trim(), normalizedHost, true, false);
        }

        // Host is firebasestorage.googleapis.com
        if (hasPreSignedParams) {
            // If pre-signed or token-bearing, do NOT attach Firebase Auth Bearer token
            return new ValidatedDownloadTarget(candidateUrl.trim(), normalizedHost, true, false);
        }

        if (!cleanBucket.isEmpty() && !rawPath.toLowerCase(Locale.US).startsWith("/v0/b/" + cleanBucket + "/o/")) {
            throw new SecurityException("رفض أمني: مسار Firebase Storage لا يطابق حاوية التخزين المعتمدة للتطبيق.");
        }
        if (!rawPath.startsWith("/v0/b/") || !rawPath.contains("/o/")) {
            throw new SecurityException("رفض أمني: مسار Firebase Storage غير صالح.");
        }

        return new ValidatedDownloadTarget(candidateUrl.trim(), normalizedHost, false, true);
    }

    /**
     * Resolves a validated, task-bound download target from either a server-issued signed URL
     * or a validated storage_path. Rejects any external downloadUrl with SecurityException.
     */
    public static ValidatedDownloadTarget resolveProtectedDownloadTarget(
            String downloadUrl,
            String storagePath,
            String expectedBucket,
            String expectedAppId
    ) {
        if (downloadUrl != null && !downloadUrl.trim().isEmpty()) {
            return validateAndClassifyDownloadUrl(downloadUrl.trim(), expectedBucket, expectedAppId);
        }
        if (storagePath == null || storagePath.trim().isEmpty()) {
            throw new IllegalArgumentException("لا يوجد مسار تخزين محمي (storage_path) أو تفويض تنزيل لتنزيل الحزمة.");
        }
        String cleanPath = storagePath.trim();
        if (cleanPath.contains("..") || !cleanPath.startsWith("company_apps/")) {
            throw new SecurityException("رفض أمني: مسار التخزين (storage_path) غير صالح أو خارج نطاق company_apps/.");
        }
        if (expectedAppId != null && !expectedAppId.trim().isEmpty()
                && !cleanPath.startsWith("company_apps/" + expectedAppId.trim() + "/")) {
            throw new SecurityException("رفض أمني: مسار التخزين لا يطابق معرف التطبيق المستهدف في الأمر.");
        }
        if (expectedBucket == null || expectedBucket.trim().isEmpty()) {
            throw new IllegalStateException("لم يتم تكوين Storage Bucket في إعدادات التطبيق.");
        }
        String encodedObject = Uri.encode(cleanPath);
        String constructedUrl = "https://firebasestorage.googleapis.com/v0/b/"
                + expectedBucket.trim() + "/o/" + encodedObject + "?alt=media";
        return validateAndClassifyDownloadUrl(constructedUrl, expectedBucket.trim(), expectedAppId);
    }

    /**
     * Verifies the HTTP status code of the download connection, explicitly blocking any 3xx redirect
     * so that neither the download stream nor any authentication header is ever redirected across hosts.
     */
    public static void verifyResponseNotRedirected(int httpCode, String locationHeader) {
        if (httpCode == HttpURLConnection.HTTP_MOVED_PERM
                || httpCode == HttpURLConnection.HTTP_MOVED_TEMP
                || httpCode == HttpURLConnection.HTTP_SEE_OTHER
                || httpCode == 307
                || httpCode == 308
                || (httpCode >= 300 && httpCode < 400)) {
            throw new SecurityException("رفض أمني: تم حظر إعادة التوجيه التلقائي (HTTP " + httpCode
                    + ") أثناء تنزيل الحزمة لمنع تسريب المصادقة أو تغيير المضيف.");
        }
        if (httpCode != HttpURLConnection.HTTP_OK) {
            throw new IllegalStateException("فشل تنزيل ملف APK المحمي: استجاب الخادم بالرمز HTTP " + httpCode);
        }
    }

    /**
     * Verifies against Firestore (Source.SERVER) that the device enrollment is still approved
     * and the install command has not been cancelled or expired.
     */
    static void verifyCommandStillActiveOnServer(Context context, String uid, String cmdId, long expiresAtMs) throws Exception {
        if (uid == null || uid.isEmpty() || !SyncEngine.isDeviceApproved(context, uid)) {
            throw new SecurityException("الجهاز غير معتمد أو تم سحب اعتماده؛ تم رفض متابعة التثبيت.");
        }
        if (expiresAtMs > 0 && System.currentTimeMillis() > expiresAtMs) {
            throw new IllegalStateException("انتهت صلاحية أمر التثبيت (24 ساعة) قبل اعتماد الجلسة.");
        }
        if (cmdId == null || cmdId.isEmpty()) {
            throw new IllegalArgumentException("معرف أمر التثبيت مفقود.");
        }

        FirebaseFirestore db = FirebaseFirestore.getInstance();
        DocumentSnapshot enrollmentSnap = Tasks.await(
                db.collection("enrollments").document(uid).get(Source.SERVER),
                15,
                TimeUnit.SECONDS
        );
        if (enrollmentSnap == null || !enrollmentSnap.exists() || !Boolean.TRUE.equals(enrollmentSnap.getBoolean("approved"))) {
            throw new SecurityException("تم إلغاء اعتماد الجهاز على الخادم قبل اعتماد جلسة التثبيت.");
        }

        DocumentSnapshot cmdSnap = Tasks.await(
                db.collection("deviceCommands").document(uid).collection("commands").document(cmdId).get(Source.SERVER),
                15,
                TimeUnit.SECONDS
        );
        if (cmdSnap == null || !cmdSnap.exists()) {
            throw new IllegalStateException("أمر التثبيت لم يعد موجودًا على الخادم.");
        }
        if (Boolean.TRUE.equals(cmdSnap.getBoolean("cancelled"))) {
            throw new IllegalStateException("تم إلغاء أمر التثبيت من الإدارة قبل اعتماد الجلسة.");
        }
        String status = cmdSnap.getString("status");
        if (!"pending".equals(status) && !"in_progress".equals(status)) {
            throw new IllegalStateException("حالة أمر التثبيت تغيرت إلى (" + status + ") ولا يسمح باعتماد الجلسة.");
        }
        String serverExpiresAt = cmdSnap.getString("expires_at");
        if (serverExpiresAt != null && !serverExpiresAt.isEmpty()) {
            try {
                long serverExpMs = java.time.Instant.parse(serverExpiresAt).toEpochMilli();
                if (serverExpMs > 0 && System.currentTimeMillis() > serverExpMs) {
                    throw new IllegalStateException("انتهت صلاحية أمر التثبيت وفق توقيت الخادم.");
                }
            } catch (IllegalStateException ex) {
                throw ex;
            } catch (Exception ignored) {}
        }
    }

    /**
     * Requests a short-lived, task-bound pre-signed download URL from Cloud Functions (`getTaskDownloadAuthorization`).
     * Returns null if the callable is not deployed so the device can fall back to the validated task-bound storage_path.
     */
    private static String requestServerTaskSignedUrl(String uid, String cmdId, String appId) {
        if (uid == null || uid.isEmpty() || cmdId == null || cmdId.isEmpty() || appId == null || appId.isEmpty()) {
            return null;
        }
        try {
            Map<String, Object> data = new HashMap<>();
            data.put("uid", uid);
            data.put("cmdId", cmdId);
            data.put("appId", appId);
            HttpsCallableResult res = Tasks.await(
                    FirebaseFunctions.getInstance("us-central1")
                            .getHttpsCallable("getTaskDownloadAuthorization")
                            .call(data),
                    15,
                    TimeUnit.SECONDS
            );
            if (res != null && res.getData() instanceof Map) {
                Object urlObj = ((Map<?, ?>) res.getData()).get("downloadUrl");
                if (urlObj instanceof String && !((String) urlObj).trim().isEmpty()) {
                    return ((String) urlObj).trim();
                }
            }
        } catch (Exception ex) {
            Log.i(TAG, "getTaskDownloadAuthorization callable fallback to storage_path: " + ex.getMessage());
        }
        return null;
    }

    private static String fetchFreshAuthIdToken() throws Exception {
        FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
        if (user == null) {
            throw new SecurityException("لا توجد جلسة مصادقة نشطة للجهاز لتفويض تنزيل التطبيق.");
        }
        GetTokenResult tokenResult = Tasks.await(user.getIdToken(false), 15, TimeUnit.SECONDS);
        String token = tokenResult != null ? tokenResult.getToken() : null;
        if (token == null || token.isEmpty()) {
            throw new SecurityException("تعذر الحصول على رمز مصادقة قصير الصلاحية لتنزيل الحزمة.");
        }
        return token;
    }

    /**
     * Backward-compatible overload without storagePath.
     */
    public static void downloadAndInstall(Context context,
                                          String downloadUrl,
                                          String expectedPackageName,
                                          int expectedVersionCode,
                                          String expectedFileSha256,
                                          String expectedCertSha256,
                                          String cmdId,
                                          String uid,
                                          long expiresAtMs,
                                          boolean addToKiosk,
                                          InstallCallback callback) {
        downloadAndInstall(
                context,
                downloadUrl,
                null,
                null,
                expectedPackageName,
                expectedVersionCode,
                expectedFileSha256,
                expectedCertSha256,
                cmdId,
                uid,
                expiresAtMs,
                addToKiosk,
                callback
        );
    }

    /**
     * Backward-compatible overload without appId.
     */
    public static void downloadAndInstall(Context context,
                                          String downloadUrl,
                                          String storagePath,
                                          String expectedPackageName,
                                          int expectedVersionCode,
                                          String expectedFileSha256,
                                          String expectedCertSha256,
                                          String cmdId,
                                          String uid,
                                          long expiresAtMs,
                                          boolean addToKiosk,
                                          InstallCallback callback) {
        downloadAndInstall(
                context,
                downloadUrl,
                storagePath,
                null,
                expectedPackageName,
                expectedVersionCode,
                expectedFileSha256,
                expectedCertSha256,
                cmdId,
                uid,
                expiresAtMs,
                addToKiosk,
                callback
        );
    }

    /**
     * Downloads, validates, and installs an enterprise APK using task-bound storage authorization.
     */
    public static void downloadAndInstall(Context context,
                                          String downloadUrl,
                                          String storagePath,
                                          String appId,
                                          String expectedPackageName,
                                          int expectedVersionCode,
                                          String expectedFileSha256,
                                          String expectedCertSha256,
                                          String cmdId,
                                          String uid,
                                          long expiresAtMs,
                                          boolean addToKiosk,
                                          InstallCallback callback) {
        INSTALL_EXECUTOR.execute(() -> {
            File tempApk = null;
            PackageInstaller.Session session = null;
            int sessionId = -1;
            PackageInstaller installer = null;
            try {
                if (callback != null) callback.onProgress("جارٍ فحص صلاحية الأمر وبيئة الجهاز...");

                // 1. Validate device approval, expiration, and server command state before download
                verifyCommandStillActiveOnServer(context, uid, cmdId, expiresAtMs);

                // Mandatory signing certificate fingerprint
                if (expectedCertSha256 == null || expectedCertSha256.trim().isEmpty()) {
                    throw new SecurityException("شهادة التوقيع SHA-256 إلزامية ولا يمكن تثبيت حزمة بدون بصمة شهادة معتمدة.");
                }

                PackageManager pm = context.getPackageManager();
                long preInstallVersion = -1L;
                long preInstallUpdateTime = -1L;

                // 2. Pre-install check: downgrade prevention, signature compatibility, AND already-installed detection
                try {
                    PackageInfo existingInfo = pm.getPackageInfo(expectedPackageName, 0);
                    long existingVer = Build.VERSION.SDK_INT >= 28 ? existingInfo.getLongVersionCode() : existingInfo.versionCode;
                    preInstallVersion = existingVer;
                    preInstallUpdateTime = existingInfo.lastUpdateTime;

                    String currentCertSha = getSignerCertificateSha256(context, expectedPackageName);
                    if (!currentCertSha.isEmpty() && !expectedCertSha256.trim().equalsIgnoreCase(currentCertSha.trim())) {
                        throw new SecurityException("تعارض توقيع: شهادة الإصدار الجديد لا تطابق شهادة النسخة المثبتة على الجهاز.");
                    }

                    if (existingVer > expectedVersionCode) {
                        throw new IllegalStateException("لا يمكن تخفيض إصدار التطبيق (Downgrade): النسخة المثبتة حاليًا ("
                                + existingVer + ") أحدث من النسخة المطلوبة (" + expectedVersionCode + ")");
                    }

                    // Distinct handling when the exact required version with matching cert is already installed:
                    // Do NOT open a new session or claim a new install session succeeded.
                    if (existingVer == expectedVersionCode
                            && !currentCertSha.isEmpty()
                            && expectedCertSha256.trim().equalsIgnoreCase(currentCertSha.trim())) {
                        Log.i(TAG, "Target version already installed with matching certificate: "
                                + expectedPackageName + " v" + existingVer);
                        SharedPreferences taskPrefs = context.getSharedPreferences(PREFS_TASKS, Context.MODE_PRIVATE);
                        String alreadyKey = "session_already_" + (cmdId != null ? cmdId : System.currentTimeMillis());
                        enqueueAndFlushInstallResult(
                                context,
                                taskPrefs,
                                alreadyKey,
                                uid,
                                cmdId,
                                expectedPackageName,
                                existingVer,
                                OUTCOME_ALREADY_INSTALLED,
                                "الإصدار المطلوب موجود مسبقًا",
                                null,
                                0
                        );
                        try {
                            DeviceInventory.publish(context, FirebaseFirestore.getInstance(), uid);
                        } catch (Exception ignored) {}
                        if (callback != null) {
                            callback.onSuccess(expectedPackageName, expectedVersionCode);
                        }
                        return;
                    }
                } catch (PackageManager.NameNotFoundException ignored) {
                    // New installation
                }

                // 3. Resolve & strictly validate task-authorized download target
                if (callback != null) callback.onProgress("جارٍ التحقق من تفويض التنزيل المحمي وتنزيل الحزمة...");
                tempApk = new File(context.getCacheDir(), "install_" + expectedPackageName + "_" + System.currentTimeMillis() + ".apk");
                if (tempApk.exists()) tempApk.delete();

                String configuredBucket = FirebaseApp.getInstance().getOptions().getStorageBucket();

                // If an explicit downloadUrl was passed on the command, validate it first so any external URL is immediately rejected!
                if (downloadUrl != null && !downloadUrl.trim().isEmpty()) {
                    validateAndClassifyDownloadUrl(downloadUrl, configuredBucket, appId);
                }

                // Prefer short-lived server-signed download authorization (which requires no Firebase ID token)
                String serverSignedUrl = requestServerTaskSignedUrl(uid, cmdId, appId);
                ValidatedDownloadTarget downloadTarget = resolveProtectedDownloadTarget(
                        serverSignedUrl != null ? serverSignedUrl : downloadUrl,
                        storagePath,
                        configuredBucket,
                        appId
                );

                URL url = new URL(downloadTarget.url);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(45000);

                // NEVER attach Firebase ID token to a pre-signed URL or non-Firebase Storage host!
                if (downloadTarget.requiresFirebaseAuthToken
                        && !downloadTarget.isSignedStorageUrl
                        && "firebasestorage.googleapis.com".equalsIgnoreCase(downloadTarget.host)) {
                    String idToken = fetchFreshAuthIdToken();
                    conn.setRequestProperty("Authorization", "Bearer " + idToken);
                }

                conn.connect();
                int httpCode = conn.getResponseCode();
                String locationHeader = conn.getHeaderField("Location");
                try {
                    verifyResponseNotRedirected(httpCode, locationHeader);
                } catch (Exception redirectOrHttpErr) {
                    conn.disconnect();
                    throw redirectOrHttpErr;
                }

                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(tempApk)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                    }
                } finally {
                    conn.disconnect();
                }

                // 4. Verify Whole-File SHA-256
                if (callback != null) callback.onProgress("جارٍ التحقق من البصمة الرقمية SHA-256 للملف المنزّل...");
                String actualFileSha256 = computeFileSha256(tempApk);
                if (expectedFileSha256 != null && !expectedFileSha256.trim().equalsIgnoreCase(actualFileSha256.trim())) {
                    throw new SecurityException("فشل التحقق الأمني: بصمة ملف APK المنزّل (" + actualFileSha256
                            + ") لا تطابق البصمة المعتمدة (" + expectedFileSha256 + ")");
                }

                // 5. Verify Package Name and Version from Downloaded Archive
                PackageInfo archiveInfo = pm.getPackageArchiveInfo(tempApk.getAbsolutePath(), 0);
                if (archiveInfo == null) {
                    throw new IllegalArgumentException("الملف المنزّل ليس ملف حزمة Android APK صالح");
                }
                if (!expectedPackageName.equals(archiveInfo.packageName)) {
                    throw new SecurityException("اسم حزمة APK المنزلة (" + archiveInfo.packageName
                            + ") لا يطابق اسم الحزمة المعتمدة للأمر (" + expectedPackageName + ")");
                }
                long archiveVer = Build.VERSION.SDK_INT >= 28 ? archiveInfo.getLongVersionCode() : archiveInfo.versionCode;
                if (archiveVer != expectedVersionCode) {
                    throw new SecurityException("إصدار حزمة APK المنزلة (" + archiveVer
                            + ") لا يطابق الإصدار المعتمد بدقة (" + expectedVersionCode + ")");
                }

                // 6. Verify Mandatory Downloaded Archive Signer Certificate
                if (callback != null) callback.onProgress("جارٍ التحقق من شهادة توقيع الحزمة المنزلة...");
                String downloadedCertSha = extractArchiveSignerSha256(context, tempApk);
                if (downloadedCertSha.isEmpty()) {
                    throw new SecurityException("فشل استخراج شهادة توقيع حزمة APK المنزلة؛ الملف غير موقع بشكل صحيح.");
                }
                if (!expectedCertSha256.trim().equalsIgnoreCase(downloadedCertSha.trim())) {
                    throw new SecurityException("بصمة شهادة توقيع ملف APK المنزّل (" + downloadedCertSha
                            + ") لا تطابق بصمة الشهادة المعتمدة (" + expectedCertSha256 + ")");
                }

                // 7. Open PackageInstaller Session and stream verified APK
                if (callback != null) callback.onProgress("جارٍ بث الحزمة عبر جلسة PackageInstaller الإدارية...");
                installer = pm.getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                        PackageInstaller.SessionParams.MODE_FULL_INSTALL
                );
                params.setAppPackageName(expectedPackageName);

                sessionId = installer.createSession(params);
                session = installer.openSession(sessionId);

                try (InputStream in = new FileInputStream(tempApk);
                     OutputStream out = session.openWrite("package_session", 0, tempApk.length())) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                    }
                    session.fsync(out);
                }

                // Delete temporary APK immediately after streaming into session
                if (tempApk.exists()) {
                    tempApk.delete();
                    tempApk = null;
                }

                // 8. Re-verify command expiration, cancellation status, and device approval RIGHT BEFORE session.commit()
                if (callback != null) callback.onProgress("جارٍ إعادة التحقق من حالة الأمر واعتماد الجهاز قبل الاعتماد النهائي...");
                verifyCommandStillActiveOnServer(context, uid, cmdId, expiresAtMs);

                // 9. Synchronously persist session task state BEFORE session.commit() and verify commit() succeeds
                SharedPreferences taskPrefs = context.getSharedPreferences(PREFS_TASKS, Context.MODE_PRIVATE);
                String taskKey = "session_" + sessionId;
                boolean stateSaved = taskPrefs.edit()
                        .putInt(taskKey + "_session_id", sessionId)
                        .putString(taskKey + "_cmd_id", cmdId != null ? cmdId : "")
                        .putString(taskKey + "_uid", uid != null ? uid : "")
                        .putString(taskKey + "_pkg", expectedPackageName)
                        .putLong(taskKey + "_version_code", expectedVersionCode)
                        .putLong(taskKey + "_pre_install_version", preInstallVersion)
                        .putLong(taskKey + "_pre_install_update_time", preInstallUpdateTime)
                        .putLong(taskKey + "_expires_at_ms", expiresAtMs)
                        .putString(taskKey + "_cert_sha256", expectedCertSha256)
                        .putBoolean(taskKey + "_add_to_kiosk", addToKiosk)
                        .putLong(taskKey + "_created_at", System.currentTimeMillis())
                        .putString(taskKey + "_state", "COMMITTED")
                        .commit();

                if (!stateSaved) {
                    throw new IllegalStateException("تعذر حفظ حالة مهمة التثبيت بشكل متزامن قبل commit؛ تم إلغاء الجلسة.");
                }

                // 10. Commit session with explicit IntentSender delivered to InstallStatusReceiver
                Intent intent = new Intent(context, InstallStatusReceiver.class);
                intent.setAction(InstallStatusReceiver.ACTION_INSTALL_COMMIT_RESULT);
                PendingIntent pendingIntent = PendingIntent.getBroadcast(
                        context, sessionId, intent,
                        PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_MUTABLE : 0)
                );

                if (callback != null) callback.onProgress("تم إرسال الحزمة للنظام وبانتظار تأكيد النتيجة...");
                session.commit(pendingIntent.getIntentSender());
                session.close();
                session = null;

            } catch (Exception ex) {
                Log.e(TAG, "downloadAndInstall error: " + ex.getMessage(), ex);
                if (session != null) {
                    try {
                        session.abandon();
                    } catch (Exception ignored) {}
                    try {
                        session.close();
                    } catch (Exception ignored) {}
                } else if (installer != null && sessionId >= 0) {
                    try {
                        installer.abandonSession(sessionId);
                    } catch (Exception ignored) {}
                }
                if (callback != null) callback.onFailure(ex.getMessage());
            } finally {
                if (tempApk != null && tempApk.exists()) {
                    tempApk.delete();
                }
            }
        });
    }

    /**
     * Enqueues a final installation result synchronously in PREFS_TASKS (RESULT_PENDING_ACK)
     * and attempts to flush it to Firestore, only deleting the local task record after server confirmation.
     */
    static void enqueueAndFlushInstallResult(Context context,
                                             SharedPreferences p,
                                             String taskKey,
                                             String uid,
                                             String cmdId,
                                             String packageName,
                                             long installedVer,
                                             String outcome,
                                             String progressMessage,
                                             String errorMsg,
                                             int errorCode) {
        if (p == null && context != null) {
            p = context.getSharedPreferences(PREFS_TASKS, Context.MODE_PRIVATE);
        }
        if (p != null && taskKey != null && !taskKey.isEmpty()) {
            String resultStatus = (errorMsg != null && !errorMsg.isEmpty()) ? "failed" : "executed";
            boolean queued = p.edit()
                    .putString(taskKey + "_cmd_id", cmdId != null ? cmdId : "")
                    .putString(taskKey + "_uid", uid != null ? uid : "")
                    .putString(taskKey + "_pkg", packageName != null ? packageName : "")
                    .putLong(taskKey + "_result_installed_ver", installedVer)
                    .putString(taskKey + "_result_status", resultStatus)
                    .putString(taskKey + "_result_outcome", outcome != null ? outcome : "")
                    .putString(taskKey + "_result_progress", progressMessage != null ? progressMessage : "")
                    .putString(taskKey + "_result_error", errorMsg != null ? errorMsg : "")
                    .putInt(taskKey + "_result_error_code", errorCode)
                    .putString(taskKey + "_state", "RESULT_PENDING_ACK")
                    .commit();
            if (!queued) {
                Log.e(TAG, "Failed to synchronously persist RESULT_PENDING_ACK for " + taskKey);
            }
        }
        flushSinglePendingResult(p, taskKey);
    }

    static void flushSinglePendingResult(final SharedPreferences p, final String prefix) {
        if (p == null || prefix == null || prefix.isEmpty()) return;
        String state = p.getString(prefix + "_state", "");
        if (!"RESULT_PENDING_ACK".equals(state)) return;

        final String uid = p.getString(prefix + "_uid", "");
        final String cmdId = p.getString(prefix + "_cmd_id", "");
        if (uid.isEmpty() || cmdId.isEmpty()) {
            clearTask(p, prefix);
            return;
        }

        String resultStatus = p.getString(prefix + "_result_status", "failed");
        String outcome = p.getString(prefix + "_result_outcome", "");
        String progress = p.getString(prefix + "_result_progress", "");
        String errorMsg = p.getString(prefix + "_result_error", "");
        int errorCode = p.getInt(prefix + "_result_error_code", 0);
        long installedVer = p.getLong(prefix + "_result_installed_ver", 0L);

        Map<String, Object> updates = new HashMap<>();
        updates.put("status", resultStatus);
        updates.put("completed_at", FieldValue.serverTimestamp());
        if ("executed".equals(resultStatus)) {
            updates.put("installed_version", installedVer);
            updates.put("install_outcome", outcome.isEmpty() ? OUTCOME_INSTALLED : outcome);
            if (!progress.isEmpty()) {
                updates.put("progress", progress);
            }
            updates.put("error", null);
        } else {
            updates.put("install_outcome", OUTCOME_FAILED);
            updates.put("error", errorMsg.isEmpty() ? "فشل تثبيت الحزمة" : errorMsg);
            updates.put("error_code", errorCode);
        }

        FirebaseFirestore.getInstance()
                .collection("deviceCommands")
                .document(uid)
                .collection("commands")
                .document(cmdId)
                .update(updates)
                .addOnSuccessListener(unused -> {
                    Log.i(TAG, "Server acknowledged install result for cmd=" + cmdId + " (" + resultStatus + "); clearing local task " + prefix);
                    clearTask(p, prefix);
                })
                .addOnFailureListener(ex -> {
                    Log.w(TAG, "Failed to acknowledge install result for cmd=" + cmdId + "; retaining in local retry queue: " + ex.getMessage());
                });
    }

    /**
     * Recovers pending install results and inspects active/failed PackageInstaller sessions
     * after process restart or device reboot.
     */
    public static void recoverPendingInstallTasks(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS_TASKS, Context.MODE_PRIVATE);
        Map<String, ?> all = p.getAll();
        PackageManager pm = context.getPackageManager();
        PackageInstaller installer = pm.getPackageInstaller();

        Map<Integer, PackageInstaller.SessionInfo> mySessionsById = new HashMap<>();
        try {
            List<PackageInstaller.SessionInfo> mySessions = installer.getMySessions();
            if (mySessions != null) {
                for (PackageInstaller.SessionInfo sInfo : mySessions) {
                    if (sInfo != null) {
                        mySessionsById.put(sInfo.getSessionId(), sInfo);
                    }
                }
            }
        } catch (Exception ex) {
            Log.w(TAG, "Unable to enumerate PackageInstaller.getMySessions(): " + ex.getMessage());
        }

        for (String key : all.keySet()) {
            if (!key.startsWith("session_") || !key.endsWith("_state")) {
                continue;
            }
            String prefix = key.substring(0, key.length() - "_state".length());
            String state = p.getString(prefix + "_state", "");

            // 1. Flush any result already waiting for Firestore acknowledgement
            if ("RESULT_PENDING_ACK".equals(state)) {
                flushSinglePendingResult(p, prefix);
                continue;
            }

            if (!"COMMITTED".equals(state)) {
                continue;
            }

            String pkg = p.getString(prefix + "_pkg", "");
            long expectedVer = p.getLong(prefix + "_version_code", 0L);
            long preInstallVer = p.getLong(prefix + "_pre_install_version", -1L);
            long preInstallUpdateTime = p.getLong(prefix + "_pre_install_update_time", -1L);
            long createdAt = p.getLong(prefix + "_created_at", 0L);
            long expiresAtMs = p.getLong(prefix + "_expires_at_ms", 0L);
            String expectedCert = p.getString(prefix + "_cert_sha256", "");
            String cmdId = p.getString(prefix + "_cmd_id", "");
            String uid = p.getString(prefix + "_uid", "");
            int sessionId = p.getInt(prefix + "_session_id", -1);

            if (pkg.isEmpty() || cmdId.isEmpty() || uid.isEmpty()) {
                clearTask(p, prefix);
                continue;
            }

            PackageInstaller.SessionInfo sessionInfo = sessionId >= 0 ? mySessionsById.get(sessionId) : null;
            if (sessionInfo == null && sessionId >= 0) {
                try {
                    sessionInfo = installer.getSessionInfo(sessionId);
                } catch (Exception ignored) {}
            }

            long now = System.currentTimeMillis();
            boolean expired = expiresAtMs > 0 && now > expiresAtMs;
            boolean stalled = createdAt > 0 && (now - createdAt) > SESSION_STALL_TIMEOUT_MS;

            // 2. If the PackageInstaller session is still active in OS
            if (sessionInfo != null && sessionInfo.isActive()) {
                if (expired || stalled) {
                    try {
                        installer.abandonSession(sessionId);
                    } catch (Exception ignored) {}
                    String reason = expired
                            ? "انتهت صلاحية أمر التثبيت أثناء بقاء الجلسة معلقة؛ تم إلغاء الجلسة."
                            : "تعطلت جلسة التثبيت في النظام لأكثر من 30 دقيقة؛ تم إلغاء الجلسة.";
                    enqueueAndFlushInstallResult(
                            context,
                            p,
                            prefix,
                            uid,
                            cmdId,
                            pkg,
                            0L,
                            OUTCOME_FAILED,
                            null,
                            reason,
                            PackageInstaller.STATUS_FAILURE_ABORTED
                    );
                } else {
                    Log.i(TAG, "Session " + sessionId + " for " + pkg + " is still active in PackageInstaller; awaiting OS broadcast.");
                }
                continue;
            }

            // 3. Session is no longer active in PackageInstaller: check whether the new install actually took effect
            try {
                PackageInfo info = pm.getPackageInfo(pkg, 0);
                long installedVer = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
                String installedCert = getSignerCertificateSha256(context, pkg);

                boolean versionAndCertMatch = installedVer == expectedVer
                        && !expectedCert.isEmpty()
                        && expectedCert.equalsIgnoreCase(installedCert);
                boolean updatedSincePreInstall = (preInstallVer < 0)
                        || (installedVer > preInstallVer)
                        || (preInstallUpdateTime > 0 && info.lastUpdateTime > preInstallUpdateTime);

                if (versionAndCertMatch && updatedSincePreInstall) {
                    Log.i(TAG, "Recovered completed install session for " + pkg + " v" + installedVer);
                    enqueueAndFlushInstallResult(
                            context,
                            p,
                            prefix,
                            uid,
                            cmdId,
                            pkg,
                            installedVer,
                            OUTCOME_INSTALLED,
                            "تم التثبيت والتحقق من الشهادة بعد استرداد الجلسة",
                            null,
                            0
                    );
                } else if (versionAndCertMatch) {
                    enqueueAndFlushInstallResult(
                            context,
                            p,
                            prefix,
                            uid,
                            cmdId,
                            pkg,
                            installedVer,
                            OUTCOME_FAILED,
                            null,
                            "فشلت جلسة التثبيت الجديدة أو أُلغيت؛ النسخة المثبتة لم تتغير عن الحالة السابقة.",
                            PackageInstaller.STATUS_FAILURE
                    );
                } else {
                    enqueueAndFlushInstallResult(
                            context,
                            p,
                            prefix,
                            uid,
                            cmdId,
                            pkg,
                            0L,
                            OUTCOME_FAILED,
                            null,
                            "انتهت جلسة التثبيت دون مطابقة الإصدار أو الشهادة المطلوبة.",
                            PackageInstaller.STATUS_FAILURE
                    );
                }
            } catch (Exception ex) {
                enqueueAndFlushInstallResult(
                        context,
                        p,
                        prefix,
                        uid,
                        cmdId,
                        pkg,
                        0L,
                        OUTCOME_FAILED,
                        null,
                        "فشلت جلسة التثبيت أو فُقدت قبل اكتمال تثبيت الحزمة.",
                        PackageInstaller.STATUS_FAILURE
                );
            }
        }
    }

    static boolean clearTask(SharedPreferences p, String prefix) {
        if (p == null || prefix == null || prefix.isEmpty()) return false;
        return p.edit()
                .remove(prefix + "_session_id")
                .remove(prefix + "_cmd_id")
                .remove(prefix + "_uid")
                .remove(prefix + "_cert_sha256")
                .remove(prefix + "_version_code")
                .remove(prefix + "_pre_install_version")
                .remove(prefix + "_pre_install_update_time")
                .remove(prefix + "_expires_at_ms")
                .remove(prefix + "_pkg")
                .remove(prefix + "_add_to_kiosk")
                .remove(prefix + "_created_at")
                .remove(prefix + "_result_installed_ver")
                .remove(prefix + "_result_status")
                .remove(prefix + "_result_outcome")
                .remove(prefix + "_result_progress")
                .remove(prefix + "_result_error")
                .remove(prefix + "_result_error_code")
                .remove(prefix + "_state")
                .commit();
    }
}
