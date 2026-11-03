import {
  addDoc,
  collection,
  doc,
  getDocFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
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
  type AppInstallPolicyDoc,
  type AuditActionType,
  type AuditLogDoc,
  type BulkActionPlanItem,
  type BulkDeviceExecutionResult,
  type CompanyAppDoc,
  type DeviceAppInventoryDoc,
  type DeviceLocationPoint,
  type DeviceMetadataDoc,
  type DeviceStatusDoc,
  type EnrollmentDoc,
  type InstallRequestDoc,
  type LocationPolicyDoc,
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
          'رفض الخادم قراءة admins/{uid} (permission-denied). تحقق من صلاحية الحساب وتوثيق البريد وإعدادات المشروع وقاعدة البيانات وقواعد الأمان المعتمدة.',
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
 * Sets the archived status of a device in deviceMetadata/{uid} and creates an auditLog entry atomically.
 * Only authorized admins can archive or restore.
 * Preserves enrollments, policies, status, and phone enforcement without deleting documents or Auth accounts.
 */
export async function setDeviceArchivedStatus(
  db: Firestore,
  rawUid: string,
  archived: boolean,
  actor: AdminIdentity
): Promise<void> {
  if (!actor.isAuthorizedAdmin) {
    throw new Error('غير مصرح: يجب أن تكون مسؤولاً معتمداً لتنفيذ هذا الإجراء.');
  }
  const sanitized = sanitizeManualUid(rawUid);
  if (!sanitized.valid) {
    throw new Error(sanitized.error);
  }
  const uid = sanitized.uid;

  const metaRef = doc(db, 'deviceMetadata', uid);
  const auditRef = doc(db, 'auditLogs', createAuditId());

  try {
    await runTransaction(db, async (tx) => {
      const currentSnap = await tx.get(metaRef);
      const data = currentSnap.exists() ? currentSnap.data() : {};
      const currentDeviceName = typeof data.device_name === 'string' ? data.device_name : '';
      const currentRepName = typeof data.rep_name === 'string' ? data.rep_name : '';
      const wasArchived = data.archived === true;

      const displayName = currentDeviceName || currentRepName || uid;

      tx.set(metaRef, {
        device_name: currentDeviceName,
        rep_name: currentRepName,
        updated_at: serverTimestamp(),
        updated_by_uid: actor.uid,
        updated_by_email: actor.email,
        archived,
        archived_at: archived ? serverTimestamp() : null,
        archived_by_uid: archived ? actor.uid : null,
        archived_by_email: archived ? actor.email : null,
      });

      const action: AuditActionType = archived ? 'archive_device' : 'restore_device';
      const summary = archived
        ? `إزالة الجهاز من القائمة الرئيسية وأرشفته (${uid}): "${displayName}"`
        : `استعادة الجهاز المؤرشف إلى القائمة الرئيسية (${uid}): "${displayName}"`;

      tx.set(auditRef, {
        actor_uid: actor.uid,
        actor_email: actor.email,
        target_uid: uid,
        action,
        summary,
        before: {
          archived: wasArchived,
          device_name: currentDeviceName,
          rep_name: currentRepName,
        },
        after: {
          archived,
          device_name: currentDeviceName,
          rep_name: currentRepName,
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

export function subscribeToAppInstallPolicy(
  db: Firestore,
  uid: string,
  callback: (policy: AppInstallPolicyDoc | null) => void,
  options?: { onError?: (err: Error) => void }
): Unsubscribe {
  const policyRef = doc(db, 'appInstallPolicies', uid);
  return onSnapshot(
    policyRef,
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      const data = snap.data();
      callback({
        schema_version: Number(data.schema_version || 1),
        revision: Number(data.revision || 1),
        block_app_installs: Boolean(data.block_app_installs),
        updated_at: data.updated_at || null,
        updated_by_uid: data.updated_by_uid || '',
        updated_by_email: data.updated_by_email || '',
      });
    },
    (err) => {
      if (options?.onError) {
        options.onError(err);
      }
      callback(null);
    }
  );
}

export async function saveAppInstallPolicy(
  db: Firestore,
  uid: string,
  blockAppInstalls: boolean,
  actor: { uid: string; email: string }
): Promise<number> {
  const policyRef = doc(db, 'appInstallPolicies', uid);
  const auditRef = doc(collection(db, 'auditLogs'));

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(policyRef);
    let nextRevision = 1;
    let beforeData: Record<string, unknown> = {};

    if (snap.exists()) {
      const data = snap.data();
      nextRevision = Number(data.revision || 0) + 1;
      beforeData = data;
    }

    const nextDoc: AppInstallPolicyDoc = {
      schema_version: 1,
      revision: nextRevision,
      block_app_installs: blockAppInstalls,
      updated_at: serverTimestamp() as any,
      updated_by_uid: actor.uid,
      updated_by_email: actor.email,
    };

    tx.set(policyRef, nextDoc);

    tx.set(auditRef, {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: uid,
      action: 'update_install_policy',
      summary: blockAppInstalls
        ? `تفعيل سياسة منع تثبيت التطبيقات (الإصدار v${nextRevision})`
        : `إلغاء سياسة منع تثبيت التطبيقات (الإصدار v${nextRevision})`,
      before: beforeData,
      after: {
        schema_version: 1,
        revision: nextRevision,
        block_app_installs: blockAppInstalls,
      },
      created_at: serverTimestamp(),
    });

    return nextRevision;
  });
}

export function subscribeToLocationPolicy(
  db: Firestore,
  uid: string,
  callback: (policy: LocationPolicyDoc | null) => void,
  options?: { onError?: (err: Error) => void }
): Unsubscribe {
  const policyRef = doc(db, 'locationPolicies', uid);
  return onSnapshot(
    policyRef,
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      const data = snap.data();
      callback({
        schema_version: Number(data.schema_version || 1),
        revision: Number(data.revision || 1),
        enabled: Boolean(data.enabled),
        mode: data.mode === 'work_hours' ? 'work_hours' : 'continuous',
        start_time: data.start_time || '08:00',
        end_time: data.end_time || '18:00',
        work_days: Array.isArray(data.work_days) ? data.work_days : [1, 2, 3, 4, 5],
        sampling_interval_seconds: Number(data.sampling_interval_seconds || 300),
        updated_at: data.updated_at || null,
        updated_by_uid: data.updated_by_uid || '',
        updated_by_email: data.updated_by_email || '',
      });
    },
    (err) => {
      if (options?.onError) {
        options.onError(err);
      }
      callback(null);
    }
  );
}

export async function saveLocationPolicy(
  db: Firestore,
  uid: string,
  policy: Omit<LocationPolicyDoc, 'schema_version' | 'revision'>,
  actor: { uid: string; email: string }
): Promise<number> {
  const policyRef = doc(db, 'locationPolicies', uid);
  const auditRef = doc(collection(db, 'auditLogs'));

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(policyRef);
    let nextRevision = 1;
    let beforeData: Record<string, unknown> = {};

    if (snap.exists()) {
      const data = snap.data();
      nextRevision = Number(data.revision || 0) + 1;
      beforeData = data;
    }

    const nextDoc: LocationPolicyDoc = {
      schema_version: 1,
      revision: nextRevision,
      enabled: policy.enabled,
      mode: policy.mode,
      start_time: policy.start_time,
      end_time: policy.end_time,
      work_days: policy.work_days,
      sampling_interval_seconds: policy.sampling_interval_seconds,
      updated_at: serverTimestamp() as any,
      updated_by_uid: actor.uid,
      updated_by_email: actor.email,
    };

    tx.set(policyRef, nextDoc);

    tx.set(auditRef, {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: uid,
      action: 'update_location_policy',
      summary: policy.enabled
        ? `تفعيل سياسة تتبع الموقع (${policy.mode === 'work_hours' ? 'ساعات العمل' : 'مستمر'}، v${nextRevision})`
        : `تعطيل سياسة تتبع الموقع (v${nextRevision})`,
      before: beforeData,
      after: {
        schema_version: 1,
        revision: nextRevision,
        enabled: policy.enabled,
        mode: policy.mode,
        start_time: policy.start_time,
        end_time: policy.end_time,
        work_days: policy.work_days,
        sampling_interval_seconds: policy.sampling_interval_seconds,
      },
      created_at: serverTimestamp(),
    });

    return nextRevision;
  });
}

export async function deprovisionDevice(
  db: Firestore,
  uid: string,
  reason: string,
  actor: { uid: string; email: string }
): Promise<void> {
  const auditRef = doc(collection(db, 'auditLogs'));
  const cmdRef = doc(collection(db, 'deviceCommands', uid, 'commands'));

  await runTransaction(db, async (tx) => {
    tx.set(cmdRef, {
      type: 'deprovision',
      status: 'pending',
      reason,
      created_at: serverTimestamp(),
      created_by_uid: actor.uid,
      created_by_email: actor.email,
    });

    tx.set(auditRef, {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: uid,
      action: 'deprovision_device',
      summary: `طلب إنهاء إدارة مسؤول الجهاز (Device Owner) المصرّح: ${reason}`,
      before: {},
      after: { deprovision_requested: true, reason },
      created_at: serverTimestamp(),
    });
  });
}

export function subscribeToCompanyApps(
  db: Firestore,
  callback: (apps: CompanyAppDoc[]) => void,
  options?: { onError?: (err: Error) => void }
): Unsubscribe {
  const q = query(collection(db, 'companyApps'), orderBy('created_at', 'desc'), limit(100));
  return onSnapshot(
    q,
    (snap) => {
      const list: CompanyAppDoc[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<CompanyAppDoc, 'id'>),
      }));
      callback(list);
    },
    (err) => {
      if (options?.onError) {
        options.onError(err);
      }
      callback([]);
    }
  );
}

export async function addCompanyApp(
  db: Firestore,
  app: Omit<CompanyAppDoc, 'id' | 'created_at' | 'created_by_uid' | 'created_by_email'>,
  actor: { uid: string; email: string },
  customAppId?: string
): Promise<string> {
  const cleanShaApk = (app.sha256_apk || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  const cleanShaCert = (app.sha256_cert || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();

  if (cleanShaApk.length !== 64) {
    throw new Error('بصمة ملف APK بصيغة SHA-256 غير صالحة؛ يجب أن تتكون من 64 حرفاً ست عشرياً.');
  }

  // SECURITY RULE: Browser/client can NEVER mark an APK as 'verified' or infer verification from hash length.
  // All client-submitted records start strictly as 'pending_inspection' with inspected_by_server = false.
  const inspectionStatus = 'pending_inspection' as const;

  const auditRef = doc(collection(db, 'auditLogs'));
  const docRef = customAppId
    ? doc(db, 'companyApps', customAppId)
    : doc(collection(db, 'companyApps'));

  const storagePath =
    app.storage_path || `company_apps/${docRef.id}/${app.package_name || 'app'}.apk`;

  await runTransaction(db, async (tx) => {
    tx.set(docRef, {
      ...app,
      sha256_apk: cleanShaApk,
      sha256_cert: cleanShaCert,
      storage_path: storagePath,
      inspection_status: inspectionStatus,
      inspected_by_server: false,
      created_at: serverTimestamp(),
      created_by_uid: actor.uid,
      created_by_email: actor.email,
    });

    tx.set(auditRef, {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: 'global',
      action: 'add_company_app',
      summary: `رفع حزمة تطبيق شركة للمعاينة: ${app.app_name} (${app.package_name} v${app.version_name}) - بانتظار الفحص الخادمي`,
      before: {},
      after: {
        app_id: docRef.id,
        package_name: app.package_name,
        version_code: app.version_code,
        storage_path: storagePath,
        inspection_status: inspectionStatus,
        inspected_by_server: false,
      },
      created_at: serverTimestamp(),
    });
  });

  return docRef.id;
}

/**
 * Triggers the authoritative server-side Cloud Function `inspectCompanyApk` to verify
 * the APK's cryptographic signature, content digests, and binary AndroidManifest.xml in Storage.
 */
export async function requestServerApkInspection(
  appId: string,
  invokeCallable?: (name: string, payload: { appId: string }) => Promise<unknown>
): Promise<void> {
  if (!appId) {
    throw new Error('معرّف التطبيق (appId) مطلوب لطلب الفحص الخادمي.');
  }
  if (invokeCallable) {
    await invokeCallable('inspectCompanyApk', { appId });
    return;
  }
  const { getFunctions, httpsCallable } = await import('firebase/functions');
  const { getApp } = await import('firebase/app');
  const functionsInstance = getFunctions(getApp(), 'us-central1');
  const inspectFn = httpsCallable(functionsInstance, 'inspectCompanyApk');
  await inspectFn({ appId });
}

export function subscribeToInstallRequests(
  db: Firestore,
  callback: (reqs: InstallRequestDoc[]) => void,
  options?: { onError?: (err: Error) => void }
): Unsubscribe {
  const q = query(collection(db, 'installRequests'), orderBy('created_at', 'desc'), limit(100));
  return onSnapshot(
    q,
    (snap) => {
      const list: InstallRequestDoc[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<InstallRequestDoc, 'id'>),
      }));
      callback(list);
    },
    (err) => {
      if (options?.onError) {
        options.onError(err);
      }
      callback([]);
    }
  );
}

export async function reviewInstallRequest(
  db: Firestore,
  requestId: string,
  decision: 'approved' | 'rejected',
  notes: string,
  actor: { uid: string; email: string }
): Promise<void> {
  const reqRef = doc(db, 'installRequests', requestId);
  const auditRef = doc(collection(db, 'auditLogs'));

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(reqRef);
    if (!snap.exists()) throw new Error('طلب التثبيت غير موجود');
    const data = snap.data();

    tx.update(reqRef, {
      status: decision,
      admin_notes: notes,
      reviewed_at: serverTimestamp(),
      reviewed_by_uid: actor.uid,
      reviewed_by_email: actor.email,
    });

    tx.set(auditRef, {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: data.device_uid,
      action: decision === 'approved' ? 'approve_install_request' : 'reject_install_request',
      summary: `${decision === 'approved' ? 'الموافقة على' : 'رفض'} طلب تثبيت ${data.app_name} للجهاز ${data.device_uid}`,
      before: { status: data.status },
      after: { status: decision, admin_notes: notes },
      created_at: serverTimestamp(),
    });
  });
}

export async function sendInstallCommand(
  db: Firestore,
  uid: string,
  app: CompanyAppDoc,
  actor: { uid: string; email: string },
  options?: { addToKiosk?: boolean }
): Promise<string> {
  // Explicitly require inspection_status === 'verified' AND inspected_by_server === true.
  // Missing inspection_status or unverified records are strictly rejected!
  if (app.inspection_status !== 'verified' || app.inspected_by_server !== true) {
    throw new Error(
      'لا يمكن توزيع التطبيق إلا إذا كانت حالة الفحص الخادمي (inspection_status === "verified") ومؤكدة من الخادم (بانتظار الفحص).'
    );
  }

  const cleanApk = (app.sha256_apk || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  const cleanCert = (app.sha256_cert || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();

  if (cleanApk.length !== 64 || cleanCert.length !== 64) {
    throw new Error('بصمة ملف APK وبصمة شهادة المطور SHA-256 إلزاميتان ويجب أن تكونا بصيغة hex صالحة (64 حرفاً).');
  }

  if (!app.storage_path || !app.storage_path.startsWith(`company_apps/${app.id}/`)) {
    throw new Error('مسار التخزين المحمي (storage_path) مفقود أو غير مرتبط بنسخة التطبيق المعتمدة.');
  }

  const fileName = app.storage_path.split('/').pop() || '';
  const cmdRef = doc(collection(db, 'deviceCommands', uid, 'commands'));
  const grantRef = doc(db, 'deviceDownloadGrants', uid, 'apps', app.id);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const cmdData = {
    type: 'install_app',
    status: 'pending',
    cancelled: false,
    app_id: app.id,
    package_name: app.package_name,
    app_name: app.app_name,
    version_code: app.version_code,
    storage_path: app.storage_path,
    storage_generation: app.storage_generation || '1',
    download_url: app.download_url || '',
    sha256_apk: cleanApk,
    sha256_cert: cleanCert,
    add_to_kiosk: Boolean(options?.addToKiosk),
    kiosk_addition_status: options?.addToKiosk ? 'installed_pending_server_policy' : 'not_requested',
    expires_at: expiresAt.toISOString(),
    created_at: serverTimestamp(),
    created_by_uid: actor.uid,
    created_by_email: actor.email,
  };

  await setDoc(cmdRef, cmdData);

  // Create per-device, task-bound download grant enforced by storage.rules
  try {
    await setDoc(grantRef, {
      app_id: app.id,
      device_uid: uid,
      command_id: cmdRef.id,
      file_name: fileName,
      storage_path: app.storage_path,
      storage_generation: app.storage_generation || '1',
      sha256_apk: cleanApk,
      status: 'active',
      expires_at: expiresAt,
      created_at: serverTimestamp(),
      created_by_uid: actor.uid,
    });
  } catch (grantErr) {
    console.warn('Could not write deviceDownloadGrant:', grantErr);
  }

  // Append audit log for distribution
  try {
    const auditRef = doc(collection(db, 'auditLogs'));
    await setDoc(auditRef, {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: uid,
      action: 'send_install_command',
      summary: `إرسال أمر تثبيت ${app.app_name} (v${app.version_name}) إلى الجهاز ${uid}${options?.addToKiosk ? ' مع إضافته لشاشة الكشك' : ''}`,
      before: {},
      after: {
        command_id: cmdRef.id,
        app_id: app.id,
        package_name: app.package_name,
        version_code: app.version_code,
        add_to_kiosk: Boolean(options?.addToKiosk),
      },
      created_at: serverTimestamp(),
    });
  } catch (e) {
    console.warn('Could not write audit log for install command:', e);
  }

  return cmdRef.id;
}

/**
 * Cancels a pending/in_progress install command and immediately revokes the device's Storage download grant.
 */
export async function cancelInstallCommand(
  db: Firestore,
  uid: string,
  cmdId: string,
  appId: string | undefined,
  actor: { uid: string; email: string }
): Promise<void> {
  const cmdRef = doc(db, 'deviceCommands', uid, 'commands', cmdId);
  const auditRef = doc(collection(db, 'auditLogs'));

  await runTransaction(db, async (tx) => {
    const cmdSnap = await tx.get(cmdRef);
    if (!cmdSnap.exists()) {
      throw new Error('أمر التثبيت غير موجود');
    }
    const cmdData = cmdSnap.data();
    const targetAppId = appId || cmdData.app_id;

    tx.update(cmdRef, {
      status: 'cancelled',
      cancelled: true,
      completed_at: serverTimestamp(),
      error: 'تم إلغاء أمر التثبيت من قِبل المشرف',
    });

    if (targetAppId) {
      const grantRef = doc(db, 'deviceDownloadGrants', uid, 'apps', targetAppId);
      tx.set(
        grantRef,
        {
          status: 'revoked',
          revoked_at: serverTimestamp(),
          revoked_by_uid: actor.uid,
        },
        { merge: true }
      );
    }

    tx.set(auditRef, {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: uid,
      action: 'cancel_install_command',
      summary: `إلغاء أمر التثبيت (${cmdId}) وسحب تفويض تنزيل الحزمة للجهاز (${uid})`,
      before: { status: cmdData.status },
      after: { status: 'cancelled', cancelled: true },
      created_at: serverTimestamp(),
    });
  });
}

/**
 * Authoritatively adds an installed package to the device's server-side kioskPolicies/{uid}
 * after installation confirmation.
 * Re-reads the command document, enrollment, deviceStatus, kioskPolicy, policy, and inventory
 * inside the transaction. Never trusts phone-writable fields for `add_to_kiosk`.
 */
export async function addInstalledAppToServerKioskPolicy(
  db: Firestore,
  uid: string,
  packageName: string,
  cmdId: string,
  actor: { uid: string; email: string }
): Promise<{ ok: boolean; newRevision?: number; waitingForInventory?: boolean; error?: string }> {
  const kioskRef = doc(db, 'kioskPolicies', uid);
  const policyRef = doc(db, 'policies', uid);
  const enrollmentRef = doc(db, 'enrollments', uid);
  const statusRef = doc(db, 'deviceStatus', uid);
  const inventoryRef = doc(db, 'deviceAppInventory', uid);
  const cmdRef = doc(db, 'deviceCommands', uid, 'commands', cmdId);
  const auditRef = doc(collection(db, 'auditLogs'));

  try {
    const txOutcome = await runTransaction(db, async (tx) => {
      const [cmdSnap, enrollmentSnap, statusSnap, kioskSnap, policySnap, inventorySnap] =
        await Promise.all([
          tx.get(cmdRef),
          tx.get(enrollmentRef),
          tx.get(statusRef),
          tx.get(kioskRef),
          tx.get(policyRef),
          tx.get(inventoryRef),
        ]);

      if (!cmdSnap.exists()) {
        throw new Error('وثيقة أمر التثبيت غير موجودة في الخادم.');
      }
      const cmdData = cmdSnap.data();

      // 1. Authoritative check: Admin must have set add_to_kiosk === true on the command!
      if (cmdData.add_to_kiosk !== true) {
        throw new Error('لم يختر المشرف إضافة هذا التطبيق إلى شاشة الشركة (add_to_kiosk !== true).');
      }

      // 2. Idempotency check
      if (
        cmdData.kiosk_addition_status === 'added' &&
        Number(cmdData.kiosk_added_for_version) === Number(cmdData.version_code)
      ) {
        return {
          waitingForInventory: false,
          newRevision: Number(cmdData.kiosk_added_revision || 1),
        };
      }

      // 3. Verify command status is executed and not cancelled
      if (cmdData.cancelled === true || cmdData.status !== 'executed') {
        throw new Error('لا يمكن إضافة التطبيق لشاشة الشركة لأن الأمر ملغى أو لم يكتمل تثبيته بعد.');
      }

      // 4. Verify installed version matches target version_code
      if (Number(cmdData.installed_version) !== Number(cmdData.version_code)) {
        throw new Error(
          `إصدار التطبيق المثبت (${cmdData.installed_version}) لا يطابق الإصدار المعتمد في الأمر (${cmdData.version_code}).`
        );
      }

      // 5. Verify device approval
      if (!enrollmentSnap.exists() || enrollmentSnap.data().approved !== true) {
        throw new Error('الجهاز غير معتمد حالياً في النظام (enrollments).');
      }

      // 6. Validate package name and protected packages
      const targetPkg = String(cmdData.package_name || packageName || '').trim();
      const pkgValidation = validatePackageName(targetPkg);
      if (
        !pkgValidation.valid ||
        targetPkg === MDM_AGENT_PACKAGE_NAME ||
        Boolean(HARDCODED_PROTECTED_PACKAGES[targetPkg])
      ) {
        throw new Error(`الحزمة (${targetPkg}) محمية أو غير صالحة ولا يمكن إضافتها لشاشة الشركة.`);
      }

      if (!kioskSnap.exists()) {
        throw new Error('لم يتم إعداد سياسة شاشة الشركة (Kiosk) لهذا الجهاز بعد؛ قم بإعداد كلمة المرور أولاً.');
      }

      const kioskData = kioskSnap.data();

      // 7. Verify device eligibility if Kiosk is enabled
      if (kioskData.enabled === true) {
        if (
          !statusSnap.exists() ||
          statusSnap.data().device_owner !== true ||
          Number(statusSnap.data().android_sdk || 0) < 30
        ) {
          throw new Error('الجهاز غير مؤهل لتفعيل شاشة الشركة (يتطلب Device Owner وAndroid 11+).');
        }
      }

      const currentAllowed: string[] = Array.isArray(kioskData.allowed_apps)
        ? [...kioskData.allowed_apps]
        : [];

      // 8. Check blocked_apps conflict
      if (policySnap.exists()) {
        const blocked: string[] = Array.isArray(policySnap.data().blocked_apps)
          ? policySnap.data().blocked_apps
          : [];
        if (blocked.includes(targetPkg)) {
          throw new Error(`التطبيق (${targetPkg}) موجود في قائمة التطبيقات المحظورة؛ أزله من الحظر أولاً.`);
        }
      }

      // 9. Mandatory actual inventory verification when Kiosk is enabled:
      // NEVER skip this check when inventory is missing or does not contain the newly installed app yet!
      if (kioskData.enabled === true) {
        const invApps =
          inventorySnap.exists() && Array.isArray(inventorySnap.data().apps)
            ? (inventorySnap.data().apps as Array<Record<string, unknown>>)
            : null;
        const appRecord = invApps
          ? invApps.find((a) => a && a.package_name === targetPkg)
          : null;

        if (!invApps || !appRecord) {
          tx.update(cmdRef, {
            kiosk_addition_status: 'waiting_for_inventory',
            kiosk_addition_error: null,
            kiosk_addition_message:
              'بانتظار تحديث جرد التطبيقات من الجهاز للتحقق من أيقونة التشغيل وتوفر الحزمة',
          });
          return { waitingForInventory: true };
        }

        if (appRecord.has_launcher_icon !== true) {
          throw new Error(
            `التطبيق (${targetPkg}) لا يملك أيقونة تشغيل صالحة (has_launcher_icon !== true) في جرد الجهاز.`
          );
        }
        if (appRecord.is_enabled === false || appRecord.is_hidden_by_agent === true) {
          throw new Error(`التطبيق (${targetPkg}) معطل أو مخفي في جرد الجهاز.`);
        }
      }

      if (currentAllowed.includes(targetPkg)) {
        const rev = Number(kioskData.revision || 1);
        tx.update(cmdRef, {
          kiosk_addition_status: 'added',
          kiosk_addition_error: null,
          kiosk_addition_message: null,
          kiosk_added_revision: rev,
          kiosk_added_for_version: Number(cmdData.version_code),
        });
        return { waitingForInventory: false, newRevision: rev };
      }

      if (currentAllowed.length >= 50) {
        throw new Error('تجاوزت قائمة شاشة الشركة الحد الأقصى المسموح به (50 تطبيقاً).');
      }

      const nextAllowed = Array.from(new Set([...currentAllowed, targetPkg])).sort();
      const nextRev = Number(kioskData.revision || 0) + 1;

      const nextKioskDoc = {
        schema_version: 1,
        revision: nextRev,
        enabled: Boolean(kioskData.enabled),
        allowed_apps: nextAllowed,
        exit_salt: kioskData.exit_salt,
        exit_hash: kioskData.exit_hash,
      };

      tx.set(kioskRef, nextKioskDoc);
      tx.update(cmdRef, {
        kiosk_addition_status: 'added',
        kiosk_addition_error: null,
        kiosk_addition_message: null,
        kiosk_added_revision: nextRev,
        kiosk_added_for_version: Number(cmdData.version_code),
      });

      tx.set(auditRef, {
        actor_uid: actor.uid,
        actor_email: actor.email,
        target_uid: uid,
        action: 'update_policy',
        summary: `إضافة التطبيق المثبت (${targetPkg}) تلقائياً إلى شاشة الشركة (إصدار v${nextRev})`,
        before: {
          revision: kioskData.revision,
          allowed_apps: currentAllowed,
        },
        after: {
          revision: nextRev,
          allowed_apps: nextAllowed,
        },
        created_at: serverTimestamp(),
      });

      return { waitingForInventory: false, newRevision: nextRev };
    });

    if (txOutcome.waitingForInventory) {
      return { ok: true, waitingForInventory: true };
    }
    return { ok: true, newRevision: txOutcome.newRevision };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      await updateDoc(cmdRef, {
        kiosk_addition_status: 'failed',
        kiosk_addition_error: errMsg,
      });
    } catch {
      // Ignore secondary update error
    }
    return { ok: false, error: errMsg };
  }
}

export function subscribeToDeviceLocations(
  db: Firestore,
  uid: string,
  maxPoints: number = 50,
  callback: (points: DeviceLocationPoint[]) => void,
  options?: { onError?: (err: Error) => void }
): Unsubscribe {
  const q = query(
    collection(db, 'deviceLocations', uid, 'points'),
    orderBy('recorded_at', 'desc'),
    limit(maxPoints)
  );
  return onSnapshot(
    q,
    (snap) => {
      const list: DeviceLocationPoint[] = snap.docs.map((d) => ({
        point_id: d.id,
        ...(d.data() as Omit<DeviceLocationPoint, 'point_id'>),
      }));
      callback(list);
    },
    (err) => {
      if (options?.onError) {
        options.onError(err);
      }
      callback([]);
    }
  );
}

export async function cleanOldLocations(
  db: Firestore,
  uid: string,
  daysRetention: number = 30,
  actor: { uid: string; email: string }
): Promise<{ deletedCount: number }> {
  const cutoffTime = Date.now() - daysRetention * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffTime);

  const pointsRef = collection(db, 'deviceLocations', uid, 'points');
  const snap = await getDocs(pointsRef);

  let deletedCount = 0;
  const batch = writeBatch(db);

  snap.forEach((docSnap) => {
    const data = docSnap.data();
    let pointTime = 0;
    if (data.recorded_at) {
      if (typeof data.recorded_at.toDate === 'function') {
        pointTime = data.recorded_at.toDate().getTime();
      } else if (typeof data.recorded_at === 'number') {
        pointTime = data.recorded_at;
      } else if (typeof data.recorded_at === 'string') {
        pointTime = new Date(data.recorded_at).getTime();
      }
    }
    if (pointTime > 0 && pointTime < cutoffTime) {
      batch.delete(docSnap.ref);
      deletedCount++;
    }
  });

  if (deletedCount > 0) {
    const auditRef = doc(collection(db, 'auditLogs'));
    batch.set(auditRef, {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: uid,
      action: 'clean_locations',
      summary: `تنظيف سجل المواقع القديمة للجهاز ${uid} (حذف ${deletedCount} نقطة أقدم من ${daysRetention} يوماً)`,
      before: { retention_days: daysRetention },
      after: { deleted_points: deletedCount, cutoff_iso: cutoffDate.toISOString() },
      created_at: serverTimestamp(),
    });
    await batch.commit();
  }

  return { deletedCount };
}


