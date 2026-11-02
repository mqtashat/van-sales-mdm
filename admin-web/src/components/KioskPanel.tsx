import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDocFromServer,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';
import {
  Lock,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Search,
  KeyRound,
  Smartphone,
  Save,
  X,
  Code2,
  Settings,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import type {
  AdminIdentity,
  DeviceAppInventoryDoc,
  DeviceStatusDoc,
  PolicyDoc,
} from '../types/mdm.ts';
import {
  HARDCODED_PROTECTED_PACKAGES,
  validatePackageName,
  formatTimestampAr,
} from '../utils/validation.ts';
import { lookupAppInfo } from '../utils/appCatalog.ts';

export const MIN_MAINTENANCE_PASSWORD_LENGTH = 12;
export const MAX_MAINTENANCE_PASSWORD_LENGTH = 128;
export const PBKDF2_ITERATIONS = 120000;

function extractTimestampMs(val: unknown): number | null {
  if (!val) return null;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof (val as { toMillis?: () => number })?.toMillis === 'function') {
    return (val as { toMillis: () => number }).toMillis();
  }
  if (typeof (val as { toDate?: () => Date })?.toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().getTime();
  }
  if (typeof (val as { seconds?: number })?.seconds === 'number') {
    return (val as { seconds: number }).seconds * 1000;
  }
  return null;
}

export interface KioskPolicyDoc {
  schema_version: 1;
  revision: number;
  enabled: boolean;
  allowed_apps: string[];
  exit_salt: string;
  exit_hash: string;
}

export interface KioskStatusDoc {
  configured_revision: number;
  active: boolean;
  install_blocked: boolean;
  maintenance: boolean;
  error: string;
  reported_at: unknown;
}

const KIOSK_KEYS = [
  'schema_version',
  'revision',
  'enabled',
  'allowed_apps',
  'exit_salt',
  'exit_hash',
] as const;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generates PBKDF2-HMAC-SHA256 verifier (120,000 iterations, 16-byte random salt).
 * Strictly enforces a minimum maintenance password length of 12 characters.
 */
export async function passwordVerifier(
  password: string,
  existingSaltHex?: string
): Promise<{ exit_salt: string; exit_hash: string }> {
  if (
    typeof password !== 'string' ||
    password.length < MIN_MAINTENANCE_PASSWORD_LENGTH ||
    password.length > MAX_MAINTENANCE_PASSWORD_LENGTH
  ) {
    throw new Error(
      `يجب أن تتكون كلمة مرور الصيانة من ${MIN_MAINTENANCE_PASSWORD_LENGTH} إلى ${MAX_MAINTENANCE_PASSWORD_LENGTH} حرفًا.`
    );
  }

  let saltBytes: Uint8Array<ArrayBuffer>;
  if (existingSaltHex && /^[a-f0-9]{32}$/.test(existingSaltHex)) {
    const parsed = existingSaltHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16));
    saltBytes = new Uint8Array(new ArrayBuffer(parsed.length));
    saltBytes.set(parsed);
  } else {
    saltBytes = new Uint8Array(new ArrayBuffer(16));
    crypto.getRandomValues(saltBytes);
  }

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return {
    exit_salt: bytesToHex(saltBytes),
    exit_hash: bytesToHex(new Uint8Array(derivedBits)),
  };
}

export function validateKiosk(raw: unknown): raw is KioskPolicyDoc {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const d = raw as Record<string, unknown>;
  const keys = Object.keys(d);
  if (keys.length !== KIOSK_KEYS.length) {
    return false;
  }
  for (const k of KIOSK_KEYS) {
    if (!(k in d)) return false;
  }

  if (d.schema_version !== 1) return false;
  if (typeof d.revision !== 'number' || !Number.isSafeInteger(d.revision) || d.revision < 1) {
    return false;
  }
  if (typeof d.enabled !== 'boolean') return false;

  if (!Array.isArray(d.allowed_apps) || d.allowed_apps.length > 50) {
    return false;
  }
  const seen = new Set<string>();
  for (const pkg of d.allowed_apps) {
    if (typeof pkg !== 'string') return false;
    const check = validatePackageName(pkg);
    if (!check.valid || Boolean(HARDCODED_PROTECTED_PACKAGES[pkg])) return false;
    if (seen.has(pkg)) return false;
    seen.add(pkg);
  }

  if (d.enabled && d.allowed_apps.length === 0) {
    return false;
  }

  if (typeof d.exit_salt !== 'string' || !/^[a-f0-9]{32}$/.test(d.exit_salt)) {
    return false;
  }
  if (typeof d.exit_hash !== 'string' || !/^[a-f0-9]{64}$/.test(d.exit_hash)) {
    return false;
  }

  return true;
}

export function supportsKioskAgent(
  status: Partial<DeviceStatusDoc> | Record<string, unknown> | null | undefined
): boolean {
  if (!status || typeof status !== 'object') return false;
  const sdk = (status as { android_sdk?: unknown }).android_sdk;
  if (typeof sdk !== 'number' || sdk < 30) {
    return false;
  }
  const v = String((status as { agent_version?: unknown }).agent_version || '').trim();
  const match = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 4;
}

export type FirestoreErrorCategory = 'permission_denied' | 'connectivity' | 'other';

export interface ClassifiedFirestoreError {
  category: FirestoreErrorCategory;
  code: string;
  title: string;
  detail: string;
}

/**
 * Separates permission errors from connectivity/network errors and other errors.
 * Never claims that deployed Firestore rules are outdated without actual verification.
 */
export function classifyFirestoreError(
  err: unknown,
  resourceLabel: string = 'بيانات شاشة الشركة'
): ClassifiedFirestoreError {
  const code = String((err as { code?: unknown })?.code || '');
  const rawMessage = err instanceof Error ? err.message : String(err ?? '');

  if (
    code === 'permission-denied' ||
    code.endsWith('/permission-denied') ||
    rawMessage.includes('Missing or insufficient permissions') ||
    rawMessage.includes('PERMISSION_DENIED') ||
    rawMessage.includes('permission-denied')
  ) {
    return {
      category: 'permission_denied',
      code: code || 'permission-denied',
      title: `تعذر الوصول إلى ${resourceLabel} بسبب رفض الصلاحيات (permission-denied)`,
      detail: `رفض الخادم الوصول إلى ${resourceLabel}. تحقق من صلاحية حساب المدير الحالي (توثيق البريد الإلكتروني، وثيقة admins/{uid} أو صلاحية admin)، ومن إعدادات المشروع وقاعدة البيانات وقواعد الأمان المعتمدة.`,
    };
  }

  if (
    code === 'unavailable' ||
    code.endsWith('/unavailable') ||
    code === 'deadline-exceeded' ||
    rawMessage.includes('unavailable') ||
    rawMessage.includes('offline') ||
    rawMessage.includes('network-request-failed') ||
    rawMessage.includes('Failed to get document') ||
    rawMessage.includes('client is offline') ||
    rawMessage.includes('network')
  ) {
    return {
      category: 'connectivity',
      code: code || 'unavailable',
      title: `تعذر الاتصال بالخادم لقراءة ${resourceLabel}`,
      detail: `حدث انقطاع في الشبكة أو تعذر الوصول المؤقت إلى خدمة Firestore أثناء قراءة ${resourceLabel}. تحقق من اتصال الإنترنت وأعد المحاولة.`,
    };
  }

  return {
    category: 'other',
    code: code || 'unknown',
    title: `تعذر إتمام العملية على ${resourceLabel}`,
    detail: rawMessage || `حدث خطأ غير متوقع أثناء التعامل مع ${resourceLabel}.`,
  };
}

export interface KioskEnforcementEvaluation {
  state: 'applied' | 'pending' | 'error' | 'maintenance' | 'no_policy';
  isConfirmed: boolean;
  tone: 'success' | 'pending' | 'error' | 'warning' | 'neutral';
  label: string;
  detail: string;
}

/**
 * Strictly evaluates Kiosk enforcement status.
 * NEVER reports 'applied' / isConfirmed=true unless:
 * 1. Both policy and status exist
 * 2. status.configured_revision === policy.revision
 * 3. status.active === policy.enabled
 * 4. No error (!status.error)
 * 5. Not in maintenance mode (!status.maintenance)
 * 6. When policy.enabled === true, status.install_blocked === true is confirmed.
 */
export function evaluateKioskEnforcementState(
  policy: KioskPolicyDoc | null | undefined,
  status: Partial<KioskStatusDoc> | Record<string, unknown> | null | undefined
): KioskEnforcementEvaluation {
  const s = status as Record<string, unknown> | null | undefined;
  const rawError =
    typeof s?.error === 'string' && s.error.trim().length > 0
      ? s.error.trim()
      : typeof s?.last_error === 'string' && s.last_error.trim().length > 0
      ? s.last_error.trim()
      : '';
  const inMaintenance = s?.maintenance === true || s?.maintenance_mode === true;
  const configuredRevision =
    typeof s?.configured_revision === 'number' && Number.isInteger(s.configured_revision)
      ? s.configured_revision
      : null;
  const activeFlag = typeof s?.active === 'boolean' ? s.active : null;
  const installBlockedFlag = s?.install_blocked === true;

  if (!policy) {
    if (rawError) {
      return {
        state: 'error',
        isConfirmed: false,
        tone: 'error',
        label: 'أبلغ الهاتف عن خطأ في شاشة الشركة',
        detail: rawError,
      };
    }
    if (inMaintenance) {
      return {
        state: 'maintenance',
        isConfirmed: false,
        tone: 'warning',
        label: 'وضع الصيانة مفتوح على الهاتف',
        detail: 'الجهاز في وضع صيانة المدير محليًا.',
      };
    }
    return {
      state: 'no_policy',
      isConfirmed: false,
      tone: 'neutral',
      label: 'لم يتم إعداد شاشة الشركة بعد',
      detail: 'لم تُحفظ إعدادات شاشة الشركة لهذا الجهاز حتى الآن.',
    };
  }

  if (!s) {
    return {
      state: 'pending',
      isConfirmed: false,
      tone: 'pending',
      label: 'بانتظار تأكيد الهاتف',
      detail: 'لم يصل تقرير حالة شاشة الشركة من الهاتف بعد.',
    };
  }

  if (rawError) {
    return {
      state: 'error',
      isConfirmed: false,
      tone: 'error',
      label: 'أبلغ الهاتف عن خطأ في شاشة الشركة',
      detail: rawError,
    };
  }

  if (inMaintenance) {
    return {
      state: 'maintenance',
      isConfirmed: false,
      tone: 'warning',
      label: 'الجهاز في صيانة المدير',
      detail: 'الجهاز في صيانة المدير؛ احفظ إصدارًا جديدًا لإعادة التفعيل.',
    };
  }

  if (configuredRevision !== policy.revision) {
    return {
      state: 'pending',
      isConfirmed: false,
      tone: 'pending',
      label: 'تم الحفظ وبانتظار تأكيد الهاتف',
      detail: `الإصدار المحفوظ (${policy.revision}) بانتظار تأكيد الهاتف (الإصدار المبلّغ حاليًا: ${
        configuredRevision ?? 'غير متوفر'
      }).`,
    };
  }

  if (activeFlag !== policy.enabled) {
    return {
      state: 'pending',
      isConfirmed: false,
      tone: 'pending',
      label: 'بانتظار تطابق حالة التفعيل على الهاتف',
      detail: `الإصدار متطابق (${policy.revision}) لكن حالة الشاشة على الهاتف (${
        activeFlag ? 'مفعلة' : 'غير مفعلة'
      }) لم تتطابق بعد مع الحالة المطلوبة (${policy.enabled ? 'مفعلة' : 'غير مفعلة'}).`,
    };
  }

  if (policy.enabled && !installBlockedFlag) {
    return {
      state: 'pending',
      isConfirmed: false,
      tone: 'warning',
      label: 'بانتظار تأكيد منع التثبيت',
      detail: `الشاشة نشطة للإصدار (${policy.revision}) لكن لم يتأكد تفعيل قيد منع تثبيت التطبيقات (install_blocked) بعد.`,
    };
  }

  if (policy.enabled) {
    return {
      state: 'applied',
      isConfirmed: true,
      tone: 'success',
      label: 'أكد الهاتف تطبيق إعدادات الشاشة',
      detail: `شاشة الشركة نشطة ومؤكدة مع منع التثبيت (الإصدار المطبق: ${configuredRevision}).`,
    };
  }

  return {
    state: 'applied',
    isConfirmed: true,
    tone: 'neutral',
    label: 'أكد الهاتف إيقاف شاشة الشركة',
    detail: `أكد الهاتف إيقاف شاشة الشركة وتطبيق الإصدار (${configuredRevision}).`,
  };
}

export interface KioskDraftState {
  remote: KioskPolicyDoc | null;
  enabled: boolean;
  allowedApps: string[];
  password: string;
  confirmPassword: string;
  expectedRevision: number | null;
  isDirty: boolean;
  revisionConflict: {
    pinnedRevision: number | null;
    incomingRevision: number | null;
    incomingPolicy: KioskPolicyDoc | null;
  } | null;
}

/**
 * Pure state transition helper for incoming Kiosk policy snapshots.
 * - When isDirty === false, updates form state and sets expectedRevision to incoming revision.
 * - When isDirty === true, preserves the admin's local draft and pinned expectedRevision,
 *   and flags a revisionConflict if the server revision diverged.
 */
export function applyKioskSnapshotToDraftState(
  current: KioskDraftState,
  incomingPolicy: KioskPolicyDoc | null
): KioskDraftState {
  const incomingRevision = incomingPolicy?.revision ?? null;

  if (!current.isDirty) {
    return {
      ...current,
      remote: incomingPolicy,
      enabled: incomingPolicy?.enabled ?? false,
      allowedApps: incomingPolicy ? [...incomingPolicy.allowed_apps] : [],
      expectedRevision: incomingRevision,
      revisionConflict: null,
    };
  }

  // Admin has an unsaved local draft: preserve draft fields and keep expectedRevision pinned
  const hasConflict = incomingRevision !== current.expectedRevision;
  return {
    ...current,
    remote: incomingPolicy,
    revisionConflict: hasConflict
      ? {
          pinnedRevision: current.expectedRevision,
          incomingRevision,
          incomingPolicy,
        }
      : null,
  };
}

export interface KioskTransactionValidationInput {
  uid: string;
  actor: Pick<AdminIdentity, 'uid' | 'email' | 'isAuthorizedAdmin'> &
    Partial<Pick<AdminIdentity, 'emailVerified' | 'isAnonymous'>>;
  serverReadConfirmed: boolean;
  expectedRevision: number | null;
  enabled: boolean;
  allowedApps: string[];
  credential: { exit_salt: string; exit_hash: string };
  existingKioskDoc: Record<string, unknown> | null;
  enrollmentDoc: Record<string, unknown> | null;
  deviceStatusDoc: Record<string, unknown> | null;
  policyDoc: Record<string, unknown> | null;
  inventoryDoc: Record<string, unknown> | null;
}

export interface KioskTransactionBuildResult {
  nextPolicy: KioskPolicyDoc;
  auditLog: {
    actor_uid: string;
    actor_email: string;
    target_uid: string;
    action: 'update_policy';
    summary: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
}

/**
 * Validates all preconditions inside the Kiosk save transaction and constructs
 * both the next KioskPolicyDoc and the redacted AuditLog record (never containing
 * password, exit_salt, or exit_hash).
 */
export function validateAndBuildKioskTransaction(
  input: KioskTransactionValidationInput
): KioskTransactionBuildResult {
  const {
    uid,
    actor,
    serverReadConfirmed,
    expectedRevision,
    enabled,
    allowedApps,
    credential,
    existingKioskDoc,
    enrollmentDoc,
    deviceStatusDoc,
    policyDoc,
    inventoryDoc,
  } = input;

  if (
    !serverReadConfirmed ||
    !actor ||
    actor.isAuthorizedAdmin !== true ||
    actor.isAnonymous === true ||
    actor.emailVerified === false ||
    !actor.uid ||
    !actor.email
  ) {
    throw new Error('يلزم اتصال مؤكد بالخادم وصلاحية مدير صالحة قبل حفظ إعدادات شاشة الشركة.');
  }

  if (existingKioskDoc !== null && !validateKiosk(existingKioskDoc)) {
    throw new Error('إعدادات شاشة الشركة الحالية في الخادم غير صالحة؛ لم تُستبدل تلقائيًا.');
  }

  const currentServerRevision =
    existingKioskDoc !== null ? (existingKioskDoc.revision as number) : null;

  if (currentServerRevision !== expectedRevision) {
    throw new Error(
      `تعارض إصدارات: تغيرت إعدادات شاشة الشركة في الخادم أثناء التعديل (المتوقع: ${
        expectedRevision ?? 'لا يوجد'
      }، الحالي في الخادم: ${
        currentServerRevision ?? 'لا يوجد'
      }). راجع القيم المحدثة قبل الحفظ.`
    );
  }

  if (!enrollmentDoc || enrollmentDoc.approved !== true) {
    throw new Error('الجهاز غير معتمد في النظام (enrollments). يجب اعتماد الجهاز أولًا.');
  }

  const dedupedSortedApps = Array.from(
    new Set(allowedApps.map((p) => p.trim()).filter(Boolean))
  ).sort();

  const blockedAppsInPolicy = Array.isArray(policyDoc?.blocked_apps)
    ? (policyDoc.blocked_apps as string[])
    : [];
  const inventoryApps = Array.isArray(inventoryDoc?.apps)
    ? (inventoryDoc.apps as Array<Record<string, unknown>>)
    : [];

  if (enabled) {
    if (
      !deviceStatusDoc ||
      deviceStatusDoc.device_owner !== true ||
      !supportsKioskAgent(deviceStatusDoc)
    ) {
      throw new Error(
        'ثبّت تحديث Android 0.4.0 أو أحدث على جهاز Android 11 (SDK 30) أو أحدث مع تفعيل Device Owner أولًا.'
      );
    }

    if (dedupedSortedApps.length === 0) {
      throw new Error('اختر تطبيقًا واحدًا على الأقل عند تفعيل شاشة الشركة.');
    }
  }

  // Validate all selected allowed_apps against protected packages always,
  // and check blocked_apps conflict + inventory availability only when enabling Kiosk.
  for (const pkg of dedupedSortedApps) {
    if (
      ['com.android.settings', 'com.android.vending', 'com.company.mdmagent'].includes(pkg) ||
      Boolean(HARDCODED_PROTECTED_PACKAGES[pkg])
    ) {
      throw new Error(`أزل التطبيق من الحظر أولًا أو اختر تطبيق عمل مناسبًا: ${pkg}`);
    }

    if (enabled) {
      if (blockedAppsInPolicy.includes(pkg)) {
        throw new Error(`أزل التطبيق من الحظر أولًا أو اختر تطبيق عمل مناسبًا: ${pkg}`);
      }

      const appRecord = inventoryApps.find((a) => a && a.package_name === pkg);
      if (
        !appRecord ||
        appRecord.has_launcher_icon !== true ||
        appRecord.is_enabled === false ||
        appRecord.is_hidden_by_agent === true
      ) {
        throw new Error(`التطبيق غير متاح حسب آخر جرد: ${pkg}`);
      }
    }
  }

  const nextRevision = (currentServerRevision ?? 0) + 1;
  const nextPolicy: KioskPolicyDoc = {
    schema_version: 1,
    revision: nextRevision,
    enabled,
    allowed_apps: dedupedSortedApps,
    exit_salt: credential.exit_salt,
    exit_hash: credential.exit_hash,
  };

  if (!validateKiosk(nextPolicy)) {
    throw new Error('اختر تطبيقًا واحدًا على الأقل وحتى 50 تطبيقًا مع كلمة مرور صيانة صالحة.');
  }

  const beforeAudit: Record<string, unknown> = existingKioskDoc
    ? {
        revision: existingKioskDoc.revision,
        enabled: existingKioskDoc.enabled,
        allowed_apps: existingKioskDoc.allowed_apps,
      }
    : { exists: false };

  const afterAudit: Record<string, unknown> = {
    revision: nextPolicy.revision,
    enabled: nextPolicy.enabled,
    allowed_apps: nextPolicy.allowed_apps,
  };

  return {
    nextPolicy,
    auditLog: {
      actor_uid: actor.uid,
      actor_email: actor.email,
      target_uid: uid,
      action: 'update_policy',
      summary: `شاشة الشركة: ${enabled ? 'تفعيل' : 'تعطيل'}، ${
        nextPolicy.allowed_apps.length
      } تطبيق، إصدار ${nextPolicy.revision}`,
      before: beforeAudit,
      after: afterAudit,
    },
  };
}

export interface ExecuteKioskSaveParams {
  db: Firestore;
  uid: string;
  actor: Pick<AdminIdentity, 'uid' | 'email' | 'isAuthorizedAdmin'> &
    Partial<Pick<AdminIdentity, 'emailVerified' | 'isAnonymous' | 'hasCustomAdminClaim'>>;
  serverReady: boolean;
  expectedRevision: number | null;
  enabled: boolean;
  allowedApps: string[];
  password: string;
  confirmPassword: string;
  remote: KioskPolicyDoc | null;
  deps?: {
    getDocFromServerFn?: typeof getDocFromServer;
    runTransactionFn?: typeof runTransaction;
    docFn?: typeof doc;
    collectionFn?: typeof collection;
    serverTimestampFn?: typeof serverTimestamp;
    passwordVerifierFn?: typeof passwordVerifier;
  };
}

/**
 * Actual Kiosk save execution path used by KioskPanel.handleSave:
 * 1. Verifies server-authoritative admin document (admins/{actor.uid}) when needed
 * 2. Derives or reuses PBKDF2-HMAC-SHA256 (120,000 iterations) 12+ char maintenance verifier
 * 3. Runs a single atomic Firestore transaction that reads kioskPolicies/{uid}, enrollments/{uid},
 *    deviceStatus/{uid}, policies/{uid}, and deviceAppInventory/{uid}, validates all preconditions via
 *    validateAndBuildKioskTransaction, and writes BOTH kioskPolicies/{uid} and auditLogs/{autoId}
 *    inside the exact same transaction (writing neither if any check fails).
 */
export async function executeKioskSave(
  params: ExecuteKioskSaveParams
): Promise<KioskPolicyDoc> {
  const {
    db,
    uid,
    actor,
    serverReady,
    expectedRevision,
    enabled,
    allowedApps,
    password,
    confirmPassword,
    remote,
    deps,
  } = params;

  const getDocFromServerFn = deps?.getDocFromServerFn ?? getDocFromServer;
  const runTransactionFn = deps?.runTransactionFn ?? runTransaction;
  const docFn = deps?.docFn ?? doc;
  const collectionFn = deps?.collectionFn ?? collection;
  const serverTimestampFn = deps?.serverTimestampFn ?? serverTimestamp;
  const passwordVerifierFn = deps?.passwordVerifierFn ?? passwordVerifier;

  if (!serverReady || !actor?.isAuthorizedAdmin) {
    throw new Error('يلزم اتصال مؤكد بالخادم وصلاحية مدير صالحة قبل حفظ إعدادات شاشة الشركة.');
  }

  const needsNewPassword = !remote || password.length > 0 || confirmPassword.length > 0;
  if (needsNewPassword) {
    if (password.length < MIN_MAINTENANCE_PASSWORD_LENGTH) {
      throw new Error(
        remote
          ? `أدخل كلمة مرور صيانة جديدة من ${MIN_MAINTENANCE_PASSWORD_LENGTH} حرفًا على الأقل أو اترك الحقلين فارغين للإبقاء على كلمة المرور الحالية.`
          : `يجب تعيين كلمة مرور صيانة المدير (${MIN_MAINTENANCE_PASSWORD_LENGTH} حرفًا على الأقل) عند إعداد شاشة الشركة لأول مرة.`
      );
    }
    if (password !== confirmPassword) {
      throw new Error('استخدم كلمة مرور من 12 حرفًا على الأقل، وأكدها بنفس القيمة.');
    }
  }

  // Server-authoritative admin check if admin relies on admins/{uid} document
  if (!actor.hasCustomAdminClaim) {
    const adminSnap = await getDocFromServerFn(docFn(db, 'admins', actor.uid));
    if (!adminSnap.exists() || adminSnap.data()?.active !== true) {
      throw new Error('لم يتم التحقق من فعالية صلاحية المدير على الخادم (admins/{uid}).');
    }
  }

  const credential = needsNewPassword
    ? await passwordVerifierFn(password)
    : { exit_salt: remote!.exit_salt, exit_hash: remote!.exit_hash };

  const kioskRef = docFn(db, 'kioskPolicies', uid);
  const enrollmentRef = docFn(db, 'enrollments', uid);
  const statusRef = docFn(db, 'deviceStatus', uid);
  const policyRef = docFn(db, 'policies', uid);
  const inventoryRef = docFn(db, 'deviceAppInventory', uid);
  const auditRef = docFn(collectionFn(db, 'auditLogs'));

  return runTransactionFn(db, async (tx) => {
    const [oldSnap, enrollmentSnap, phoneSnap, policySnap, scanSnap] = await Promise.all([
      tx.get(kioskRef),
      tx.get(enrollmentRef),
      tx.get(statusRef),
      tx.get(policyRef),
      tx.get(inventoryRef),
    ]);

    const { nextPolicy, auditLog } = validateAndBuildKioskTransaction({
      uid,
      actor,
      serverReadConfirmed: serverReady,
      expectedRevision,
      enabled,
      allowedApps,
      credential,
      existingKioskDoc: oldSnap.exists()
        ? (oldSnap.data() as Record<string, unknown>)
        : null,
      enrollmentDoc: enrollmentSnap.exists()
        ? (enrollmentSnap.data() as Record<string, unknown>)
        : null,
      deviceStatusDoc: phoneSnap.exists()
        ? (phoneSnap.data() as Record<string, unknown>)
        : null,
      policyDoc: policySnap.exists()
        ? (policySnap.data() as Record<string, unknown>)
        : null,
      inventoryDoc: scanSnap.exists()
        ? (scanSnap.data() as Record<string, unknown>)
        : null,
    });

    tx.set(kioskRef, nextPolicy);
    tx.set(auditRef, {
      ...auditLog,
      created_at: serverTimestampFn(),
    });

    return nextPolicy;
  });
}

interface KioskPanelProps {
  db: Firestore | null;
  uid: string;
  actor?: AdminIdentity;
  approved: boolean;
  status: DeviceStatusDoc | null;
  devicePolicy?: PolicyDoc | null;
  inventory?: DeviceAppInventoryDoc | null;
  discardDraftSignal?: number;
  onDirtyChange?: (isDirty: boolean) => void;
  onNavigateAdvancedSettings?: () => void;
}

export const KioskPanel: React.FC<KioskPanelProps> = ({
  db,
  uid,
  actor,
  approved,
  status,
  devicePolicy,
  inventory,
  discardDraftSignal = 0,
  onDirtyChange,
  onNavigateAdvancedSettings,
}) => {
  const [remote, setRemote] = useState<KioskPolicyDoc | null>(null);
  const [kioskStatus, setKioskStatus] = useState<KioskStatusDoc | null>(null);
  const [policyListenerError, setPolicyListenerError] = useState<ClassifiedFirestoreError | null>(
    null
  );
  const [statusListenerError, setStatusListenerError] = useState<ClassifiedFirestoreError | null>(
    null
  );
  const [corruptedPolicyError, setCorruptedPolicyError] = useState<string | null>(null);
  const [serverReady, setServerReady] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(Boolean(db));

  // Draft state
  const [enabled, setEnabled] = useState<boolean>(false);
  const [allowedApps, setAllowedApps] = useState<string[]>([]);
  const [password, setPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const [revisionConflict, setRevisionConflict] = useState<{
    pinnedRevision: number | null;
    incomingRevision: number | null;
    incomingPolicy: KioskPolicyDoc | null;
  } | null>(null);

  const isDirtyRef = useRef<boolean>(false);
  const expectedRevisionRef = useRef<number | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [appFilter, setAppFilter] = useState<'all' | 'selected' | 'unselected'>('all');
  const [showPackageNames, setShowPackageNames] = useState<boolean>(false);

  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null
  );

  const isDirty = useMemo(() => {
    const savedEnabled = remote ? remote.enabled : false;
    const savedApps = remote ? [...remote.allowed_apps].sort().join(',') : '';
    const currentApps = [...allowedApps].sort().join(',');
    return (
      enabled !== savedEnabled ||
      currentApps !== savedApps ||
      password.length > 0 ||
      confirmPassword.length > 0
    );
  }, [remote, enabled, allowedApps, password, confirmPassword]);

  useEffect(() => {
    isDirtyRef.current = isDirty;
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    expectedRevisionRef.current = expectedRevision;
  }, [expectedRevision]);

  const beginEdit = () => {
    setFeedback(null);
    if (!isDirtyRef.current) {
      isDirtyRef.current = true;
      // Pin expectedRevision to the base revision when editing starts
      const pinned = remote?.revision ?? null;
      expectedRevisionRef.current = pinned;
      setExpectedRevision(pinned);
    }
  };

  // Reset draft when parent signals discard
  useEffect(() => {
    if (discardDraftSignal > 0) {
      isDirtyRef.current = false;
      setEnabled(remote ? Boolean(remote.enabled) : false);
      setAllowedApps(remote ? [...remote.allowed_apps] : []);
      setPassword('');
      setConfirmPassword('');
      const rev = remote?.revision ?? null;
      expectedRevisionRef.current = rev;
      setExpectedRevision(rev);
      setRevisionConflict(null);
      setFeedback(null);
    }
  }, [discardDraftSignal, remote]);

  useEffect(() => {
    if (!db || !uid) {
      setLoading(false);
      setServerReady(false);
      return;
    }

    setLoading(true);
    setServerReady(false);
    isDirtyRef.current = false;
    expectedRevisionRef.current = null;
    setRemote(null);
    setKioskStatus(null);
    setEnabled(false);
    setAllowedApps([]);
    setPassword('');
    setConfirmPassword('');
    setExpectedRevision(null);
    setRevisionConflict(null);
    setPolicyListenerError(null);
    setStatusListenerError(null);
    setCorruptedPolicyError(null);
    setFeedback(null);

    const unsubPolicy = onSnapshot(
      doc(db, 'kioskPolicies', uid),
      { includeMetadataChanges: true },
      (snap) => {
        setPolicyListenerError(null);
        const raw = snap.exists() ? snap.data() : null;
        if (raw && !validateKiosk(raw)) {
          setCorruptedPolicyError(
            'إعدادات شاشة الشركة المخزنة في الخادم غير صالحة؛ لم تُستبدل بقيم افتراضية.'
          );
          setServerReady(false);
          setLoading(false);
          return;
        }

        setCorruptedPolicyError(null);
        const incomingPolicy = raw ? (raw as KioskPolicyDoc) : null;
        setServerReady(!snap.metadata.fromCache);
        setLoading(false);

        const nextDraft = applyKioskSnapshotToDraftState(
          {
            remote: incomingPolicy,
            enabled: incomingPolicy?.enabled ?? false,
            allowedApps: incomingPolicy ? [...incomingPolicy.allowed_apps] : [],
            password: '',
            confirmPassword: '',
            expectedRevision: expectedRevisionRef.current,
            isDirty: isDirtyRef.current,
            revisionConflict: null,
          },
          incomingPolicy
        );

        setRemote(nextDraft.remote);
        if (!isDirtyRef.current) {
          setEnabled(nextDraft.enabled);
          setAllowedApps(nextDraft.allowedApps);
          expectedRevisionRef.current = nextDraft.expectedRevision;
          setExpectedRevision(nextDraft.expectedRevision);
          setRevisionConflict(null);
        } else {
          setRevisionConflict(nextDraft.revisionConflict);
        }
      },
      (err) => {
        setLoading(false);
        setServerReady(false);
        setPolicyListenerError(classifyFirestoreError(err, 'إعدادات شاشة الشركة (kioskPolicies)'));
      }
    );

    const unsubStatus = onSnapshot(
      doc(db, 'kioskStatus', uid),
      (snap) => {
        setStatusListenerError(null);
        if (snap.exists()) {
          setKioskStatus(snap.data() as KioskStatusDoc);
        } else {
          setKioskStatus(null);
        }
      },
      (err) => {
        setStatusListenerError(classifyFirestoreError(err, 'حالة شاشة الشركة (kioskStatus)'));
      }
    );

    return () => {
      unsubPolicy();
      unsubStatus();
    };
  }, [db, uid]);

  const agentSupported = supportsKioskAgent(status);
  const canConfigure = approved && agentSupported && status?.device_owner === true;

  const blockedSet = useMemo(
    () => new Set(devicePolicy?.blocked_apps ?? []),
    [devicePolicy?.blocked_apps]
  );

  // Build selectable apps strictly from real reported inventory (launchable, non-protected)
  const selectableInventoryApps = useMemo(() => {
    const list: Array<{
      packageName: string;
      appName: string;
      isSystem: boolean;
      isHiddenByAgent: boolean;
      isEnabledOnPhone: boolean;
      isBlockedInPolicy: boolean;
    }> = [];

    if (inventory?.apps) {
      for (const item of inventory.apps) {
        if (
          !item.package_name ||
          !item.has_launcher_icon ||
          ['com.android.settings', 'com.android.vending', 'com.company.mdmagent'].includes(
            item.package_name
          ) ||
          Boolean(HARDCODED_PROTECTED_PACKAGES[item.package_name])
        ) {
          continue;
        }
        const cat = lookupAppInfo(item.package_name);
        list.push({
          packageName: item.package_name,
          appName: item.app_name || cat?.nameAr || item.package_name,
          isSystem: Boolean(item.is_system_app),
          isHiddenByAgent: Boolean(item.is_hidden_by_agent),
          isEnabledOnPhone: item.is_enabled !== false,
          isBlockedInPolicy: blockedSet.has(item.package_name),
        });
      }
    }

    return list.sort((a, b) => {
      const aSel = allowedApps.includes(a.packageName) ? 0 : 1;
      const bSel = allowedApps.includes(b.packageName) ? 0 : 1;
      if (aSel !== bSel) return aSel - bSel;
      return a.appName.localeCompare(b.appName, 'ar');
    });
  }, [inventory, allowedApps, blockedSet]);

  // Any apps in allowedApps that are missing from selectableInventoryApps
  const unavailableSelectedApps = useMemo(() => {
    const selectableSet = new Set(selectableInventoryApps.map((a) => a.packageName));
    return allowedApps.filter((pkg) => !selectableSet.has(pkg));
  }, [allowedApps, selectableInventoryApps]);

  const filteredApps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return selectableInventoryApps.filter((app) => {
      const isSelected = allowedApps.includes(app.packageName);
      if (appFilter === 'selected' && !isSelected) return false;
      if (appFilter === 'unselected' && isSelected) return false;
      if (!q) return true;
      return (
        app.appName.toLowerCase().includes(q) ||
        app.packageName.toLowerCase().includes(q)
      );
    });
  }, [selectableInventoryApps, allowedApps, appFilter, searchQuery]);

  const toggleApp = (pkg: string) => {
    beginEdit();
    setAllowedApps((prev) => {
      if (prev.includes(pkg)) {
        return prev.filter((item) => item !== pkg);
      }
      if (prev.length >= 50) {
        setFeedback({
          type: 'error',
          message: 'الحد الأقصى للتطبيقات المسموحة في شاشة الشركة هو 50 تطبيقًا.',
        });
        return prev;
      }
      return [...prev, pkg];
    });
  };

  const handleResetChanges = () => {
    isDirtyRef.current = false;
    setFeedback(null);
    setEnabled(remote ? Boolean(remote.enabled) : false);
    setAllowedApps(remote ? [...remote.allowed_apps] : []);
    setPassword('');
    setConfirmPassword('');
    const rev = remote?.revision ?? null;
    expectedRevisionRef.current = rev;
    setExpectedRevision(rev);
    setRevisionConflict(null);
  };

  const handleSave = async () => {
    setFeedback(null);
    if (!db) {
      setFeedback({ type: 'error', message: 'اتصال قاعدة البيانات غير متاح حاليًا.' });
      return;
    }
    if (!serverReady || !actor?.isAuthorizedAdmin) {
      setFeedback({
        type: 'error',
        message: 'يلزم اتصال مؤكد بالخادم وصلاحية مدير صالحة قبل حفظ إعدادات شاشة الشركة.',
      });
      return;
    }
    if (corruptedPolicyError) {
      setFeedback({
        type: 'error',
        message: corruptedPolicyError,
      });
      return;
    }
    if (revisionConflict) {
      setFeedback({
        type: 'error',
        message:
          'تعارض إصدارات: تغيرت إعدادات شاشة الشركة في الخادم أثناء التعديل. يرجى مراجعة النسخة الأحدث في الخادم أولًا.',
      });
      return;
    }
    if (!approved) {
      setFeedback({
        type: 'error',
        message: 'يجب اعتماد الجهاز أولًا قبل حفظ إعدادات شاشة الشركة.',
      });
      return;
    }
    if (enabled && !canConfigure) {
      setFeedback({
        type: 'error',
        message:
          'ثبّت تحديث Android 0.4.0 أو أحدث على جهاز Android 11 (SDK 30) أو أحدث مع تفعيل Device Owner أولًا.',
      });
      return;
    }
    if (enabled && allowedApps.length === 0) {
      setFeedback({
        type: 'error',
        message: 'عند تفعيل شاشة الشركة يجب اختيار تطبيق واحد على الأقل ليظهر للمندوب.',
      });
      return;
    }

    setSaving(true);
    try {
      const savedPolicy = await executeKioskSave({
        db,
        uid,
        actor,
        serverReady,
        expectedRevision: expectedRevisionRef.current,
        enabled,
        allowedApps,
        password,
        confirmPassword,
        remote,
      });

      isDirtyRef.current = false;
      expectedRevisionRef.current = savedPolicy.revision;
      setExpectedRevision(savedPolicy.revision);
      setRemote(savedPolicy);
      setEnabled(savedPolicy.enabled);
      setAllowedApps(savedPolicy.allowed_apps);
      setRevisionConflict(null);
      setPassword('');
      setConfirmPassword('');
      setFeedback({
        type: 'success',
        message: 'حُفظ الطلب؛ بانتظار تأكيد الهاتف.',
      });
    } catch (err: unknown) {
      const classified = classifyFirestoreError(err, 'إعدادات شاشة الشركة');
      setFeedback({
        type: 'error',
        message:
          classified.category === 'other'
            ? err instanceof Error
              ? err.message
              : String(err)
            : `${classified.title}: ${classified.detail}`,
      });
    } finally {
      setSaving(false);
    }
  };

  // Phone confirmation state derivation using strict Kiosk enforcement evaluation
  const phoneConfirmationSummary = useMemo(() => {
    const activeError = statusListenerError || policyListenerError;
    if (activeError) {
      return {
        tone: 'error' as const,
        label:
          activeError.category === 'permission_denied'
            ? 'تعذر القراءة (رفض صلاحيات)'
            : activeError.category === 'connectivity'
            ? 'تعذر الاتصال بالخادم'
            : 'خطأ في قراءة الحالة',
        detail: activeError.detail,
      };
    }
    return evaluateKioskEnforcementState(remote, kioskStatus);
  }, [statusListenerError, policyListenerError, remote, kioskStatus]);

  const inventoryTimestampMs = extractTimestampMs(inventory?.reported_at);
  const inventoryTimeFormatted = formatTimestampAr(inventoryTimestampMs);
  const activeListenerError = policyListenerError || statusListenerError;

  return (
    <div className="space-y-6">
      {/* Classified Listener Error Alert (Permission vs Connectivity vs Other) */}
      {activeListenerError && (
        <div
          className={`rounded-2xl p-5 flex flex-col sm:flex-row items-start justify-between gap-4 border ${
            activeListenerError.category === 'connectivity'
              ? 'bg-amber-50 border-amber-200'
              : 'bg-red-50 border-red-200'
          }`}
        >
          <div className="flex items-start gap-3.5">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                activeListenerError.category === 'connectivity'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-red-100 text-red-700'
              }`}
            >
              {activeListenerError.category === 'connectivity' ? (
                <WifiOff className="w-5 h-5" />
              ) : (
                <AlertTriangle className="w-5 h-5" />
              )}
            </div>
            <div className="space-y-1.5 text-sm">
              <h4
                className={`font-bold ${
                  activeListenerError.category === 'connectivity'
                    ? 'text-amber-950'
                    : 'text-red-950'
                }`}
              >
                {activeListenerError.title}
              </h4>
              <p
                className={`leading-relaxed ${
                  activeListenerError.category === 'connectivity'
                    ? 'text-amber-900'
                    : 'text-red-800'
                }`}
              >
                {activeListenerError.detail}
              </p>
            </div>
          </div>
          {activeListenerError.category === 'permission_denied' && onNavigateAdvancedSettings && (
            <button
              type="button"
              onClick={onNavigateAdvancedSettings}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-700 hover:bg-red-800 text-white text-xs font-bold shrink-0 transition-colors cursor-pointer"
            >
              <Settings className="w-4 h-4" />
              مراجعة الإعدادات وقواعد الأمان
            </button>
          )}
        </div>
      )}

      {/* Corrupted Server Policy Warning */}
      {corruptedPolicyError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3 text-sm text-red-900"
        >
          <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold">بيانات شاشة الشركة المخزنة غير صالحة</p>
            <p className="text-xs text-red-800">{corruptedPolicyError}</p>
          </div>
        </div>
      )}

      {/* Concurrent Revision Conflict Banner (Draft Preserved) */}
      {revisionConflict && (
        <div
          role="alert"
          className="bg-amber-50 border border-amber-300 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-sm text-amber-950"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold">
                تعارض إصدارات: وصلت نسخة أحدث من الخادم أثناء تعديلك (الإصدار الجديد:{' '}
                {revisionConflict.incomingRevision ?? 'غير موجود'}، الإصدار المثبت لمسودتك:{' '}
                {revisionConflict.pinnedRevision ?? 'الأولي'})
              </p>
              <p className="text-xs text-amber-900">
                تم الحفاظ على مسودة تعديلاتك الحالية ولم يتم استبدالها تلقائيًا. لاستكمال العمل على
                أحدث نسخة من الخادم، اضغط على زر تحميل نسخة الخادم المحدثة.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleResetChanges}
            className="px-4 py-2 rounded-xl bg-amber-800 hover:bg-amber-900 text-white text-xs font-bold shrink-0 cursor-pointer"
          >
            تحميل نسخة الخادم وتجاهل المسودة
          </button>
        </div>
      )}

      {/* Agent / Approval Compatibility Banner */}
      {!canConfigure && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3 text-sm text-amber-900">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold">شروط تفعيل شاشة الشركة غير مكتملة على هذا الجهاز</p>
            <p className="text-xs text-amber-800 leading-relaxed">
              {!approved
                ? 'الجهاز غير معتمد حاليًا. يجب اعتماد الجهاز أولًا من تبويب «ملخص الجهاز» قبل تفعيل شاشة الشركة.'
                : status?.device_owner !== true
                ? 'صلاحية Device Owner غير مفعلة على الهاتف.'
                : 'يتطلب وضع شاشة الشركة تحديث وكيل الهاتف إلى الإصدار 0.4.0-pilot أو أحدث على نظام Android 11 (SDK 30+).'}{' '}
              (إصدار الوكيل الحالي:{' '}
              <span dir="ltr" className="font-mono font-semibold">
                {status?.agent_version || 'غير معروف'}
              </span>
              ).
            </p>
          </div>
        </div>
      )}

      {/* 3 Status Summary Cards: Activation Status, Last Inventory Time, Phone Confirmation */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200/90 p-4 shadow-xs flex items-start justify-between gap-3">
          <div className="space-y-1">
            <span className="text-xs font-semibold text-slate-500">حالة التفعيل المطلوبة</span>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold ${
                  enabled
                    ? 'bg-blue-50 text-blue-800 border border-blue-200'
                    : 'bg-slate-100 text-slate-700 border border-slate-200'
                }`}
              >
                <Lock className="w-3.5 h-3.5" />
                {enabled ? 'تفعيل شاشة الشركة' : 'شاشة الشركة متوقفة'}
              </span>
              {remote && (
                <span className="text-xs text-slate-400">الإصدار المحفوظ #{remote.revision}</span>
              )}
            </div>
            <p className="text-xs text-slate-500 pt-1">
              {enabled
                ? `مسموح بظهور ${allowedApps.length} تطبيق فقط للمندوب مع منع تثبيت التطبيقات.`
                : 'يعمل الهاتف بواجهة أندرويد المعتادة مع بقاء حظر التطبيقات الممنوعة.'}
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer select-none mt-1">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={enabled}
              disabled={!approved || (!canConfigure && !enabled)}
              onChange={(e) => {
                beginEdit();
                setEnabled(e.target.checked);
              }}
            />
            <div className="w-12 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600 peer-disabled:opacity-50" />
          </label>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/90 p-4 shadow-xs space-y-1.5">
          <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            آخر جرد تطبيقات وارد من الهاتف
          </span>
          <p className="text-sm font-bold text-slate-900">
            {inventoryTimestampMs
              ? inventoryTimeFormatted.relative
              : 'لم يصل جرد تطبيقات بعد'}
          </p>
          <p className="text-xs text-slate-500">
            {inventoryTimestampMs
              ? `${inventoryTimeFormatted.formatted} • ${selectableInventoryApps.length} تطبيق قابل للاختيار`
              : 'يمكنك اختيار التطبيقات فور وصول قائمة تطبيقات الهاتف'}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/90 p-4 shadow-xs space-y-1.5">
          <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
            <Smartphone className="w-3.5 h-3.5 text-slate-400" />
            تأكيد التنفيذ الفعلي على الهاتف
          </span>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg text-xs font-bold ${
                phoneConfirmationSummary.tone === 'success'
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : phoneConfirmationSummary.tone === 'error'
                  ? 'bg-red-50 text-red-800 border border-red-200'
                  : phoneConfirmationSummary.tone === 'warning'
                  ? 'bg-amber-50 text-amber-800 border border-amber-200'
                  : phoneConfirmationSummary.tone === 'pending'
                  ? 'bg-blue-50 text-blue-800 border border-blue-200'
                  : 'bg-slate-100 text-slate-700 border border-slate-200'
              }`}
            >
              {phoneConfirmationSummary.label}
            </span>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            {phoneConfirmationSummary.detail}
          </p>
        </div>
      </div>

      {/* Main 2-Column Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Right Column: Wide Searchable & Filterable App Selection List from Actual Inventory */}
        <div className="lg:col-span-7 bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
          <div className="p-5 border-b border-slate-100 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  اختيار التطبيقات المسموح بظهورها على شاشة الشركة
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  تُعرض التطبيقات الفعلية الواردة من جرد الهاتف فقط (بحد أقصى 50 تطبيقًا).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPackageNames((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors cursor-pointer ${
                  showPackageNames
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <Code2 className="w-3.5 h-3.5" />
                {showPackageNames ? 'إخفاء المعرفات التقنية' : 'إظهار المعرفات التقنية'}
              </button>
            </div>

            {/* Search & Filter Controls */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="ابحث باسم التطبيق..."
                  className="w-full pr-10 pl-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:border-blue-600 focus:outline-none"
                />
              </div>
              <div className="inline-flex rounded-xl bg-slate-100 p-1 shrink-0">
                {(
                  [
                    { id: 'all', label: `الكل (${selectableInventoryApps.length})` },
                    { id: 'selected', label: `المختارة (${allowedApps.length})` },
                    {
                      id: 'unselected',
                      label: `غير المختارة (${Math.max(
                        0,
                        selectableInventoryApps.length - allowedApps.length
                      )})`,
                    },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setAppFilter(tab.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                      appFilter === tab.id
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Unavailable Previously-Selected Apps Warning */}
          {unavailableSelectedApps.length > 0 && (
            <div className="p-4 bg-amber-50 border-b border-amber-200 space-y-2">
              <p className="text-xs font-bold text-amber-900">
                تطبيقات مختارة سابقًا لم تعد متاحة في آخر جرد للهاتف (يلزم إزالتها قبل تفعيل شاشة الشركة، ويمكنك تعطيل الشاشة دون إزالتها):
              </p>
              <div className="flex flex-wrap gap-2">
                {unavailableSelectedApps.map((pkg) => (
                  <span
                    key={pkg}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white border border-amber-300 text-xs font-bold text-amber-950"
                  >
                    <span dir="ltr" className="font-mono">
                      {pkg}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleApp(pkg)}
                      className="text-red-700 hover:underline cursor-pointer"
                    >
                      إزالة من المسموح
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Apps List */}
          <div className="divide-y divide-slate-100 max-h-[520px] overflow-y-auto">
            {filteredApps.length === 0 ? (
              <div className="p-10 text-center space-y-2">
                <p className="text-sm font-bold text-slate-700">
                  {selectableInventoryApps.length === 0
                    ? 'لم يصل جرد التطبيقات من هذا الهاتف بعد'
                    : 'لا توجد تطبيقات مطابقة للبحث أو التصفية الحالية'}
                </p>
                <p className="text-xs text-slate-500">
                  {selectableInventoryApps.length === 0
                    ? 'افتح تطبيق إنجاز على الهاتف وقم بالمزامنة لنشر قائمة التطبيقات المثبتة فعليًا.'
                    : 'جرب تغيير عبارة البحث أو التبديل إلى عرض جميع التطبيقات.'}
                </p>
              </div>
            ) : (
              filteredApps.map((app) => {
                const isSelected = allowedApps.includes(app.packageName);
                const isUnavailable =
                  app.isHiddenByAgent || !app.isEnabledOnPhone || app.isBlockedInPolicy;
                return (
                  <div
                    key={app.packageName}
                    className={`px-5 py-3.5 flex items-center justify-between gap-4 transition-colors ${
                      isSelected ? 'bg-blue-50/40' : 'hover:bg-slate-50/80'
                    }`}
                  >
                    <div className="min-w-0 flex items-center gap-3">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm shrink-0 ${
                          isSelected
                            ? 'bg-blue-600 text-white'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {app.appName.slice(0, 2)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold text-slate-900 truncate">
                            {app.appName}
                          </span>
                          {isSelected ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold bg-blue-100 text-blue-800">
                              مسموح في شاشة الشركة
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 text-slate-600">
                              غير مضاف للشاشة
                            </span>
                          )}
                          {(app.isHiddenByAgent || app.isBlockedInPolicy) && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold bg-red-50 text-red-700 border border-red-200">
                              محظور؛ ارفع الحظر أولًا
                            </span>
                          )}
                          {!app.isEnabledOnPhone && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
                              معطل على الهاتف
                            </span>
                          )}
                        </div>
                        {showPackageNames && (
                          <p
                            dir="ltr"
                            className="text-xs font-mono text-slate-500 truncate mt-0.5 text-right"
                          >
                            {app.packageName}
                          </p>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={!approved || (isUnavailable && !isSelected)}
                      onClick={() => toggleApp(app.packageName)}
                      className={`px-3.5 py-2 rounded-xl text-xs font-bold shrink-0 transition-colors cursor-pointer disabled:opacity-50 ${
                        isSelected
                          ? 'bg-white border border-slate-300 text-slate-700 hover:bg-red-50 hover:text-red-700 hover:border-red-200'
                          : 'bg-blue-600 text-white hover:bg-blue-700'
                      }`}
                    >
                      {isSelected ? 'إزالة من الشاشة' : 'إضافة للشاشة'}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Left Column: Selected Apps Summary + Maintenance Password (12+ chars) + Save */}
        <div className="lg:col-span-5 space-y-5">
          {/* Selected Apps Summary Card */}
          <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-bold text-slate-900">
                  ملخص التطبيقات المختارة ({allowedApps.length} / 50)
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  هذه التطبيقات فقط ستظهر على الشاشة الرئيسية للهاتف عند التفعيل.
                </p>
              </div>
              {allowedApps.length > 0 && approved && (
                <button
                  type="button"
                  onClick={() => {
                    beginEdit();
                    setAllowedApps([]);
                  }}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 cursor-pointer"
                >
                  إفراغ القائمة
                </button>
              )}
            </div>

            {allowedApps.length === 0 ? (
              <div className="p-4 rounded-xl bg-slate-50 border border-dashed border-slate-200 text-center">
                <p className="text-xs text-slate-500">
                  لم يتم اختيار أي تطبيق بعد. اختر تطبيقًا واحدًا على الأقل لتفعيل شاشة الشركة.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-1">
                {allowedApps.map((pkg) => {
                  const invApp = inventory?.apps?.find((a) => a.package_name === pkg);
                  const catApp = lookupAppInfo(pkg);
                  const label = invApp?.app_name || catApp?.nameAr || pkg;
                  return (
                    <span
                      key={pkg}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 text-blue-900 border border-blue-200 text-xs font-bold"
                    >
                      <span>{label}</span>
                      {approved && (
                        <button
                          type="button"
                          onClick={() => toggleApp(pkg)}
                          title="إزالة"
                          className="text-blue-500 hover:text-red-600 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Independent Manager Maintenance Password Section */}
          <div className="bg-white rounded-2xl border border-slate-200/90 p-5 shadow-xs space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 flex items-center justify-center shrink-0">
                <KeyRound className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-slate-900">
                  كلمة مرور صيانة المدير (12 حرفًا على الأقل)
                </h4>
                <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                  تُستخدم على الهاتف للدخول إلى وضع الصيانة محليًا دون إنترنت. تُشتق عبر
                  PBKDF2-HMAC-SHA256 (120,000 تكرار) ولا تُحفظ أو تُسجل في التدقيق كنص صريح أو مشتق.
                </p>
              </div>
            </div>

            {remote && (
              <div className="px-3.5 py-2.5 rounded-xl bg-emerald-50/70 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>
                  توجد كلمة مرور صيانة محفوظة حاليًا. اترك الحقلين فارغين للإبقاء عليها، أو أدخل
                  كلمة جديدة (12 حرفًا على الأقل) لتغييرها.
                </span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {remote ? 'كلمة مرور صيانة جديدة (اختياري)' : 'كلمة مرور الصيانة الجديدة *'}
                </label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  disabled={!approved}
                  onChange={(e) => {
                    beginEdit();
                    setPassword(e.target.value);
                  }}
                  placeholder="12 حرفًا على الأقل"
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:border-blue-600 focus:outline-none disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  تأكيد كلمة مرور الصيانة
                </label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  disabled={!approved}
                  onChange={(e) => {
                    beginEdit();
                    setConfirmPassword(e.target.value);
                  }}
                  placeholder="تأكيد كلمة المرور"
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:border-blue-600 focus:outline-none disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          {/* Save & Changes Summary Card */}
          <div className="bg-slate-900 text-white rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-bold">اعتماد وحفظ إعدادات شاشة الشركة</h4>
                <p className="text-xs text-slate-300 mt-0.5">
                  {isDirty
                    ? `مسودة مرتبطة بالإصدار الأساسي (${
                        expectedRevision ?? 'الأولي'
                      }) جاهزة للحفظ.`
                    : 'جميع الإعدادات المعروضة مطابقة لآخر نسخة محفوظة.'}
                </p>
              </div>
              {isDirty && (
                <span className="px-2.5 py-1 rounded-lg bg-amber-400/20 text-amber-300 text-xs font-bold shrink-0">
                  تغييرات غير محفوظة
                </span>
              )}
            </div>

            {feedback && (
              <div
                role={feedback.type === 'error' ? 'alert' : 'status'}
                className={`p-3.5 rounded-xl text-xs font-semibold leading-relaxed ${
                  feedback.type === 'success'
                    ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/30'
                    : 'bg-red-500/20 text-red-200 border border-red-500/30'
                }`}
              >
                {feedback.message}
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={
                  !serverReady ||
                  !approved ||
                  saving ||
                  loading ||
                  Boolean(revisionConflict) ||
                  Boolean(corruptedPolicyError)
                }
                onClick={handleSave}
                className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold transition-colors disabled:opacity-50 cursor-pointer"
              >
                {saving ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {saving ? 'جارٍ الحفظ...' : 'حفظ إعدادات شاشة الشركة'}
              </button>

              {isDirty && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleResetChanges}
                  className="px-4 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition-colors cursor-pointer"
                >
                  تراجع
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
