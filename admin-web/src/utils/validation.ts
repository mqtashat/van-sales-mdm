import type {
  ApprovalState,
  BulkActionPlanItem,
  DeviceAppInventoryDoc,
  DeviceMetadataDoc,
  DeviceStatusDoc,
  EnforcementState,
  EnrollmentDoc,
  MergedDeviceRecord,
  PolicyDoc,
} from '../types/mdm.ts';

/**
 * Exact regex from Policy.java line 37:
 * "[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+"
 */
export const ANDROID_PACKAGE_REGEX = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * Maximum number of blocked apps allowed by Policy.java line 33:
 * ((List<?>) apps).size() > 50
 */
export const MAX_BLOCKED_APPS = 50;

/**
 * Hardcoded protected packages in AppRestrictions.java lines 16-18:
 * context.getPackageName() ("com.company.mdmagent"),
 * "com.android.settings", "com.android.systemui",
 * "com.google.android.gms", "com.google.android.gsf", "com.android.vending"
 */
export const HARDCODED_PROTECTED_PACKAGES: Record<string, string> = {
  'com.company.mdmagent': 'تطبيق وكيل الإدارة نفسه (INJAZ MDM Agent) — محمي لمنع قفل الإدارة عن الجهاز',
  'com.android.settings': 'إعدادات النظام (Android Settings) — محمي في كود الوكيل',
  'com.android.systemui': 'واجهة النظام (System UI) — محمي في كود الوكيل',
  'com.google.android.gms': 'خدمات Google Play (GMS) — ضرورية لاتصال Firebase ومزامنة السياسات',
  'com.google.android.gsf': 'إطار خدمات Google (GSF) — محمي في كود الوكيل',
  'com.android.vending': 'متجر Google Play — محمي في كود الوكيل',
};

export const PROTECTED_PACKAGES = Object.keys(HARDCODED_PROTECTED_PACKAGES);

/**
 * Advisory warnings for packages that AppRestrictions.java (lines 19-35) or README.md (lines 106-107)
 * protect dynamically on the device (keyboards, dialer, home launcher, or preinstalled system apps).
 */
export const DYNAMICALLY_PROTECTED_ADVISORY_PACKAGES: Record<string, string> = {


  'com.google.android.inputmethod.latin': 'تنبيه: لوحة مفاتيح Gboard محمية تلقائيًا بواسطة InputMethodManager في الوكيل ولن يُسمح بإخفائها.',
  'com.google.android.dialer': 'تنبيه: تطبيق الهاتف الافتراضي محمي تلقائيًا بواسطة TelecomManager في الوكيل.',
  'com.android.dialer': 'تنبيه: تطبيق الهاتف الافتراضي محمي تلقائيًا بواسطة TelecomManager في الوكيل.',
  'com.transsion.hilauncher': 'تنبيه: الواجهة الرئيسية (HiOS Launcher على TECNO) محمية تلقائيًا في الوكيل.',
};

export interface PackageValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
}

/**
 * Validates an Android package name against Policy.java & AppRestrictions.java rules.
 */
export function validatePackageName(
  rawInput: string,
  existingList: string[] = []
): PackageValidationResult {
  const pkg = rawInput.trim();

  if (!pkg) {
    return { valid: false, error: 'يرجى إدخال اسم الحزمة (مثال: com.example.app).' };
  }

  if (pkg.length > 150) {
    return { valid: false, error: 'اسم الحزمة طويل جدًا (الحد الأقصى 150 حرفًا).' };
  }

  if (!ANDROID_PACKAGE_REGEX.test(pkg)) {
    return {
      valid: false,
      error:
        'صيغة اسم الحزمة غير صالحة وفق Policy.java. يجب أن تتكون من مقطعين على الأقل مفصولين بنقطة وتبدأ بحرف لاتيني (مثال: com.example.game).',
    };
  }

  if (HARDCODED_PROTECTED_PACKAGES[pkg]) {
    return {
      valid: false,
      error: `لا يمكن حظر هذه الحزمة: ${HARDCODED_PROTECTED_PACKAGES[pkg]}`,
    };
  }

  if (existingList.includes(pkg)) {
    return {
      valid: false,
      error: 'هذه الحزمة مضافة بالفعل في قائمة التطبيقات المحظورة.',
    };
  }

  if (existingList.length >= MAX_BLOCKED_APPS) {
    return {
      valid: false,
      error: `الحد الأقصى المسموح به في Policy.java هو ${MAX_BLOCKED_APPS} حزمة فقط.`,
    };
  }

  const warning = DYNAMICALLY_PROTECTED_ADVISORY_PACKAGES[pkg];
  return { valid: true, warning };
}

/**
 * Strictly parses an enrollment document without Boolean(value) coercion.
 * A string "false" or "true" is rejected as corrupted data rather than coerced to true.
 */
export function parseEnrollmentData(raw: Record<string, unknown> | undefined | null): EnrollmentDoc {
  if (!raw || typeof raw !== 'object') {
    return {
      approved: false,
      isCorrupted: true,
      corruptionReason: 'بيانات مستند الاعتماد فارغة أو غير صالحة.',
      rawData: {},
    };
  }

  if (typeof raw.approved !== 'boolean') {
    return {
      approved: false,
      isCorrupted: true,
      corruptionReason: `الحقل approved يجب أن يكون قيمة منطقية (boolean)، لكن القيمة المخزنة من نوع (${typeof raw.approved}: ${JSON.stringify(raw.approved)}).`,
      rawData: raw,
    };
  }

  return {
    approved: raw.approved,
    isCorrupted: false,
    rawData: raw,
  };
}

/**
 * Strictly parses a policy document matching Policy.java without coercing invalid values.
 * Never replaces an invalid schema_version with 1, never coerces "false" to true,
 * and never converts a corrupted blocked_apps field into an empty array.
 */
export function parsePolicyData(raw: Record<string, unknown> | undefined | null): PolicyDoc {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return {
      schema_version: -1,
      revision: 0,
      block_tethering: false,
      blocked_apps: [],
      isCorrupted: true,
      corruptionErrors: ['مستند السياسة فارغ أو ليس كائنًا صالحًا.'],
      rawData: {},
    };
  }

  // 1. schema_version must be integer 1
  const schemaVersion = raw.schema_version;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion !== 1) {
    errors.push(
      `الحقل schema_version يجب أن يكون العدد الصحيح 1، لكن القيمة الفعلية هي: ${JSON.stringify(schemaVersion)}`
    );
  }

  // 2. revision must be positive integer >= 1
  const revision = raw.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    errors.push(
      `الحقل revision يجب أن يكون عددًا صحيحًا موجبًا (>= 1)، لكن القيمة الفعلية هي: ${JSON.stringify(revision)}`
    );
  }

  // 3. block_tethering must be strict boolean
  const blockTethering = raw.block_tethering;
  if (typeof blockTethering !== 'boolean') {
    errors.push(
      `الحقل block_tethering يجب أن يكون boolean صريحًا (true/false)، لكن القيمة الفعلية هي: ${JSON.stringify(blockTethering)}`
    );
  }

  // 4. blocked_apps must be an array of up to 50 valid package name strings
  const blockedAppsRaw = raw.blocked_apps;
  const preservedStrings: string[] = [];
  if (!Array.isArray(blockedAppsRaw)) {
    errors.push(
      `الحقل blocked_apps يجب أن يكون مصفوفة (Array)، لكن القيمة الفعلية هي: ${JSON.stringify(blockedAppsRaw)}`
    );
  } else {
    if (blockedAppsRaw.length > MAX_BLOCKED_APPS) {
      errors.push(
        `المصفوفة blocked_apps تحتوي على ${blockedAppsRaw.length} عنصرًا، وهو ما يتجاوز الحد الأقصى (${MAX_BLOCKED_APPS}).`
      );
    }
    blockedAppsRaw.forEach((item, idx) => {
      if (typeof item !== 'string') {
        errors.push(`العنصر رقم ${idx + 1} في blocked_apps ليس نصًا: ${JSON.stringify(item)}`);
      } else {
        preservedStrings.push(item);
        if (!ANDROID_PACKAGE_REGEX.test(item)) {
          errors.push(`اسم الحزمة في الموضع ${idx + 1} غير صالح وفق Policy.java: "${item}"`);
        }
        if (HARDCODED_PROTECTED_PACKAGES[item]) {
          errors.push(`الحزمة في الموضع ${idx + 1} محمية ولا يجوز حظرها: "${item}"`);
        }
      }
    });
  }

  return {
    schema_version: typeof schemaVersion === 'number' ? schemaVersion : -1,
    revision: typeof revision === 'number' && Number.isInteger(revision) ? revision : 0,
    block_tethering: typeof blockTethering === 'boolean' ? blockTethering : false,
    blocked_apps: preservedStrings,
    isCorrupted: errors.length > 0,
    corruptionErrors: errors.length > 0 ? errors : undefined,
    rawData: raw,
  };
}

/**
 * Strictly parses a deviceStatus document without Boolean(value) coercion.
 */
export function parseDeviceStatusData(
  raw: Record<string, unknown> | undefined | null
): DeviceStatusDoc {
  const errors: string[] = [];
  const d = raw || {};

  if (typeof d.device_owner !== 'boolean') {
    errors.push(`device_owner ليس boolean (${JSON.stringify(d.device_owner)})`);
  }
  if (typeof d.applied_revision !== 'number' || !Number.isInteger(d.applied_revision) || d.applied_revision < 0) {
    errors.push(`applied_revision غير صالح (${JSON.stringify(d.applied_revision)})`);
  }
  if (typeof d.tethering_restricted !== 'boolean') {
    errors.push(`tethering_restricted ليس boolean (${JSON.stringify(d.tethering_restricted)})`);
  }

  return {
    device_owner: d.device_owner === true,
    applied_revision:
      typeof d.applied_revision === 'number' && Number.isInteger(d.applied_revision)
        ? d.applied_revision
        : 0,
    tethering_restricted: d.tethering_restricted === true,
    last_seen: (d.last_seen as DeviceStatusDoc['last_seen']) ?? null,
    model: typeof d.model === 'string' ? d.model : 'غير معروف',
    android_sdk: typeof d.android_sdk === 'number' ? d.android_sdk : 0,
    battery_percent: typeof d.battery_percent === 'number' ? d.battery_percent : 0,
    error: typeof d.error === 'string' ? d.error : '',
    agent_version: typeof d.agent_version === 'string' ? d.agent_version : '',
    isCorrupted: errors.length > 0,
    corruptionErrors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Manual UID sanitizer:
 * Per Requirement 4: "عند إدخال UID يدويًا استخدم النص كما هو مع إزالة الفراغات الطرفية فقط؛ لا تغير حالة الأحرف."
 */
export function sanitizeManualUid(rawUid: string): {
  uid: string;
  valid: boolean;
  error?: string;
} {
  const uid = rawUid.trim(); // Only trim outer whitespace; NEVER alter character case!
  if (!uid) {
    return { uid, valid: false, error: 'يرجى إدخال معرّف الجهاز (UID).' };
  }
  if (uid.length > 128) {
    return { uid, valid: false, error: 'معرّف الجهاز يتجاوز الطول المسموح (128 حرفًا).' };
  }
  if (!/^[a-zA-Z0-9_\-]+$/.test(uid)) {
    return {
      uid,
      valid: false,
      error: 'يحتوي UID على رموز غير صالحة أو مسافات داخلية. استخدم المعرّف المنسوخ من تطبيق الهاتف كما هو.',
    };
  }
  return { uid, valid: true };
}

/**
 * Maps Android SDK integer (Build.VERSION.SDK_INT) to human-readable Android release.
 */
export function formatAndroidSdk(sdk: number | undefined | null): string {
  if (sdk === undefined || sdk === null || Number.isNaN(sdk)) return 'غير متوفر';
  const map: Record<number, string> = {
    26: 'Android 8.0',
    27: 'Android 8.1',
    28: 'Android 9',
    29: 'Android 10',
    30: 'Android 11',
    31: 'Android 12',
    32: 'Android 12L',
    33: 'Android 13',
    34: 'Android 14',
    35: 'Android 15',
  };
  return map[sdk] ? `${map[sdk]} (SDK ${sdk})` : `SDK ${sdk}`;
}

/**
 * WorkManager periodic sync is 15 minutes minimum (AgentApp.java line 15).
 * We mark a connection as stale ("اتصال قديم") if last_seen is older than 35 minutes.
 */
export const STALE_THRESHOLD_MS = 35 * 60 * 1000;

/**
 * Merges enrollments, policies, deviceStatus, and deviceMetadata by UID.
 * Strictly distinguishes between approval, desired policy, and verified device execution status.
 */
export function buildMergedDevices(
  enrollments: Record<string, EnrollmentDoc>,
  policies: Record<string, PolicyDoc>,
  statuses: Record<string, DeviceStatusDoc>,
  metadataMap: Record<string, DeviceMetadataDoc>,
  nowMs: number = Date.now()
): MergedDeviceRecord[] {
  const allUids = new Set<string>([
    ...Object.keys(enrollments),
    ...Object.keys(policies),
    ...Object.keys(statuses),
    ...Object.keys(metadataMap),
  ]);

  const records: MergedDeviceRecord[] = [];

  for (const uid of allUids) {
    const enrollment = enrollments[uid] ?? null;
    const policy = policies[uid] ?? null;
    const status = statuses[uid] ?? null;
    const metadata = metadataMap[uid] ?? null;

    // 1. Approval State
    let approvalState: ApprovalState;
    if (!enrollment) {
      approvalState = 'missing_enrollment';
    } else if (enrollment.isCorrupted) {
      approvalState = 'corrupted_enrollment';
    } else if (enrollment.approved === true) {
      approvalState = 'approved';
    } else {
      approvalState = 'pending_approval';
    }

    // 2. Last seen & Stale calculation
    let lastSeenMs: number | null = null;
    if (status?.last_seen && typeof status.last_seen.toMillis === 'function') {
      lastSeenMs = status.last_seen.toMillis();
    }
    const isStaleConnection =
      lastSeenMs !== null ? nowMs - lastSeenMs > STALE_THRESHOLD_MS : false;

    // 3. Policy Enforcement State
    let enforcementState: EnforcementState;
    let enforcementDetail: string;

    if (!policy) {
      if (status?.error && status.error.trim().length > 0) {
        enforcementState = 'error';
        enforcementDetail = `لم تُنشأ سياسة بعد، لكن الجهاز أبلغ عن خطأ: ${status.error}`;
      } else {
        enforcementState = 'no_policy';
        enforcementDetail = 'لم تُنشأ وثيقة سياسة (policies/{uid}) لهذا الجهاز بعد.';
      }
    } else if (policy.isCorrupted) {
      enforcementState = 'corrupted_policy';
      enforcementDetail = `وثيقة السياسة المخزنة تحتوي على بيانات تالفة أو مخالفة للعقد: ${(policy.corruptionErrors || []).join(' | ')}`;
    } else if (!status) {
      enforcementState = 'pending';
      enforcementDetail = `تم حفظ السياسة (الإصدار ${policy.revision})، بانتظار أول اتصال وتقرير حالة من الجهاز.`;
    } else if (status.isCorrupted) {
      enforcementState = 'error';
      enforcementDetail = `تقرير حالة الجهاز (deviceStatus) يحتوي على حقول غير صالحة: ${(status.corruptionErrors || []).join(' | ')}`;
    } else if (status.error && status.error.trim().length > 0) {
      enforcementState = 'error';
      enforcementDetail = status.error;
    } else if (!status.device_owner) {
      enforcementState = 'error';
      enforcementDetail = 'صلاحية Device Owner غير مفعّلة على الهاتف؛ لا يمكن فرض السياسة.';
    } else if (status.applied_revision < policy.revision) {
      enforcementState = 'pending';
      enforcementDetail = `تم حفظ السياسة (الإصدار ${policy.revision})، بانتظار تطبيق الجهاز (المطبق حاليًا: ${status.applied_revision}).`;
    } else if (status.applied_revision > policy.revision) {
      enforcementState = 'error';
      enforcementDetail = `تعارض إصدارات (stale revision): الجهاز يطبق الإصدار ${status.applied_revision} بينما السياسة في الخادم ${policy.revision}. احفظ تعديلًا جديدًا لرفع الإصدار.`;
    } else if (status.tethering_restricted !== policy.block_tethering) {
      enforcementState = 'error';
      enforcementDetail = `تطابق رقم الإصدار (${policy.revision}) لكن حالة منع المشاركة الفعلية (${status.tethering_restricted ? 'ممنوع' : 'غير ممنوع'}) لا تطابق السياسة المطلوبة.`;
    } else {
      enforcementState = 'applied';
      enforcementDetail = `تم التحقق من تطبيق الإصدار ${policy.revision} بنجاح على الجهاز.`;
    }

    records.push({
      uid,
      enrollment,
      policy,
      status,
      metadata,
      approvalState,
      enforcementState,
      enforcementDetail,
      isStaleConnection,
      lastSeenMs,
      presentInCollections: {
        enrollments: Boolean(enrollment),
        policies: Boolean(policy),
        deviceStatus: Boolean(status),
        deviceMetadata: Boolean(metadata),
      },
    });
  }

  records.sort((a, b) => {
    const score = (r: MergedDeviceRecord) => {
      if (r.enforcementState === 'corrupted_policy' || r.approvalState === 'corrupted_enrollment') return -1;
      if (r.enforcementState === 'error') return 0;
      if (r.approvalState !== 'approved') return 1;
      if (r.enforcementState === 'pending') return 2;
      return 3;
    };
    const diff = score(a) - score(b);
    if (diff !== 0) return diff;
    if (a.lastSeenMs && b.lastSeenMs) return b.lastSeenMs - a.lastSeenMs;
    if (a.lastSeenMs) return -1;
    if (b.lastSeenMs) return 1;
    return a.uid.localeCompare(b.uid);
  });

  return records;
}

/**
 * Formats a timestamp in Arabic locale with clear relative time indicator.
 */
export function formatTimestampAr(ms: number | null): {
  formatted: string;
  relative: string;
} {
  if (!ms) {
    return { formatted: 'لم يتصل بعد', relative: 'لا يوجد سجل' };
  }
  const date = new Date(ms);
  const formatted = new Intl.DateTimeFormat('ar-SA', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(date);

  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  let relative: string;
  if (diffSec < 60) {
    relative = 'منذ لحظات';
  } else if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    relative = `منذ ${mins} دقيقة`;
  } else if (diffSec < 86400) {
    const hours = Math.floor(diffSec / 3600);
    relative = `منذ ${hours} ساعة`;
  } else {
    const days = Math.floor(diffSec / 86400);
    relative = `منذ ${days} يوم`;
  }

  return { formatted, relative };
}

/**
 * Honest relative communication helper clarifying that sync is periodic and
 * an old timestamp is not conclusive proof of disconnection.
 */
export function formatLastSeenAr(ms: number | null): {
  formatted: string;
  relative: string;
  explanation: string;
} {
  const base = formatTimestampAr(ms);
  if (!ms) {
    return {
      formatted: base.formatted,
      relative: base.relative,
      explanation: 'لم يسبق للجهاز إرسال تقرير حالة إلى الخادم.',
    };
  }

  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  let explanation = '';
  if (diffSec < 15 * 60) {
    explanation = 'تواصل حديث خلال الربع ساعة الماضية.';
  } else if (diffSec < 60 * 60) {
    explanation = 'المزامنة الدورية بالخلفية قد تتأخر بحسب إتاحة الشبكة وسياسات توفير الطاقة في أندرويد.';
  } else {
    explanation = 'آخر تواصل مسجل. لا يُعد قدم التاريخ دليلاً قاطعاً على انقطاع الجهاز إذا كان خارج التغطية أو في وضع توفير الطاقة.';
  }

  return {
    formatted: base.formatted,
    relative: base.relative,
    explanation,
  };
}

/**
 * Strictly parses a deviceAppInventory document chunk according to specification.
 */
export function parseAppInventoryData(
  raw: Record<string, unknown> | undefined | null
): DeviceAppInventoryDoc {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return {
      schema_version: 1,
      batch_id: '',
      batch_index: 0,
      total_batches: 1,
      reported_at: null,
      agent_version: '',
      apps: [],
      isCorrupted: true,
      corruptionErrors: ['وثيقة جرد التطبيقات فارغة أو غير صالحة.'],
    };
  }

  const schemaVersion = raw.schema_version;
  if (typeof schemaVersion !== 'number' || schemaVersion !== 1) {
    errors.push(`schema_version يجب أن يكون 1 (القيمة الحالية: ${JSON.stringify(schemaVersion)})`);
  }

  const batchId = typeof raw.batch_id === 'string' ? raw.batch_id : '';
  const batchIndex = typeof raw.batch_index === 'number' && Number.isInteger(raw.batch_index) ? raw.batch_index : 0;
  const totalBatches = typeof raw.total_batches === 'number' && Number.isInteger(raw.total_batches) ? raw.total_batches : 1;
  const agentVersion = typeof raw.agent_version === 'string' ? raw.agent_version : '';

  const appsRaw = raw.apps;
  const parsedApps: DeviceAppInventoryDoc['apps'] = [];

  if (!Array.isArray(appsRaw)) {
    errors.push('حقل apps يجب أن يكون مصفوفة تطبيقات.');
  } else {
    appsRaw.forEach((item, idx) => {
      if (!item || typeof item !== 'object') {
        errors.push(`العنصر رقم ${idx + 1} في apps ليس كائنًا.`);
        return;
      }
      const p = item as Record<string, unknown>;
      const pkg = typeof p.package_name === 'string' ? p.package_name.trim() : '';
      if (!pkg || !ANDROID_PACKAGE_REGEX.test(pkg)) {
        errors.push(`اسم الحزمة في العنصر ${idx + 1} غير صالح: "${pkg}"`);
      }
      parsedApps.push({
        package_name: pkg,
        app_name: typeof p.app_name === 'string' && p.app_name.trim().length > 0 ? p.app_name.trim() : pkg,
        has_launcher_icon: p.has_launcher_icon === true,
        is_system_app: p.is_system_app === true,
        is_protected: p.is_protected === true,
        protection_reason: typeof p.protection_reason === 'string' ? p.protection_reason : undefined,
        is_hidden_by_agent: p.is_hidden_by_agent === true,
        is_enabled: p.is_enabled !== false,
      });
    });
  }

  return {
    schema_version: typeof schemaVersion === 'number' ? schemaVersion : 1,
    batch_id: batchId,
    batch_index: batchIndex,
    total_batches: totalBatches,
    reported_at: (raw.reported_at as DeviceAppInventoryDoc['reported_at']) ?? null,
    agent_version: agentVersion,
    apps: parsedApps,
    isCorrupted: errors.length > 0,
    corruptionErrors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Computes a detailed, safe plan for bulk actions across multiple devices
 * before execution, catching conflicts, protected packages, and 50-package limits.
 */
export function computeBulkActionPlan(
  devices: MergedDeviceRecord[],
  targetUids: string[],
  action: 'block_apps' | 'allow_apps' | 'set_tethering',
  params: {
    packages?: string[];
    allowTethering?: boolean;
  }
): BulkActionPlanItem[] {
  const deviceMap = new Map<string, MergedDeviceRecord>(devices.map((d) => [d.uid, d]));
  const results: BulkActionPlanItem[] = [];

  const rawPackages = params.packages || [];
  const cleanPackages = Array.from(new Set(rawPackages.map((p) => p.trim()).filter(Boolean)));

  for (const uid of targetUids) {
    const rec = deviceMap.get(uid);
    if (!rec) {
      results.push({
        uid,
        deviceName: 'غير معروف',
        repName: 'غير معروف',
        eligible: false,
        skipReason: 'الجهاز غير موجود في السجلات.',
        currentRevision: null,
        currentBlockTethering: false,
        currentBlockedApps: [],
        nextBlockTethering: false,
        nextBlockedApps: [],
        hasActualChanges: false,
      });
      continue;
    }

    const deviceName = rec.metadata?.device_name || rec.status?.model || 'جهاز بدون اسم';
    const repName = rec.metadata?.rep_name || 'غير محدد';

    if (rec.approvalState !== 'approved') {
      results.push({
        uid,
        deviceName,
        repName,
        eligible: false,
        skipReason: 'الجهاز غير معتمد في Firebase (enrollments).',
        currentRevision: rec.policy?.revision ?? null,
        currentBlockTethering: rec.policy?.block_tethering ?? false,
        currentBlockedApps: rec.policy?.blocked_apps ?? [],
        nextBlockTethering: rec.policy?.block_tethering ?? false,
        nextBlockedApps: rec.policy?.blocked_apps ?? [],
        hasActualChanges: false,
      });
      continue;
    }

    if (rec.policy?.isCorrupted) {
      results.push({
        uid,
        deviceName,
        repName,
        eligible: false,
        skipReason: 'وثيقة السياسة تالفة في الخادم وتتطلب تصحيحاً يدوياً صريحاً أولاً.',
        currentRevision: rec.policy.revision,
        currentBlockTethering: rec.policy.block_tethering,
        currentBlockedApps: rec.policy.blocked_apps,
        nextBlockTethering: rec.policy.block_tethering,
        nextBlockedApps: rec.policy.blocked_apps,
        hasActualChanges: false,
      });
      continue;
    }

    const currentRev = rec.policy ? rec.policy.revision : null;
    const currentTethering = rec.policy ? rec.policy.block_tethering : false;
    const currentApps = rec.policy ? [...rec.policy.blocked_apps] : [];

    let nextTethering = currentTethering;
    let nextApps = [...currentApps];
    let eligible = true;
    let skipReason: string | undefined;

    if (action === 'set_tethering') {
      // allowTethering = true means block_tethering = false
      nextTethering = !(params.allowTethering === true);
    } else if (action === 'block_apps') {
      // Validate none of the requested packages are protected
      const protectedFound = cleanPackages.filter((p) => HARDCODED_PROTECTED_PACKAGES[p]);
      if (protectedFound.length > 0) {
        eligible = false;
        skipReason = `لا يمكن حظر حزم محمية: ${protectedFound.join(', ')}`;
      } else {
        const unionSet = new Set([...currentApps, ...cleanPackages]);
        if (unionSet.size > MAX_BLOCKED_APPS) {
          eligible = false;
          skipReason = `عدد التطبيقات المحظورة بعد الإضافة (${unionSet.size}) سيتجاوز الحد الأقصى (50).`;
        } else {
          nextApps = Array.from(unionSet);
        }
      }
    } else if (action === 'allow_apps') {
      const allowSet = new Set(cleanPackages);
      nextApps = currentApps.filter((pkg) => !allowSet.has(pkg));
    }

    // Determine if there is an actual change
    const hasTetheringChange = currentTethering !== nextTethering;
    const appsChanged =
      currentApps.length !== nextApps.length ||
      currentApps.some((pkg, idx) => pkg !== nextApps[idx]) ||
      nextApps.some((pkg) => !currentApps.includes(pkg));

    const hasActualChanges = hasTetheringChange || appsChanged;

    if (eligible && !hasActualChanges) {
      eligible = false;
      skipReason = 'السياسة الحالية للجهاز تطابق التعديل المطلوب مسبقاً (لا حاجة لرفع الإصدار).';
    }

    results.push({
      uid,
      deviceName,
      repName,
      eligible,
      skipReason,
      currentRevision: currentRev,
      currentBlockTethering: currentTethering,
      currentBlockedApps: currentApps,
      nextBlockTethering: nextTethering,
      nextBlockedApps: nextApps,
      hasActualChanges,
    });
  }

  return results;
}

