'use strict';
function safeRequire(mod, fallback) {
  try {
    return require(mod);
  } catch {
    return fallback;
  }
}
const {
  initFirebaseAdmin,
  getAdminDb,
  getAdminStorageBucket,
  FieldValue,
} = require('./firebaseAdmin');

const {getMessaging} = safeRequire('firebase-admin/messaging', {
  getMessaging: () => ({send: async () => {}}),
});
const {onCall, HttpsError} = safeRequire('firebase-functions/v2/https', {
  onCall: (_opts, handler) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  },
});
const {onDocumentWritten} = safeRequire('firebase-functions/v2/firestore', {
  onDocumentWritten: (_opts, handler) => handler,
});
const {onSchedule} = safeRequire('firebase-functions/v2/scheduler', {
  onSchedule: (_opts, handler) => handler,
});
const logger = safeRequire('firebase-functions/logger', {
  info: () => {},
  warn: () => {},
  error: () => {},
});
const {registerEndpoint, endpointChanged, dispatch} = require('./push');
const {inspectApkBuffer, normalizeHexDigest} = require('./apkInspector');

initFirebaseAdmin();
const db = getAdminDb();
const options = {region: 'us-central1', maxInstances: 2, memory: '256MiB', timeoutSeconds: 60};

const PROTECTED_PACKAGES = new Set([
  'com.company.mdmagent',
  'com.android.settings',
  'com.android.systemui',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.android.vending',
  'com.google.android.packageinstaller',
  'com.android.packageinstaller',
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
]);

function isValidPackageName(pkg) {
  return (
    typeof pkg === 'string' &&
    pkg.length >= 3 &&
    pkg.length <= 150 &&
    /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)
  );
}

/**
 * Verifies whether the caller is an authorized administrator using the unified system contract:
 * Non-anonymous, verified email, AND either custom claim `admin === true` or `/admins/{uid}.active === true`.
 */
async function verifyAdminAuth(auth, firestoreDb) {
  if (!auth || !auth.uid || !auth.token) {
    throw Object.assign(new Error('يجب تسجيل الدخول كمسؤول معتمد'), {code: 'unauthenticated'});
  }
  const token = auth.token;
  const provider = token.firebase?.sign_in_provider;
  if (
    provider === 'anonymous' ||
    typeof token.email !== 'string' ||
    token.email.length <= 3 ||
    token.email_verified !== true
  ) {
    throw Object.assign(new Error('يتطلب الإجراء حساب مسؤول موثق البريد الإلكتروني'), {
      code: 'permission-denied',
    });
  }

  if (token.admin === true) {
    return {uid: auth.uid, email: token.email};
  }

  const adminSnap = await firestoreDb.doc(`admins/${auth.uid}`).get();
  const adminData = typeof adminSnap.data === 'function' ? adminSnap.data() : adminSnap.data;
  if (!adminData || adminData.active !== true) {
    throw Object.assign(new Error('المستخدم غير مدرج في سجل المسؤولين المعتمدين (admins)'), {
      code: 'permission-denied',
    });
  }

  return {uid: auth.uid, email: token.email};
}

/**
 * Server-side authoritative APK inspection & cryptographic signature verification via official `apksigner`.
 * - Binds verification result to exact Storage object path, generation, and SHA-256 digest.
 * - If the official `apksigner` inspection environment is unavailable (`INSPECTION_ENV_UNAVAILABLE`),
 *   keeps `inspection_status: 'pending_inspection'` and `inspected_by_server: false` and blocks distribution
 *   (no fallback acceptance path).
 */
async function executeServerApkInspection({
  appId,
  auth,
  firestoreDb,
  storageReader,
  inspectorOptions = {},
  serverTimestampFn = () => FieldValue.serverTimestamp(),
}) {
  const actor = await verifyAdminAuth(auth, firestoreDb);
  if (!appId || typeof appId !== 'string') {
    throw Object.assign(new Error('معرّف التطبيق (appId) مطلوب'), {code: 'invalid-argument'});
  }

  const appRef = firestoreDb.doc(`companyApps/${appId}`);
  const appSnap = await appRef.get();
  const appData = typeof appSnap.data === 'function' ? appSnap.data() : appSnap.data;
  if (!appData) {
    throw Object.assign(new Error('وثيقة التطبيق غير موجودة في companyApps'), {code: 'not-found'});
  }

  const storagePath = appData.storage_path;
  if (!storagePath || typeof storagePath !== 'string' || !storagePath.startsWith(`company_apps/${appId}/`)) {
    throw Object.assign(
      new Error('مسار ملف APK في التخزين غير صالح أو لا يطابق معرّف التطبيق'),
      {code: 'invalid-argument'}
    );
  }

  let fileObj;
  try {
    fileObj = await storageReader(storagePath);
  } catch (readErr) {
    await appRef.update({
      inspection_status: 'failed',
      inspected_by_server: false,
      inspection_error: `فشل قراءة ملف APK من التخزين: ${readErr.message}`,
      inspected_at: serverTimestampFn(),
    });
    throw Object.assign(new Error(`فشل قراءة ملف APK من التخزين: ${readErr.message}`), {
      code: 'failed-precondition',
    });
  }

  // Prevent re-binding or replacing an already verified file with a different generation
  if (
    appData.inspection_status === 'verified' &&
    appData.storage_generation &&
    String(fileObj.generation) !== String(appData.storage_generation)
  ) {
    await appRef.update({
      inspection_status: 'failed',
      inspected_by_server: false,
      inspection_error: 'تم رصد محاولة استبدال ملف APK بعد اعتماده؛ تم إبطال الاعتماد',
      inspected_at: serverTimestampFn(),
    });
    throw Object.assign(new Error('تم رصد استبدال ملف APK بعد اعتماده؛ يُمنع تعديل الملف المعتمد'), {
      code: 'permission-denied',
    });
  }

  let inspected;
  try {
    inspected = inspectApkBuffer(fileObj.buffer, inspectorOptions);

    // If client supplied a preview sha256_apk, verify the uploaded file matches it exactly
    const expectedApkHex = normalizeHexDigest(appData.sha256_apk || '');
    if (expectedApkHex && expectedApkHex !== inspected.sha256Apk) {
      throw new Error(
        `بصمة الملف المرفوع في التخزين (${inspected.sha256Apk}) لا تطابق بصمة الملف المعلن (${expectedApkHex})`
      );
    }
  } catch (verifyErr) {
    // Fail-closed when official apksigner runtime is unavailable: keep pending_inspection and block distribution
    if (verifyErr && verifyErr.code === 'INSPECTION_ENV_UNAVAILABLE') {
      await appRef.update({
        inspection_status: 'pending_inspection',
        inspected_by_server: false,
        inspection_error: verifyErr.message,
        inspected_at: serverTimestampFn(),
      });
      throw Object.assign(new Error(verifyErr.message), {code: 'failed-precondition'});
    }

    await appRef.update({
      inspection_status: 'failed',
      inspected_by_server: false,
      inspection_error: verifyErr.message,
      inspected_at: serverTimestampFn(),
    });
    throw Object.assign(new Error(verifyErr.message), {code: 'invalid-argument'});
  }

  const verifiedUpdate = {
    package_name: inspected.packageName,
    version_code: inspected.versionCode,
    version_name: inspected.versionName,
    file_size_bytes: inspected.fileSizeBytes,
    sha256_apk: inspected.sha256Apk,
    sha256_cert: inspected.sha256Cert,
    signature_scheme: inspected.signatureScheme,
    storage_path: storagePath,
    storage_generation: String(fileObj.generation || '1'),
    inspection_status: 'verified',
    inspected_by_server: true,
    inspection_error: null,
    inspected_at: serverTimestampFn(),
    inspected_by_uid: actor.uid,
    inspected_by_email: actor.email,
  };

  await appRef.update(verifiedUpdate);
  return verifiedUpdate;
}

/**
 * Issues a short-lived, task-bound download authorization for a targeted approved device.
 * Strictly verifies:
 * 1. Caller is the exact targeted device (`auth.uid === uid`) and is approved in `enrollments/{uid}`.
 * 2. Command `deviceCommands/{uid}/commands/{cmdId}` exists, is active (`pending` or `in_progress`), not cancelled, and not expired.
 * 3. Grant `deviceDownloadGrants/{uid}/apps/{appId}` is active and not expired.
 * 4. App `companyApps/{appId}` has `inspection_status === 'verified'` and `inspected_by_server === true`.
 * 5. Storage object generation matches `companyApps/{appId}.storage_generation` (prevents file swap after verification).
 */
async function authorizeTaskApkDownload({
  auth,
  uid,
  cmdId,
  appId,
  firestoreDb,
  storageSigner,
  nowMs = Date.now(),
}) {
  if (!auth || !auth.uid) {
    throw Object.assign(new Error('يجب مصادقة الجهاز أولاً'), {code: 'unauthenticated'});
  }
  if (!uid || auth.uid !== uid) {
    throw Object.assign(
      new Error('غير مصرح: هذا التطبيق مخصص لجهاز آخر ولا يُسمح لهذا الجهاز بقراءته'),
      {code: 'permission-denied'}
    );
  }
  if (!cmdId || !appId) {
    throw Object.assign(new Error('معرّف الأمر ومعرّف التطبيق إلزاميان'), {code: 'invalid-argument'});
  }

  const [enrollmentSnap, cmdSnap, appSnap, grantSnap] = await Promise.all([
    firestoreDb.doc(`enrollments/${uid}`).get(),
    firestoreDb.doc(`deviceCommands/${uid}/commands/${cmdId}`).get(),
    firestoreDb.doc(`companyApps/${appId}`).get(),
    firestoreDb.doc(`deviceDownloadGrants/${uid}/apps/${appId}`).get(),
  ]);

  const enrollment = typeof enrollmentSnap.data === 'function' ? enrollmentSnap.data() : enrollmentSnap.data;
  if (!enrollment || enrollment.approved !== true) {
    throw Object.assign(new Error('الجهاز غير معتمد في النظام'), {code: 'permission-denied'});
  }

  const cmd = typeof cmdSnap.data === 'function' ? cmdSnap.data() : cmdSnap.data;
  if (!cmd || cmd.type !== 'install_app') {
    throw Object.assign(new Error('أمر التثبيت غير موجود لهذا الجهاز'), {code: 'permission-denied'});
  }
  if (cmd.app_id && cmd.app_id !== appId) {
    throw Object.assign(new Error('أمر التثبيت لا يخص هذا التطبيق'), {code: 'permission-denied'});
  }
  if (cmd.cancelled === true || !['pending', 'in_progress'].includes(cmd.status)) {
    throw Object.assign(
      new Error(`لا يمكن تنزيل الحزمة لأن حالة الأمر هي (${cmd.status}) أو تم إلغاؤه`),
      {code: 'permission-denied'}
    );
  }
  if (cmd.expires_at) {
    const expMs = typeof cmd.expires_at === 'number' ? cmd.expires_at : Date.parse(cmd.expires_at);
    if (Number.isFinite(expMs) && nowMs > expMs) {
      throw Object.assign(new Error('انتهت صلاحية أمر التثبيت وتفويض التنزيل'), {
        code: 'permission-denied',
      });
    }
  }

  const grant = typeof grantSnap.data === 'function' ? grantSnap.data() : grantSnap.data;
  if (!grant || grant.status !== 'active' || (grant.command_id && grant.command_id !== cmdId)) {
    throw Object.assign(new Error('تفويض تنزيل التطبيق لهذا الجهاز غير نشط أو ملغى'), {
      code: 'permission-denied',
    });
  }
  if (grant.expires_at) {
    const grantExpMs =
      typeof grant.expires_at.toMillis === 'function'
        ? grant.expires_at.toMillis()
        : typeof grant.expires_at === 'number'
        ? grant.expires_at
        : Date.parse(grant.expires_at);
    if (Number.isFinite(grantExpMs) && nowMs > grantExpMs) {
      throw Object.assign(new Error('انتهت صلاحية تفويض تنزيل التطبيق لهذا الجهاز'), {
        code: 'permission-denied',
      });
    }
  }

  const app = typeof appSnap.data === 'function' ? appSnap.data() : appSnap.data;
  if (!app || app.inspection_status !== 'verified' || app.inspected_by_server !== true) {
    throw Object.assign(
      new Error('حزمة التطبيق غير معتمدة من الخادم (inspection_status !== verified)'),
      {code: 'failed-precondition'}
    );
  }
  if (cmd.sha256_apk !== app.sha256_apk || cmd.sha256_cert !== app.sha256_cert) {
    throw Object.assign(new Error('تعارض في بصمة الحزمة بين الأمر وسجل التطبيق المعتمد'), {
      code: 'failed-precondition',
    });
  }

  const signedResult = await storageSigner({
    storagePath: app.storage_path,
    expectedGeneration: app.storage_generation,
    expiresAtMs: Math.min(nowMs + 15 * 60 * 1000, cmd.expires_at ? Date.parse(cmd.expires_at) : Infinity),
  });

  return {
    downloadUrl: signedResult.url,
    requiresFirebaseAuthToken: false,
    expiresAtMs: signedResult.expiresAtMs,
    sha256Apk: app.sha256_apk,
    sha256Cert: app.sha256_cert,
    packageName: app.package_name,
    versionCode: app.version_code,
  };
}

/**
 * Authoritative Server Transaction for adding an installed app to `kioskPolicies/{uid}`.
 * - Re-reads the command document inside the transaction; NEVER trusts event snapshot or phone-writable fields for `add_to_kiosk`.
 * - Checks `cmd.add_to_kiosk === true`, `cmd.status === 'executed'`, `cmd.cancelled !== true`, and exact `installed_version === version_code`.
 * - Validates device approval, Device Owner & SDK >= 30 eligibility, package name validity, protected packages, blocked_apps, and 50-app limit.
 * - Strictly requires actual presence in `deviceAppInventory/{uid}` with `has_launcher_icon === true`, `is_enabled !== false`, `is_hidden_by_agent !== true` when Kiosk is enabled.
 * - If `deviceAppInventory/{uid}` has not arrived yet or does not yet include the newly installed package, sets `kiosk_addition_status = 'waiting_for_inventory'` (not a permanent failure, and never bypasses the inventory check) so `onInventoryUpdatedKioskSync` automatically completes the addition when inventory updates.
 * - Idempotent across duplicate/stale event deliveries.
 * - Separates policy transaction success from FCM push notification (`wakeFn`).
 */
async function processCommandKioskSync({
  uid,
  cmdId,
  firestoreDb,
  wakeFn,
  serverTimestampFn = () => FieldValue.serverTimestamp(),
}) {
  const cmdRef = firestoreDb.doc(`deviceCommands/${uid}/commands/${cmdId}`);
  const kioskRef = firestoreDb.doc(`kioskPolicies/${uid}`);
  const policyRef = firestoreDb.doc(`policies/${uid}`);
  const enrollmentRef = firestoreDb.doc(`enrollments/${uid}`);
  const statusRef = firestoreDb.doc(`deviceStatus/${uid}`);
  const inventoryRef = firestoreDb.doc(`deviceAppInventory/${uid}`);
  const auditRef = firestoreDb.collection('auditLogs').doc();

  let transactionOutcome;
  try {
    transactionOutcome = await firestoreDb.runTransaction(async tx => {
      const [cmdSnap, enrollmentSnap, statusSnap, kioskSnap, policySnap, inventorySnap] =
        await Promise.all([
          tx.get(cmdRef),
          tx.get(enrollmentRef),
          tx.get(statusRef),
          tx.get(kioskRef),
          tx.get(policyRef),
          tx.get(inventoryRef),
        ]);

      const cmdData = typeof cmdSnap.data === 'function' ? cmdSnap.data() : cmdSnap.data;
      if (!cmdData || cmdData.type !== 'install_app') {
        return {action: 'ignored_not_install_cmd'};
      }

      // 1. Authoritative check: Did the ADMIN request add_to_kiosk === true?
      // Never trust add_to_kiosk_requested or event snapshot alone!
      if (cmdData.add_to_kiosk !== true) {
        return {action: 'ignored_not_requested_by_admin'};
      }

      // 2. Idempotency check: if already added for this exact version_code, do not repeat!
      if (
        cmdData.kiosk_addition_status === 'added' &&
        Number(cmdData.kiosk_added_for_version) === Number(cmdData.version_code)
      ) {
        return {action: 'noop_already_added', revision: cmdData.kiosk_added_revision};
      }

      // 3. Command must be currently executed (not pending, in_progress, failed, or cancelled)
      if (cmdData.cancelled === true || cmdData.status !== 'executed') {
        return {action: 'ignored_command_not_executed'};
      }

      // 4. Installed version must match the exact target version_code
      if (Number(cmdData.installed_version) !== Number(cmdData.version_code)) {
        throw new Error(
          `إصدار التطبيق المثبت (${cmdData.installed_version}) لا يطابق الإصدار المطلوب في الأمر (${cmdData.version_code})`
        );
      }

      // 5. Device must be currently approved
      const enrollmentData =
        typeof enrollmentSnap.data === 'function' ? enrollmentSnap.data() : enrollmentSnap.data;
      if (!enrollmentData || enrollmentData.approved !== true) {
        throw new Error('الجهاز غير معتمد حالياً في enrollments؛ تم رفض تعديل سياسة شاشة الشركة');
      }

      // 6. Validate package name and protected package rules
      const packageName = String(cmdData.package_name || '').trim();
      if (!isValidPackageName(packageName)) {
        throw new Error(`اسم الحزمة غير صالح برمجياً: (${packageName})`);
      }
      if (PROTECTED_PACKAGES.has(packageName)) {
        throw new Error(`لا يُسمح بإضافة الحزمة المحمية (${packageName}) إلى شاشة الشركة`);
      }

      // 7. Kiosk policy document must exist
      const kioskData = typeof kioskSnap.data === 'function' ? kioskSnap.data() : kioskSnap.data;
      if (!kioskData) {
        throw new Error('لم يتم إعداد سياسة شاشة الشركة (Kiosk) لهذا الجهاز بعد');
      }

      // 8. Check device eligibility when Kiosk is enabled
      const statusData = typeof statusSnap.data === 'function' ? statusSnap.data() : statusSnap.data;
      if (kioskData.enabled === true) {
        if (
          !statusData ||
          statusData.device_owner !== true ||
          Number(statusData.android_sdk || 0) < 30
        ) {
          throw new Error(
            'الجهاز غير مؤهل لتفعيل شاشة الشركة (يتطلب Device Owner ونظام Android 11 / SDK 30 أو أحدث)'
          );
        }
      }

      // 9. Check blocked_apps conflict in policies/{uid}
      const policyData = typeof policySnap.data === 'function' ? policySnap.data() : policySnap.data;
      if (policyData && Array.isArray(policyData.blocked_apps)) {
        if (policyData.blocked_apps.includes(packageName)) {
          throw new Error(`التطبيق (${packageName}) موجود في قائمة التطبيقات المحظورة`);
        }
      }

      // 10. Mandatory actual inventory verification when Kiosk is enabled:
      // NEVER skip this check if inventory is missing or hasn't reported the package yet!
      const inventoryData =
        typeof inventorySnap.data === 'function' ? inventorySnap.data() : inventorySnap.data;
      if (kioskData.enabled === true) {
        const hasValidInventoryArray = Boolean(inventoryData && Array.isArray(inventoryData.apps));
        const appItem = hasValidInventoryArray
          ? inventoryData.apps.find(a => a && a.package_name === packageName)
          : null;

        if (!hasValidInventoryArray || !appItem) {
          // Install confirmation arrived before the updated deviceAppInventory/{uid}:
          // Record waiting_for_inventory state (not a permanent failure) and wait for onInventoryUpdatedKioskSync!
          const waitingMsg =
            'بانتظار تحديث جرد التطبيقات من الجهاز للتحقق من أيقونة التشغيل وتوفر الحزمة';
          tx.update(cmdRef, {
            kiosk_addition_status: 'waiting_for_inventory',
            kiosk_addition_error: null,
            kiosk_addition_message: waitingMsg,
          });
          return {action: 'waiting_for_inventory', message: waitingMsg};
        }

        if (appItem.has_launcher_icon !== true) {
          throw new Error(
            `التطبيق (${packageName}) لا يملك واجهة تشغيل صالحة (has_launcher_icon !== true) في جرد الجهاز`
          );
        }
        if (appItem.is_enabled === false || appItem.is_hidden_by_agent === true) {
          throw new Error(
            `التطبيق (${packageName}) معطل أو مخفي في جرد الجهاز ولا يصلح لشاشة الشركة`
          );
        }
      }

      const currentAllowed = Array.isArray(kioskData.allowed_apps)
        ? [...kioskData.allowed_apps]
        : [];

      if (currentAllowed.includes(packageName)) {
        const currentRev = Number(kioskData.revision || 1);
        tx.update(cmdRef, {
          kiosk_addition_status: 'added',
          kiosk_addition_error: null,
          kiosk_addition_message: null,
          kiosk_added_revision: currentRev,
          kiosk_added_for_version: Number(cmdData.version_code),
        });
        return {action: 'already_in_allowed_apps', revision: currentRev};
      }

      if (currentAllowed.length >= 50) {
        throw new Error('تجاوزت قائمة شاشة الشركة الحد الأقصى المسموح به (50 تطبيقاً)');
      }

      const nextAllowed = Array.from(new Set([...currentAllowed, packageName])).sort();
      const nextRev = Number(kioskData.revision || 0) + 1;

      tx.set(kioskRef, {
        schema_version: 1,
        revision: nextRev,
        enabled: Boolean(kioskData.enabled),
        allowed_apps: nextAllowed,
        exit_salt: kioskData.exit_salt,
        exit_hash: kioskData.exit_hash,
      });

      tx.update(cmdRef, {
        kiosk_addition_status: 'added',
        kiosk_addition_error: null,
        kiosk_addition_message: null,
        kiosk_added_revision: nextRev,
        kiosk_added_for_version: Number(cmdData.version_code),
      });

      tx.set(auditRef, {
        actor_uid: cmdData.created_by_uid || 'system_kiosk_sync',
        actor_email: cmdData.created_by_email || 'system@company.internal',
        target_uid: uid,
        action: 'update_policy',
        summary: `إضافة التطبيق المثبت (${packageName}) تلقائياً إلى شاشة الشركة (إصدار v${nextRev})`,
        before: {revision: kioskData.revision, allowed_apps: currentAllowed},
        after: {revision: nextRev, allowed_apps: nextAllowed},
        created_at: serverTimestampFn(),
      });

      return {action: 'added', revision: nextRev};
    });
  } catch (txErr) {
    logger.error('kiosk_addition_transaction_failed', {uid, cmdId, error: txErr.message});
    await cmdRef.update({
      kiosk_addition_status: 'failed',
      kiosk_addition_error: txErr.message || 'فشل إضافة التطبيق لشاشة الشركة',
    });
    return {action: 'failed', error: txErr.message};
  }

  // Separate policy update success from FCM push dispatch:
  // If FCM fails, log warning without overwriting kiosk_addition_status='added'!
  if (
    transactionOutcome &&
    (transactionOutcome.action === 'added' ||
      transactionOutcome.action === 'already_in_allowed_apps') &&
    typeof wakeFn === 'function'
  ) {
    try {
      await wakeFn();
    } catch (pushErr) {
      logger.warn('kiosk_addition_fcm_wake_failed_non_fatal', {
        uid,
        cmdId,
        error: pushErr.message,
      });
      return {...transactionOutcome, pushError: pushErr.message};
    }
  }

  return transactionOutcome;
}

/**
 * Automatically retries Kiosk addition for any executed install_app commands on a device
 * that were recorded as `kiosk_addition_status === 'waiting_for_inventory'` when the install
 * confirmation arrived before `deviceAppInventory/{uid}`.
 */
async function processInventoryUpdatedKioskSync({
  uid,
  firestoreDb,
  wakeFn,
  serverTimestampFn = () => FieldValue.serverTimestamp(),
}) {
  if (!uid || typeof uid !== 'string') {
    return {processed: 0, outcomes: []};
  }

  const commandsCollection = firestoreDb.collection(`deviceCommands/${uid}/commands`);
  let candidateCmdIds = [];

  if (typeof commandsCollection.where === 'function') {
    const snap = await commandsCollection
      .where('kiosk_addition_status', '==', 'waiting_for_inventory')
      .get();
    candidateCmdIds = (snap.docs || []).map(d => d.id);
  } else if (typeof commandsCollection.get === 'function') {
    const snap = await commandsCollection.get();
    candidateCmdIds = (snap.docs || [])
      .filter(d => {
        const data = typeof d.data === 'function' ? d.data() : d.data;
        return (
          data &&
          data.type === 'install_app' &&
          data.status === 'executed' &&
          data.cancelled !== true &&
          data.add_to_kiosk === true &&
          data.kiosk_addition_status === 'waiting_for_inventory'
        );
      })
      .map(d => d.id);
  }

  const outcomes = [];
  for (const cmdId of candidateCmdIds) {
    const res = await processCommandKioskSync({
      uid,
      cmdId,
      firestoreDb,
      wakeFn,
      serverTimestampFn,
    });
    outcomes.push({cmdId, ...res});
  }

  return {processed: outcomes.length, outcomes};
}

exports.registerMdmPush = onCall(options, async request => {
  try {
    return await registerEndpoint(request.auth, request.data, db, () => FieldValue.serverTimestamp());
  } catch (error) {
    const code = ['unauthenticated', 'invalid-argument', 'permission-denied'].includes(error.code) ? error.code : 'internal';
    throw new HttpsError(code, 'Authenticated approved device and valid registration required.');
  }
});

/**
 * Validates the Cloud Run Inspector Service URL.
 * - Parses via URL constructor.
 * - Enforces HTTPS protocol for non-local endpoints.
 * - Rejects embedded user credentials (username/password).
 * - Allows local HTTP strictly during testing or when allowLocalHttp is set.
 */
function validateInspectorServiceUrl(rawUrl, allowLocalHttp = false) {
  const str = String(rawUrl || '').trim();
  if (!str) {
    throw Object.assign(
      new Error('عنوان خدمة فحص APK (CLOUD_RUN_INSPECTOR_URL) غير معرف في إعدادات البيئة'),
      {code: 'failed-precondition'}
    );
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(str);
  } catch {
    throw Object.assign(
      new Error(`عنوان خدمة فحص APK غير صالح برمجياً: (${str})`),
      {code: 'invalid-argument'}
    );
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw Object.assign(
      new Error('غير مسموح بوجود بيانات اعتمادات المستخدم (username/password) داخل عنوان خدمة الفحص'),
      {code: 'invalid-argument'}
    );
  }

  const isLocalHost = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedUrl.hostname);
  const isHttpLocalAllowed = allowLocalHttp || process.env.NODE_ENV === 'test';

  if (parsedUrl.protocol === 'http:') {
    if (!isLocalHost || !isHttpLocalAllowed) {
      throw Object.assign(
        new Error('يتطلب اتصال خدمة فحص APK الخادمية بروتوكول مشفر (HTTPS) حصراً'),
        {code: 'invalid-argument'}
      );
    }
  } else if (parsedUrl.protocol !== 'https:') {
    throw Object.assign(
      new Error(`بروتوكول غير مدعوم في عنوان خدمة الفحص: (${parsedUrl.protocol})`),
      {code: 'invalid-argument'}
    );
  }

  return parsedUrl;
}

/**
 * Invokes the dedicated Cloud Run Inspector Service via HTTPS service-to-service IAM call.
 * - Enforces server-side Admin verification first.
 * - Extracts authentic Firebase Bearer token from caller's request.rawRequest.
 * - Obtains a Google Cloud IAM OIDC token for service-to-service authentication.
 * - Fails closed if IAM token cannot be acquired, if redirects occur, or if service times out/fails.
 */
async function invokeCloudRunInspectorService({
  inspectorUrl = process.env.CLOUD_RUN_INSPECTOR_URL,
  appId,
  auth,
  firebaseAuthToken,
  firestoreDb = db,
  fetchFn = globalThis.fetch,
  getIdTokenFn,
  timeoutMs = 30000,
  allowLocalHttpForTest = false,
}) {
  const actor = await verifyAdminAuth(auth, firestoreDb);
  if (!appId || typeof appId !== 'string') {
    throw Object.assign(new Error('معرّف التطبيق (appId) مطلوب'), {code: 'invalid-argument'});
  }

  if (!firebaseAuthToken || typeof firebaseAuthToken !== 'string' || firebaseAuthToken.trim().length === 0) {
    throw Object.assign(new Error('مطلوب رمز مصادقة Firebase موثق لقراءة الخدمة'), {
      code: 'unauthenticated',
    });
  }

  const validatedUrl = validateInspectorServiceUrl(inspectorUrl, allowLocalHttpForTest);
  const rawUrl = validatedUrl.toString().replace(/\/$/, '');
  const targetEndpoint = `${rawUrl}/inspectCompanyApk`;

  let iamOidcToken = '';
  if (typeof getIdTokenFn === 'function') {
    iamOidcToken = await getIdTokenFn(rawUrl);
  } else {
    try {
      const {GoogleAuth} = safeRequire('google-auth-library', {});
      if (typeof GoogleAuth === 'function') {
        const googleAuth = new GoogleAuth();
        const client = await googleAuth.getIdTokenClient(rawUrl);
        iamOidcToken = client.idTokenProvider?.fetchIdToken
          ? await client.idTokenProvider.fetchIdToken(rawUrl)
          : '';
      }
    } catch {
      // GoogleAuth unavailable or failed
    }
  }

  if (!iamOidcToken) {
    throw Object.assign(new Error('فشل الحصول على رمز IAM لمصادقة خدمة Cloud Run'), {
      code: 'unauthenticated',
    });
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${iamOidcToken}`,
    'X-Firebase-Auth': `Bearer ${firebaseAuthToken}`,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let bodyText = '';
  try {
    response = await fetchFn(targetEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({data: {appId}}),
      redirect: 'manual',
      signal: controller.signal,
    });

    if (response && [301, 302, 303, 307, 308].includes(response.status)) {
      throw Object.assign(
        new Error('تم رفض الطلب: خدمة الفحص الخادمية حاولت إعادة التوجيه (Redirects Blocked)'),
        {code: 'failed-precondition'}
      );
    }

    if (response && typeof response.text === 'function') {
      bodyText = await response.text();
    }
  } catch (netErr) {
    const isAbort = netErr.name === 'AbortError' || netErr.code === 20;
    const errMsg = isAbort
      ? `انتهت مهلة الاتصال بخدمة الفحص الخادمية (${timeoutMs / 1000} ثانية)`
      : netErr.message || 'تعذر الاتصال بخدمة فحص APK الخادمية';

    const appRef = firestoreDb.doc(`companyApps/${appId}`);
    if (typeof appRef.update === 'function') {
      await appRef
        .update({
          inspection_status: 'failed',
          inspected_by_server: false,
          inspection_error: errMsg,
          inspected_at: FieldValue.serverTimestamp(),
        })
        .catch(() => {});
    }

    const errCode = netErr.code || (isAbort ? 'deadline-exceeded' : 'unavailable');
    throw Object.assign(new Error(errMsg), {code: errCode});
  } finally {
    clearTimeout(timeoutId);
  }

  let parsed = {};
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    // Non-JSON body
  }

  if (!response.ok) {
    const errCode =
      parsed?.error?.code ||
      (response.status === 403
        ? 'permission-denied'
        : response.status === 401
        ? 'unauthenticated'
        : 'internal');
    const errMsg = parsed?.error?.message || `فشل فحص APK في Cloud Run (رمز الحالة ${response.status})`;

    const appRef = firestoreDb.doc(`companyApps/${appId}`);
    if (typeof appRef.update === 'function') {
      await appRef
        .update({
          inspection_status: 'failed',
          inspected_by_server: false,
          inspection_error: errMsg,
          inspected_at: FieldValue.serverTimestamp(),
        })
        .catch(() => {});
    }

    throw Object.assign(new Error(errMsg), {code: errCode});
  }

  const result = parsed?.result;
  if (!result || result.inspection_status !== 'verified' || result.inspected_by_server !== true) {
    const errMsg = 'نتيجة خدمة الفحص الخادمية غير صالحة أو غير معتمدة صراحةً';
    const appRef = firestoreDb.doc(`companyApps/${appId}`);
    if (typeof appRef.update === 'function') {
      await appRef
        .update({
          inspection_status: 'failed',
          inspected_by_server: false,
          inspection_error: errMsg,
          inspected_at: FieldValue.serverTimestamp(),
        })
        .catch(() => {});
    }

    throw Object.assign(new Error(errMsg), {code: 'failed-precondition'});
  }

  return result;
}

exports.inspectCompanyApk = onCall(options, async request => {
  try {
    const rawAuthHeader = String(
      request.rawRequest?.headers?.authorization ||
        request.rawRequest?.headers?.['x-firebase-auth'] ||
        ''
    );
    const match = rawAuthHeader.match(/^Bearer\s+([^\s]+)$/i);
    const firebaseAuthToken = match ? match[1] : '';

    const inspectorUrl = process.env.CLOUD_RUN_INSPECTOR_URL;
    if (inspectorUrl && typeof inspectorUrl === 'string' && inspectorUrl.trim().length > 0) {
      return await invokeCloudRunInspectorService({
        inspectorUrl,
        appId: request.data?.appId,
        auth: request.auth,
        firebaseAuthToken,
        firestoreDb: db,
      });
    }

    const bucket = getAdminStorageBucket();
    return await executeServerApkInspection({
      appId: request.data?.appId,
      auth: request.auth,
      firestoreDb: db,
      storageReader: async storagePath => {
        const file = bucket.file(storagePath);
        const [metadata] = await file.getMetadata();
        const [buffer] = await file.download();
        return {
          buffer,
          generation: metadata.generation,
          size: Number(metadata.size),
          contentType: metadata.contentType,
        };
      },
    });
  } catch (error) {
    const code = [
      'unauthenticated',
      'permission-denied',
      'invalid-argument',
      'not-found',
      'failed-precondition',
      'deadline-exceeded',
      'unavailable',
    ].includes(error.code)
      ? error.code
      : 'internal';
    throw new HttpsError(code, error.message || 'فشل الفحص الخادمي لحزمة APK');
  }
});

exports.getTaskDownloadAuthorization = onCall(options, async request => {
  try {
    const bucket = getAdminStorageBucket();
    return await authorizeTaskApkDownload({
      auth: request.auth,
      uid: request.data?.uid,
      cmdId: request.data?.cmdId,
      appId: request.data?.appId,
      firestoreDb: db,
      storageSigner: async ({storagePath, expectedGeneration, expiresAtMs}) => {
        const file = bucket.file(storagePath);
        const [metadata] = await file.getMetadata();
        if (expectedGeneration && String(metadata.generation) !== String(expectedGeneration)) {
          throw Object.assign(
            new Error('تغيرت نسخة الملف في التخزين بعد الاعتماد؛ تم حظر التنزيل'),
            {code: 'permission-denied'}
          );
        }
        const [url] = await file.getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: expiresAtMs,
        });
        return {url, expiresAtMs};
      },
    });
  } catch (error) {
    const code = [
      'unauthenticated',
      'permission-denied',
      'invalid-argument',
      'not-found',
      'failed-precondition',
    ].includes(error.code)
      ? error.code
      : 'internal';
    throw new HttpsError(code, error.message || 'رفض تفويض تنزيل الحزمة');
  }
});

const deps = {
  async read(uid) {
    const [enrollment, endpoint] = await db.getAll(db.doc(`enrollments/${uid}`), db.doc(`devicePush/${uid}`));
    return {approved: enrollment.data()?.approved === true, endpoint: endpoint.data()};
  },
  send: message => getMessaging().send(message),
  async removeIfCurrent(uid, token) {
    const ref = db.doc(`devicePush/${uid}`);
    await db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (current.data()?.token === token) tx.delete(ref);
    });
  }
};

async function wake(event) {
  if (Date.now() - Date.parse(event.time) > 60 * 60 * 1000) {
    logger.warn('push_event_expired');
    return;
  }
  try {
    const outcome = await dispatch(event.params.uid, deps);
    logger.info('policy_push_dispatch', {eventId: event.id, outcome});
  } catch (error) {
    logger.error('policy_push_failed', {eventId: event.id, code: error.code || 'unknown'});
    throw new Error('Policy push dispatch failed');
  }
}

exports.mdmPolicyChanged = onDocumentWritten({...options, document: 'policies/{uid}', retry: true}, wake);
exports.mdmEnrollmentChanged = onDocumentWritten({...options, document: 'enrollments/{uid}', retry: true}, async event => {
  if (event.data?.after.data()?.approved === true) await wake(event);
});
exports.mdmPushRegistered = onDocumentWritten({...options, document: 'devicePush/{uid}', retry: true}, async event => {
  if (endpointChanged(event.data?.before.data(), event.data?.after.data())) await wake(event);
});
exports.mdmKioskChanged = onDocumentWritten({...options, document: 'kioskPolicies/{uid}', retry: true}, wake);

exports.cleanupOldLocationPoints = onSchedule({...options, schedule: 'every 24 hours'}, async () => {
  const cutoffTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffTime);
  logger.info('running_scheduled_location_cleanup', {cutoffDate});

  const devicesSnap = await db.collection('deviceLocations').get();
  let totalDeleted = 0;

  for (const deviceDoc of devicesSnap.docs) {
    const pointsRef = deviceDoc.ref.collection('points');
    const oldPointsSnap = await pointsRef.where('recorded_at', '<', cutoffDate).limit(500).get();
    if (!oldPointsSnap.empty) {
      const batch = db.batch();
      oldPointsSnap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      totalDeleted += oldPointsSnap.size;
    }
  }

  if (totalDeleted > 0) {
    await db.collection('auditLogs').add({
      actor_uid: 'system_scheduler',
      actor_email: 'scheduler@company.internal',
      target_uid: 'fleet_all',
      action: 'clean_locations',
      summary: `تنظيف خادمي مجدول لنقاط المسار الأقدم من 30 يوماً (حذف ${totalDeleted} نقطة)`,
      before: {retention_days: 30},
      after: {deleted_points: totalDeleted, cutoff_iso: cutoffDate.toISOString()},
      created_at: FieldValue.serverTimestamp(),
    });
  }
  logger.info('scheduled_location_cleanup_complete', {totalDeleted});
});

exports.onCommandCompletedKioskSync = onDocumentWritten(
  {...options, document: 'deviceCommands/{uid}/commands/{cmdId}', retry: true},
  async event => {
    const afterData = event.data?.after.data();
    if (!afterData) return;

    const uid = event.params.uid;
    const cmdId = event.params.cmdId;

    if (afterData.status === 'executed') {
      await processCommandKioskSync({
        uid,
        cmdId,
        firestoreDb: db,
        wakeFn: () => wake(event),
      });
    }
  }
);

exports.onInventoryUpdatedKioskSync = onDocumentWritten(
  {...options, document: 'deviceAppInventory/{uid}', retry: true},
  async event => {
    const afterData = event.data?.after.data();
    if (!afterData || !Array.isArray(afterData.apps) || afterData.apps.length === 0) return;

    const uid = event.params.uid;
    await processInventoryUpdatedKioskSync({
      uid,
      firestoreDb: db,
      wakeFn: () => wake(event),
    });
  }
);

// Export core logic helpers for direct unit/integration verification
exports._testHelpers = {
  verifyAdminAuth,
  executeServerApkInspection,
  authorizeTaskApkDownload,
  processCommandKioskSync,
  processInventoryUpdatedKioskSync,
  invokeCloudRunInspectorService,
  validateInspectorServiceUrl,
};
