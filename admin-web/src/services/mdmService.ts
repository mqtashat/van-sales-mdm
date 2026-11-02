import {
  collection,
  doc,
  getDocFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  reload,
  sendEmailVerification,
  type User,
} from 'firebase/auth';
import {
  MDM_AGENT_PACKAGE_NAME,
  type AdminDocCheckStatus,
  type AdminIdentity,
  type AuditActionType,
  type AuditLogDoc,
  type BulkActionPlanItem,
  type BulkDeviceExecutionResult,
  type DeviceAppInventoryDoc,
  type DeviceMetadataDoc,
  type DeviceStatusDoc,
  type EnrollmentDoc,
  type PolicyDoc,
} from '../types/mdm.ts';
import {
  HARDCODED_PROTECTED_PACKAGES,
  parseAppInventoryData,
  parseDeviceStatusData,
  parseEnrollmentData,
  parsePolicyData,
  sanitizeManualUid,
  validatePackageName,
} from '../utils/validation.ts';
import {
  handleFirestoreError,
  OperationType,
  translateFirestoreErrorAr,
} from './firebaseClient.ts';

/**
 * Classifies an error or snapshot from checking /admins/{uid} on the server.
 * Pure helper exported for direct unit testing.
 */
export function classifyAdminDocServerResult(input: {
  emailVerified: boolean;
  snapshotExists?: boolean;
  snapshotData?: Record<string, unknown>;
  error?: unknown;
}): {
  hasAdminDocRecord: boolean;
  status: AdminDocCheckStatus;
  detail: string;
} {
  if (!input.emailVerified) {
    return {
      hasAdminDocRecord: false,
      status: 'not_checked_unverified_email',
      detail: 'لم يُجرَ فحص وثيقة المسؤول (admins/{uid}) بعد لأن البريد الإلكتروني غير موثق.',
    };
  }

  if (input.error !== undefined && input.error !== null) {
    const code = (input.error as { code?: string })?.code || '';
    const msg =
      input.error instanceof Error ? input.error.message : String(input.error);

    if (
      code === 'permission-denied' ||
      code.endsWith('/permission-denied') ||
      msg.includes('Missing or insufficient permissions') ||
      msg.includes('permission-denied') ||
      msg.includes('PERMISSION_DENIED')
    ) {
      return {
        hasAdminDocRecord: false,
        status: 'permission_denied',
        detail:
          'رفض الخادم قراءة admins/{uid} (permission-denied). هذا يعني عادةً أن قواعد firestore.rules المحلية لم تُنشر بعد في مشروع vansales-mdm.',
      };
    }

    return {
      hasAdminDocRecord: false,
      status: 'network_or_unavailable',
      detail:
        'تعذر الاتصال بخادم Firestore للتحقق من وثيقة admins/{uid}. تحقق من اتصال الإنترنت أو إعدادات المشروع.',
    };
  }

  if (!input.snapshotExists) {
    return {
      hasAdminDocRecord: false,
      status: 'missing_or_inactive',
      detail:
        'وثيقة المسؤول غير موجودة في المجموعة admins/{uid}. أنشئها من Firebase Console بالحقل active: true (boolean).',
    };
  }

  const activeVal = input.snapshotData?.active;
  if (activeVal !== true) {
    return {
      hasAdminDocRecord: false,
      status: 'missing_or_inactive',
      detail: `وثيقة admins/{uid} موجودة في الخادم لكن الحقل active لا يساوي القيمة المنطقية true (القيمة الحالية: ${JSON.stringify(activeVal)}).`,
    };
  }

  return {
    hasAdminDocRecord: true,
    status: 'granted',
    detail: 'وثيقة المسؤول في admins/{uid} موجودة ومفعّلة (active: true).',
  };
}

/**
 * Evaluates full AdminIdentity given user properties, token claims, and admin doc server check.
 * Notice: If hasCustomAdminClaim is true (and user is non-anonymous + emailVerified),
 * failure to read /admins/{uid} NEVER invalidates the valid Custom Claim!
 */
export function evaluateAdminAuthorization(params: {
  uid: string;
  email: string;
  emailVerified: boolean;
  isAnonymous: boolean;
  signInProvider: string;
  hasCustomAdminClaim: boolean;
  adminDocResult: {
    hasAdminDocRecord: boolean;
    status: AdminDocCheckStatus;
    detail: string;
  };
}): AdminIdentity {
  const {
    uid,
    email,
    emailVerified,
    isAnonymous,
    signInProvider,
    hasCustomAdminClaim,
    adminDocResult,
  } = params;

  const isAuthorizedAdmin =
    !isAnonymous &&
    Boolean(email) &&
    emailVerified === true &&
    (hasCustomAdminClaim === true || adminDocResult.hasAdminDocRecord === true);

  return {
    uid,
    email,
    emailVerified,
    isAnonymous,
    hasCustomAdminClaim,
    hasAdminDocRecord: adminDocResult.hasAdminDocRecord,
    adminDocCheckStatus: adminDocResult.status,
    adminDocCheckDetail: adminDocResult.detail,
    isAuthorizedAdmin,
    signInProvider,
  };
}

/**
 * Inspects the signed-in Firebase User using a server read (getDocFromServer)
 * for /admins/{uid} and distinguishes between:
 *  a) missing or inactive document
 *  b) permission-denied
 *  c) network / connection error
 *  d) not checked yet because email is unverified
 */
export async function verifyAdminIdentity(
  db: Firestore,
  user: User,
  forceRefreshToken: boolean = false,
  deps?: {
    readAdminDocFromServer?: (
      uid: string
    ) => Promise<{ exists: boolean; data?: Record<string, unknown> }>;
  }
): Promise<AdminIdentity> {
  if (forceRefreshToken && typeof user.getIdToken === 'function') {
    await user.getIdToken(true);
  }
  const tokenResult = await user.getIdTokenResult(forceRefreshToken);
  const signInProvider =
    tokenResult.signInProvider || (user.isAnonymous ? 'anonymous' : 'password');
  const isAnonymous = Boolean(user.isAnonymous || signInProvider === 'anonymous');
  const email = user.email || '';
  const emailVerified = user.emailVerified === true;
  const hasCustomAdminClaim = tokenResult.claims?.admin === true;

  let adminDocResult: {
    hasAdminDocRecord: boolean;
    status: AdminDocCheckStatus;
    detail: string;
  };

  if (isAnonymous || !email || !emailVerified) {
    adminDocResult = classifyAdminDocServerResult({ emailVerified: false });
  } else {
    try {
      if (deps?.readAdminDocFromServer) {
        const res = await deps.readAdminDocFromServer(user.uid);
        adminDocResult = classifyAdminDocServerResult({
          emailVerified: true,
          snapshotExists: res.exists,
          snapshotData: res.data,
        });
      } else {
        const adminSnap = await getDocFromServer(doc(db, 'admins', user.uid));
        adminDocResult = classifyAdminDocServerResult({
          emailVerified: true,
          snapshotExists: adminSnap.exists(),
          snapshotData: adminSnap.exists()
            ? (adminSnap.data() as Record<string, unknown>)
            : undefined,
        });
      }
    } catch (err) {
      adminDocResult = classifyAdminDocServerResult({
        emailVerified: true,
        error: err,
      });
    }
  }

  return evaluateAdminAuthorization({
    uid: user.uid,
    email,
    emailVerified,
    isAnonymous,
    signInProvider,
    hasCustomAdminClaim,
    adminDocResult,
  });
}

/**
 * Reloads the current user from Firebase Auth, refreshes the ID token,
 * and re-evaluates email verification & admin authorization.
 */
export async function reloadUserAndVerifyAdmin(
  db: Firestore,
  user: User,
  deps?: {
    reloadFn?: (u: User) => Promise<void>;
    readAdminDocFromServer?: (
      uid: string
    ) => Promise<{ exists: boolean; data?: Record<string, unknown> }>;
  }
): Promise<AdminIdentity> {
  if (deps?.reloadFn) {
    await deps.reloadFn(user);
  } else {
    await reload(user);
  }
  return verifyAdminIdentity(db, user, true, {
    readAdminDocFromServer: deps?.readAdminDocFromServer,
  });
}

/**
 * Sends a verification email to the currently signed-in user and translates Firebase errors to Arabic.
 */
export async function sendVerificationEmailAr(
  user: User,
  sendFn: (u: User) => Promise<void> = sendEmailVerification
): Promise<{ ok: boolean; message: string }> {
  try {
    await sendFn(user);
    return {
      ok: true,
      message: `تم إرسال رسالة تأكيد البريد إلى (${user.email}). افتح بريدك الإلكتروني (وتحقق من مجلد الرسائل غير المرغوب فيها Spam) واضغط على رابط التفعيل، ثم اضغط زر «أكدت بريدي — تحقق الآن».`,
    };
  } catch (err) {
    const code = (err as { code?: string })?.code || '';
    const msg = err instanceof Error ? err.message : String(err);

    if (code === 'auth/too-many-requests' || msg.includes('too-many-requests')) {
      return {
        ok: false,
        message:
          'تم إرسال عدة طلبات تأكيد خلال وقت قصير (too-many-requests). يرجى التحقق من بريدك الوارد أو الانتظار بضع دقائق قبل إعادة الإرسال.',
      };
    }
    if (code === 'auth/network-request-failed' || msg.includes('network-request-failed')) {
      return {
        ok: false,
        message: 'تعذر إرسال رسالة التأكيد بسبب انقطاع الاتصال بالشبكة. تحقق من الإنترنت وأعد المحاولة.',
      };
    }
    if (code === 'auth/user-token-expired' || msg.includes('user-token-expired')) {
      return {
        ok: false,
        message: 'انتهت صلاحية الجلسة الحالية. يرجى تسجيل الخروج وإعادة تسجيل الدخول.',
      };
    }

    return {
      ok: false,
      message: `تعذر إرسال رسالة تأكيد البريد: ${msg}`,
    };
  }
}

export interface FleetRealtimeCallbacks {
  onEnrollments: (map: Record<string, EnrollmentDoc>) => void;
  onPolicies: (map: Record<string, PolicyDoc>) => void;
  onStatuses: (map: Record<string, DeviceStatusDoc>) => void;
  onMetadata: (map: Record<string, DeviceMetadataDoc>) => void;
  onAuditLogs: (logs: AuditLogDoc[]) => void;
  onPermissionError: (errorMessage: string, rawError: unknown) => void;
}

/**
 * Attaches a single set of collection listeners ONLY after the user is verified as an admin.
 * Strictly validates field types without Boolean(value) coercion.
 */
export function subscribeToFleetData(
  db: Firestore,
  callbacks: FleetRealtimeCallbacks
): Unsubscribe {
  const unsubs: Unsubscribe[] = [];

  // 1. enrollments (strict boolean check on approved)
  unsubs.push(
    onSnapshot(
      collection(db, 'enrollments'),
      (snap) => {
        const next: Record<string, EnrollmentDoc> = {};
        snap.forEach((docSnap) => {
          next[docSnap.id] = parseEnrollmentData(
            docSnap.data() as Record<string, unknown>
          );
        });
        callbacks.onEnrollments(next);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, 'enrollments');
        } catch (wrapped) {
          callbacks.onPermissionError('تعذر قراءة مجموعة enrollments من Firestore.', wrapped);
        }
      }
    )
  );

  // 2. policies (strict validation without replacing invalid schema_version or clearing corrupted blocked_apps)
  unsubs.push(
    onSnapshot(
      collection(db, 'policies'),
      (snap) => {
        const next: Record<string, PolicyDoc> = {};
        snap.forEach((docSnap) => {
          next[docSnap.id] = parsePolicyData(
            docSnap.data() as Record<string, unknown>
          );
        });
        callbacks.onPolicies(next);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, 'policies');
        } catch (wrapped) {
          callbacks.onPermissionError('تعذر قراءة مجموعة policies من Firestore.', wrapped);
        }
      }
    )
  );

  // 3. deviceStatus (strict boolean & integer checks)
  unsubs.push(
    onSnapshot(
      collection(db, 'deviceStatus'),
      (snap) => {
        const next: Record<string, DeviceStatusDoc> = {};
        snap.forEach((docSnap) => {
          next[docSnap.id] = parseDeviceStatusData(
            docSnap.data() as Record<string, unknown>
          );
        });
        callbacks.onStatuses(next);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, 'deviceStatus');
        } catch (wrapped) {
          callbacks.onPermissionError('تعذر قراءة مجموعة deviceStatus من Firestore.', wrapped);
        }
      }
    )
  );

  // 4. deviceMetadata
  unsubs.push(
    onSnapshot(
      collection(db, 'deviceMetadata'),
      (snap) => {
        const next: Record<string, DeviceMetadataDoc> = {};
        snap.forEach((docSnap) => {
          const d = docSnap.data();
          next[docSnap.id] = {
            device_name: typeof d.device_name === 'string' ? d.device_name : '',
            rep_name: typeof d.rep_name === 'string' ? d.rep_name : '',
            updated_at: d.updated_at ?? null,
            updated_by_uid: typeof d.updated_by_uid === 'string' ? d.updated_by_uid : '',
            updated_by_email: typeof d.updated_by_email === 'string' ? d.updated_by_email : '',
          };
        });
        callbacks.onMetadata(next);
      },
      () => {
        callbacks.onMetadata({});
      }
    )
  );

  // 5. auditLogs (latest 100 entries)
  const auditQuery = query(
    collection(db, 'auditLogs'),
    orderBy('created_at', 'desc'),
    limit(100)
  );
  unsubs.push(
    onSnapshot(
      auditQuery,
      (snap) => {
        const list: AuditLogDoc[] = [];
        snap.forEach((docSnap) => {
          const d = docSnap.data();
          list.push({
            id: docSnap.id,
            actor_uid: typeof d.actor_uid === 'string' ? d.actor_uid : '',
            actor_email: typeof d.actor_email === 'string' ? d.actor_email : '',
            target_uid: typeof d.target_uid === 'string' ? d.target_uid : '',
            action: (d.action as AuditActionType) || 'update_policy',
            summary: typeof d.summary === 'string' ? d.summary : '',
            before: (d.before as Record<string, unknown>) || {},
            after: (d.after as Record<string, unknown>) || {},
            created_at: d.created_at ?? null,
          });
        });
        callbacks.onAuditLogs(list);
      },
      () => {
        callbacks.onAuditLogs([]);
      }
    )
  );

  return () => {
    unsubs.forEach((u) => u());
  };
}

function createAuditId(): string {
  const rand = Math.random().toString(36).substring(2, 10);
  return `log_${Date.now()}_${rand}`;
}

/**
 * Sets enrollments/{uid}.approved = true or false atomically with an audit log record.
 * Enforces strict boolean type on approved.
 */
export async function setDeviceApproval(
  db: Firestore,
  rawUid: string,
  approved: boolean,
  actor: AdminIdentity,
  optionalMetadata?: { device_name: string; rep_name: string }
): Promise<void> {
  if (typeof approved !== 'boolean') {
    throw new Error('قيمة الاعتماد (approved) يجب أن تكون boolean صريحًا.');
  }
  const sanitized = sanitizeManualUid(rawUid);
  if (!sanitized.valid) {
    throw new Error(sanitized.error);
  }
  const uid = sanitized.uid;
  const enrollmentRef = doc(db, 'enrollments', uid);
  const auditRef = doc(db, 'auditLogs', createAuditId());

  try {
    await runTransaction(db, async (tx) => {
      const currentSnap = await tx.get(enrollmentRef);
      const beforeState = currentSnap.exists()
        ? { approved: currentSnap.data().approved }
        : { exists: false };

      tx.set(enrollmentRef, { approved });

      if (
        optionalMetadata &&
        (optionalMetadata.device_name.trim() || optionalMetadata.rep_name.trim())
      ) {
        const metaRef = doc(db, 'deviceMetadata', uid);
        tx.set(metaRef, {
          device_name: optionalMetadata.device_name.trim().slice(0, 120),
          rep_name: optionalMetadata.rep_name.trim().slice(0, 120),
          updated_at: serverTimestamp(),
          updated_by_uid: actor.uid,
          updated_by_email: actor.email,
        });
      }

      const action: AuditActionType = approved ? 'approve_device' : 'revoke_approval';
      const summary = approved
        ? `اعتماد الجهاز (${uid}) وتفعيل صلاحية قراءة السياسة`
        : `إلغاء اعتماد الجهاز (${uid}) وإيقاف وصوله للخادم (القيود السابقة قد تبقى على الهاتف)`;

      tx.set(auditRef, {
        actor_uid: actor.uid,
        actor_email: actor.email,
        target_uid: uid,
        action,
        summary,
        before: beforeState,
        after: { approved },
        created_at: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `enrollments/${uid}`);
  }
}

/**
 * Updates separate administrative metadata in deviceMetadata/{uid}.
 * Never touches or overwrites enrollments/{uid}, policies/{uid}, or deviceStatus/{uid}.
 */
export async function saveDeviceMetadata(
  db: Firestore,
  rawUid: string,
  deviceName: string,
  repName: string,
  actor: AdminIdentity
): Promise<void> {
  const sanitized = sanitizeManualUid(rawUid);
  if (!sanitized.valid) {
    throw new Error(sanitized.error);
  }
  const uid = sanitized.uid;
  const cleanDeviceName = deviceName.trim().slice(0, 120);
  const cleanRepName = repName.trim().slice(0, 120);

  const metaRef = doc(db, 'deviceMetadata', uid);
  const auditRef = doc(db, 'auditLogs', createAuditId());

  try {
    await runTransaction(db, async (tx) => {
      const currentSnap = await tx.get(metaRef);
      const before = currentSnap.exists()
        ? {
            device_name: currentSnap.data().device_name || '',
            rep_name: currentSnap.data().rep_name || '',
          }
        : { device_name: '', rep_name: '' };

      tx.set(metaRef, {
        device_name: cleanDeviceName,
        rep_name: cleanRepName,
        updated_at: serverTimestamp(),
        updated_by_uid: actor.uid,
        updated_by_email: actor.email,
      });

      tx.set(auditRef, {
        actor_uid: actor.uid,
        actor_email: actor.email,
        target_uid: uid,
        action: 'update_metadata' satisfies AuditActionType,
        summary: `تحديث البيانات الوصفية للجهاز (${uid}): الجهاز "${cleanDeviceName || 'بدون اسم'}" — المندوب "${cleanRepName || 'بدون اسم'}"`,
        before,
        after: {
          device_name: cleanDeviceName,
          rep_name: cleanRepName,
        },
        created_at: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `deviceMetadata/${uid}`);
  }
}

/**
 * Validates conflict detection and computes the next monotonic revision for a policy transaction.
 * Exported as a pure function so unit tests can directly verify conflict and corruption rules.
 */
export function validatePolicyTransactionState(params: {
  existsNow: boolean;
  serverRawData?: Record<string, unknown>;
  appliedRevisionOnDevice: number;
  expectedCurrentRevision: number | null;
  allowRepairCorrupted?: boolean;
}): { nextRevision: number } {
  const {
    existsNow,
    serverRawData,
    appliedRevisionOnDevice,
    expectedCurrentRevision,
    allowRepairCorrupted,
  } = params;

  if (!existsNow) {
    if (expectedCurrentRevision !== null) {
      throw new Error(
        `تعارض تعديل: السياسة التي كانت محمّلة (الإصدار v${expectedCurrentRevision}) لم تعد موجودة في الخادم.`
      );
    }
    const nextRevision = Math.max(0, appliedRevisionOnDevice) + 1;
    return { nextRevision };
  }

  // Document exists on the server now
  const parsedExisting = parsePolicyData(serverRawData);

  if (expectedCurrentRevision === null) {
    throw new Error(
      `تعارض تعديل: قام مسؤول آخر بإنشاء سياسة لهذا الجهاز (الإصدار v${parsedExisting.revision}) منذ فتحك للصفحة. يرجى مراجعة السياسة المحدثة أولًا حتى لا تُستبدل تعديلاته.`
    );
  }

  if (parsedExisting.isCorrupted && !allowRepairCorrupted) {
    throw new Error(
      `وثيقة السياسة الحالية في الخادم تالفة أو مخالفة للعقد (${(parsedExisting.corruptionErrors || []).join('، ')}). يرجى تفعيل خيار تصحيح السياسة التالفة أولًا قبل الحفظ.`
    );
  }

  if (!parsedExisting.isCorrupted && parsedExisting.revision !== expectedCurrentRevision) {
    throw new Error(
      `تعارض تعديل: قام مسؤول آخر بتحديث السياسة في الخادم من الإصدار v${expectedCurrentRevision} إلى v${parsedExisting.revision} أثناء تحريرك لها. لم يتم الحفظ لمنع الكتابة فوق تعديلاته.`
    );
  }

  const currentPolicyRev = parsedExisting.revision > 0 ? parsedExisting.revision : 0;
  const nextRevision = Math.max(currentPolicyRev, appliedRevisionOnDevice) + 1;
  return { nextRevision };
}

/**
 * Saves or creates policies/{uid} using a Firestore transaction with:
 * 1. Strict type checks (no Boolean(value) coercion).
 * 2. Concurrent admin conflict detection via expectedCurrentRevision.
 * 3. Monotonic revision increment above both current policy.revision and deviceStatus.applied_revision.
 */
export async function saveDevicePolicyTransaction(
  db: Firestore,
  rawUid: string,
  input: {
    block_tethering: boolean;
    blocked_apps: string[];
    expectedCurrentRevision: number | null;
    allowRepairCorrupted?: boolean;
  },
  actor: AdminIdentity
): Promise<{ savedRevision: number }> {
  const sanitized = sanitizeManualUid(rawUid);
  if (!sanitized.valid) {
    throw new Error(sanitized.error);
  }
  if (typeof input.block_tethering !== 'boolean') {
    throw new Error('الحقل block_tethering يجب أن يكون قيمة منطقية صريحة (boolean).');
  }
  if (!Array.isArray(input.blocked_apps)) {
    throw new Error('الحقل blocked_apps يجب أن يكون مصفوفة.');
  }

  const uid = sanitized.uid;

  // Validate every package in blocked_apps thoroughly before transaction
  const deduplicatedApps: string[] = [];
  for (const pkg of input.blocked_apps) {
    if (typeof pkg !== 'string') {
      throw new Error('جميع عناصر blocked_apps يجب أن تكون نصوصًا.');
    }
    const trimmed = pkg.trim();
    if (trimmed === MDM_AGENT_PACKAGE_NAME || HARDCODED_PROTECTED_PACKAGES[trimmed]) {
      throw new Error(`لا يُسمح بحظر الحزمة المحمية: ${trimmed}`);
    }
    const validation = validatePackageName(trimmed, deduplicatedApps);
    if (!validation.valid) {
      throw new Error(validation.error || `اسم الحزمة غير صالح: ${trimmed}`);
    }
    deduplicatedApps.push(trimmed);
  }

  const policyRef = doc(db, 'policies', uid);
  const statusRef = doc(db, 'deviceStatus', uid);
  const auditRef = doc(db, 'auditLogs', createAuditId());

  try {
    const savedRevision = await runTransaction(db, async (tx) => {
      const [policySnap, statusSnap] = await Promise.all([
        tx.get(policyRef),
        tx.get(statusRef),
      ]);

      const existsNow = policySnap.exists();
      const serverRawData = existsNow
        ? (policySnap.data() as Record<string, unknown>)
        : undefined;

      const appliedRev =
        statusSnap.exists() &&
        typeof statusSnap.data().applied_revision === 'number' &&
        Number.isInteger(statusSnap.data().applied_revision)
          ? (statusSnap.data().applied_revision as number)
          : 0;

      const { nextRevision } = validatePolicyTransactionState({
        existsNow,
        serverRawData,
        appliedRevisionOnDevice: appliedRev,
        expectedCurrentRevision: input.expectedCurrentRevision,
        allowRepairCorrupted: input.allowRepairCorrupted,
      });

      const fullPolicyPayload = {
        schema_version: 1 as const,
        revision: nextRevision,
        block_tethering: input.block_tethering,
        blocked_apps: deduplicatedApps,
      };

      const beforeSnapshot = existsNow && serverRawData
        ? {
            schema_version: serverRawData.schema_version,
            revision: serverRawData.revision,
            block_tethering: serverRawData.block_tethering,
            blocked_apps: serverRawData.blocked_apps,
          }
        : { exists: false };

      tx.set(policyRef, fullPolicyPayload);

      const action: AuditActionType = existsNow ? 'update_policy' : 'create_policy';
      const summary = existsNow
        ? `تحديث سياسة الجهاز (${uid}) إلى الإصدار ${nextRevision}: منع المشاركة=${fullPolicyPayload.block_tethering ? 'مفعّل' : 'ملغى'}، تطبيقات محظورة=${deduplicatedApps.length}`
        : `إنشاء السياسة الأولى للجهاز (${uid}) بالإصدار ${nextRevision}: منع المشاركة=${fullPolicyPayload.block_tethering ? 'مفعّل' : 'ملغى'}، تطبيقات محظورة=${deduplicatedApps.length}`;

      tx.set(auditRef, {
        actor_uid: actor.uid,
        actor_email: actor.email,
        target_uid: uid,
        action,
        summary,
        before: beforeSnapshot,
        after: fullPolicyPayload as unknown as Record<string, unknown>,
        created_at: serverTimestamp(),
      });

      return nextRevision;
    });

    return { savedRevision };
  } catch (error) {
    // If it is a conflict or validation error thrown intentionally inside the transaction, rethrow directly
    if (error instanceof Error && (error.message.startsWith('تعارض تعديل:') || error.message.startsWith('وثيقة السياسة الحالية'))) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `policies/${uid}`);
  }
}

/**
 * Subscribes to real-time app inventory for a specific device.
 */
export function subscribeToDeviceAppInventory(
  db: Firestore,
  uid: string,
  callbacks: {
    onData: (inventory: DeviceAppInventoryDoc | null) => void;
    onError: (err: unknown) => void;
  }
): Unsubscribe {
  const docRef = doc(db, 'deviceAppInventory', uid);
  return onSnapshot(
    docRef,
    (snap) => {
      if (!snap.exists()) {
        callbacks.onData(null);
      } else {
        callbacks.onData(parseAppInventoryData(snap.data() as Record<string, unknown>));
      }
    },
    (err) => {
      callbacks.onError(err);
    }
  );
}

/**
 * Executes a planned bulk action across multiple devices with bounded concurrency (3 devices at a time).
 * Each device's policy is updated within its own isolated transaction with revision conflict detection.
 */
export async function executeBulkDeviceAction(
  db: Firestore,
  planItems: BulkActionPlanItem[],
  actor: AdminIdentity,
  options?: {
    concurrency?: number;
    cancelSignal?: { isCancelled: boolean };
    onDeviceCompleted?: (result: BulkDeviceExecutionResult) => void;
  }
): Promise<BulkDeviceExecutionResult[]> {
  const concurrency = Math.max(1, options?.concurrency || 3);
  const results: BulkDeviceExecutionResult[] = [];
  const queue = [...planItems];

  const runWorker = async () => {
    while (queue.length > 0) {
      if (options?.cancelSignal?.isCancelled) {
        break;
      }
      const item = queue.shift();
      if (!item) break;

      // Handle ineligible or unneeded updates without network hits
      if (!item.eligible) {
        const skippedResult: BulkDeviceExecutionResult = {
          uid: item.uid,
          deviceName: item.deviceName,
          repName: item.repName,
          status: 'skipped',
          message: item.skipReason || 'تم تخطي الجهاز لعدم استيفاء الشروط.',
        };
        results.push(skippedResult);
        options?.onDeviceCompleted?.(skippedResult);
        continue;
      }

      // Execute transaction for this device
      try {
        const { savedRevision } = await saveDevicePolicyTransaction(
          db,
          item.uid,
          {
            block_tethering: item.nextBlockTethering,
            blocked_apps: item.nextBlockedApps,
            expectedCurrentRevision: item.currentRevision,
          },
          actor
        );

        const successResult: BulkDeviceExecutionResult = {
          uid: item.uid,
          deviceName: item.deviceName,
          repName: item.repName,
          status: 'saved_pending_phone',
          savedRevision,
          message: `تم حفظ الإصدار v${savedRevision} بنجاح، بانتظار مزامنة وتأكيد الهاتف.`,
        };
        results.push(successResult);
        options?.onDeviceCompleted?.(successResult);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isConflict = errMsg.startsWith('تعارض تعديل:');
        const failResult: BulkDeviceExecutionResult = {
          uid: item.uid,
          deviceName: item.deviceName,
          repName: item.repName,
          status: isConflict ? 'conflict' : 'error',
          message: isConflict ? errMsg : translateFirestoreErrorAr(err),
          error: errMsg,
        };
        results.push(failResult);
        options?.onDeviceCompleted?.(failResult);
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => runWorker());
  await Promise.all(workers);

  // If cancelled, record remaining items as skipped
  if (options?.cancelSignal?.isCancelled) {
    while (queue.length > 0) {
      const remaining = queue.shift()!;
      const cancelResult: BulkDeviceExecutionResult = {
        uid: remaining.uid,
        deviceName: remaining.deviceName,
        repName: remaining.repName,
        status: 'skipped',
        message: 'تم إلغاء الإجراء قبل بدء التنفيذ على هذا الجهاز.',
      };
      results.push(cancelResult);
      options?.onDeviceCompleted?.(cancelResult);
    }
  }

  return results;
}

