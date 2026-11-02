import React, { useState, useEffect } from 'react';
import {
  Sliders,
  Plus,
  Trash2,
  ShieldAlert,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Save,
  FilePlus2,
  Info,
  Wrench,
  RefreshCw,
} from 'lucide-react';
import {
  MDM_AGENT_PACKAGE_NAME,
  type MergedDeviceRecord,
} from '../types/mdm';
import {
  HARDCODED_PROTECTED_PACKAGES,
  MAX_BLOCKED_APPS,
  formatTimestampAr,
  sanitizeManualUid,
  validatePackageName,
} from '../utils/validation';
import {
  ApprovalBadge,
  DeviceOwnerBadge,
  EnforcementBadge,
} from './StatusBadges';

interface PolicyTabProps {
  devices: MergedDeviceRecord[];
  selectedUid: string | null;
  onSelectUid: (uid: string) => void;
  onSavePolicy: (
    uid: string,
    payload: {
      block_tethering: boolean;
      blocked_apps: string[];
      expectedCurrentRevision: number | null;
      allowRepairCorrupted?: boolean;
    }
  ) => Promise<{ savedRevision: number }>;
}

export const PolicyTab: React.FC<PolicyTabProps> = ({
  devices,
  selectedUid,
  onSelectUid,
  onSavePolicy,
}) => {
  const [customUidInput, setCustomUidInput] = useState('');
  const activeUid = selectedUid || (devices.length > 0 ? devices[0].uid : '');
  const activeDevice = devices.find((d) => d.uid === activeUid) || null;

  // Track which revision was loaded into the form so we detect concurrent admin edits
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const [blockTethering, setBlockTethering] = useState<boolean>(false);
  const [blockedApps, setBlockedApps] = useState<string[]>([]);
  const [isDirty, setIsDirty] = useState<boolean>(false);

  // If the stored policy document in Firestore is corrupted/invalid, block derived saves
  // until the admin explicitly chooses to repair and replace the corrupted fields.
  const [repairModeEnabled, setRepairModeEnabled] = useState<boolean>(false);

  const [newPkgInput, setNewPkgInput] = useState('');
  const [pkgError, setPkgError] = useState<string | null>(null);
  const [pkgWarning, setPkgWarning] = useState<string | null>(null);

  // Explicit initial creation mode if policy does not exist yet
  const [initiatingFirstPolicy, setInitiatingFirstPolicy] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveBanner, setSaveBanner] = useState<{
    type: 'saved_pending' | 'error';
    message: string;
    revision?: number;
  } | null>(null);

  // Sync local form state when switching device UID
  useEffect(() => {
    setSaveBanner(null);
    setPkgError(null);
    setPkgWarning(null);
    setNewPkgInput('');
    setIsDirty(false);
    setRepairModeEnabled(false);

    if (activeDevice?.policy) {
      setLoadedRevision(activeDevice.policy.revision);
      setBlockTethering(activeDevice.policy.block_tethering);
      setBlockedApps([...activeDevice.policy.blocked_apps]);
      setInitiatingFirstPolicy(false);
    } else {
      setLoadedRevision(null);
      setBlockTethering(false);
      setBlockedApps([]);
      setInitiatingFirstPolicy(false);
    }
  }, [activeUid]);

  // If the server policy changes while the user has NOT made unsaved edits, sync automatically
  useEffect(() => {
    if (!isDirty) {
      if (activeDevice?.policy) {
        setLoadedRevision(activeDevice.policy.revision);
        setBlockTethering(activeDevice.policy.block_tethering);
        setBlockedApps([...activeDevice.policy.blocked_apps]);
      } else {
        setLoadedRevision(null);
      }
    }
  }, [
    isDirty,
    activeDevice?.policy?.revision,
    activeDevice?.policy?.block_tethering,
    activeDevice?.policy?.isCorrupted,
  ]);

  // Detect if another admin updated the policy on the server while this admin has unsaved edits
  const serverPolicyRevision = activeDevice?.policy ? activeDevice.policy.revision : null;
  const hasConcurrentRemoteChange =
    isDirty && serverPolicyRevision !== loadedRevision;

  const reloadFromLatestServerPolicy = () => {
    if (activeDevice?.policy) {
      setLoadedRevision(activeDevice.policy.revision);
      setBlockTethering(activeDevice.policy.block_tethering);
      setBlockedApps([...activeDevice.policy.blocked_apps]);
      setIsDirty(false);
      setRepairModeEnabled(false);
      setSaveBanner(null);
    } else {
      setLoadedRevision(null);
      setBlockTethering(false);
      setBlockedApps([]);
      setIsDirty(false);
    }
  };

  const handleSelectCustomUid = (e: React.FormEvent) => {
    e.preventDefault();
    const res = sanitizeManualUid(customUidInput);
    if (!res.valid) {
      setSaveBanner({ type: 'error', message: res.error || 'UID غير صالح.' });
      return;
    }
    onSelectUid(res.uid);
    setCustomUidInput('');
  };

  const handleAddPackage = (e: React.FormEvent) => {
    e.preventDefault();
    setPkgError(null);
    setPkgWarning(null);

    const validation = validatePackageName(newPkgInput, blockedApps);
    if (!validation.valid) {
      setPkgError(validation.error || 'اسم الحزمة غير صالح.');
      return;
    }

    const cleanPkg = newPkgInput.trim();
    setBlockedApps((prev) => [...prev, cleanPkg]);
    setIsDirty(true);
    setNewPkgInput('');
    if (validation.warning) {
      setPkgWarning(validation.warning);
    }
  };

  const handleRemovePackage = (pkgToRemove: string) => {
    setBlockedApps((prev) => prev.filter((p) => p !== pkgToRemove));
    setIsDirty(true);
    setPkgError(null);
  };

  const handleSave = async () => {
    if (!activeUid) return;
    setSaving(true);
    setSaveBanner(null);
    setPkgError(null);

    try {
      const { savedRevision } = await onSavePolicy(activeUid, {
        block_tethering: blockTethering,
        blocked_apps: blockedApps,
        expectedCurrentRevision: loadedRevision,
        allowRepairCorrupted: repairModeEnabled,
      });
      setLoadedRevision(savedRevision);
      setIsDirty(false);
      setRepairModeEnabled(false);
      setInitiatingFirstPolicy(false);
      setSaveBanner({
        type: 'saved_pending',
        revision: savedRevision,
        message: `تم حفظ السياسة، بانتظار تطبيق الجهاز (الإصدار المحفوظ: ${savedRevision}).`,
      });
    } catch (err) {
      setSaveBanner({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const isPolicyCorruptedOnServer = Boolean(activeDevice?.policy?.isCorrupted);
  const canEditAndSave = !isPolicyCorruptedOnServer || repairModeEnabled;

  const nextExpectedRevision = activeDevice
    ? Math.max(
        activeDevice.policy && activeDevice.policy.revision > 0
          ? activeDevice.policy.revision
          : 0,
        activeDevice.status?.applied_revision ?? 0
      ) + 1
    : 1;

  return (
    <div className="space-y-6">
      {/* Device Selector Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex-1 space-y-1.5">
          <label className="block text-xs font-bold text-slate-800">
            اختر الجهاز لإدارة عقد السياسة (<code className="font-mono">policies/{'{uid}'}</code>)
          </label>
          <select
            value={activeUid}
            onChange={(e) => onSelectUid(e.target.value)}
            className="w-full max-w-xl px-3.5 py-2 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-600"
          >
            {devices.length === 0 ? (
              <option value="">لا توجد أجهزة مسجلة — أدخل UID يدويًا</option>
            ) : (
              devices.map((d) => (
                <option key={d.uid} value={d.uid}>
                  {d.metadata?.device_name || d.status?.model || 'جهاز بدون اسم'} —{' '}
                  {d.metadata?.rep_name ? `المندوب: ${d.metadata.rep_name} — ` : ''}
                  UID: {d.uid}{' '}
                  {d.policy
                    ? d.policy.isCorrupted
                      ? '(سياسة تالفة تحتاج تصحيح!)'
                      : `(السياسة الحالية: v${d.policy.revision})`
                    : '(بدون سياسة)'}
                </option>
              ))
            )}
            {activeUid && !devices.some((d) => d.uid === activeUid) && (
              <option value={activeUid}>UID مخصص: {activeUid}</option>
            )}
          </select>
        </div>

        <form onSubmit={handleSelectCustomUid} className="flex items-end gap-2">
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
              أو انتقل إلى UID محدد:
            </label>
            <input
              dir="ltr"
              type="text"
              value={customUidInput}
              onChange={(e) => setCustomUidInput(e.target.value)}
              placeholder="Device UID..."
              className="px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
          <button
            type="submit"
            className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            فتح الجهاز
          </button>
        </form>
      </div>

      {/* Concurrent Modification Conflict Banner */}
      {hasConcurrentRemoteChange && (
        <div className="p-4 bg-amber-50 border border-amber-300 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs text-amber-950">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold">
                تنبيه تعارض تعديل: تغيّرت سياسة هذا الجهاز في الخادم بواسطة مسؤول آخر!
              </p>
              <p>
                الإصدار الذي فتحته للتعديل كان{' '}
                <code className="font-mono font-bold">
                  {loadedRevision !== null ? `v${loadedRevision}` : 'غير موجود'}
                </code>{' '}
                بينما الإصدار الحالي في الخادم أصبح{' '}
                <code className="font-mono font-bold">
                  {serverPolicyRevision !== null ? `v${serverPolicyRevision}` : 'غير موجود'}
                </code>
                . لمنع استبدال تعديلات المسؤول الآخر بصمت، تم إيقاف الحفظ حتى تُعيد تحميل أحدث إصدار.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={reloadFromLatestServerPolicy}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-amber-700 hover:bg-amber-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>تحميل أحدث إصدار من الخادم</span>
          </button>
        </div>
      )}

      {/* Corrupted Policy Protection Banner */}
      {isPolicyCorruptedOnServer && activeDevice?.policy && (
        <div className="p-5 bg-red-50 border border-red-300 rounded-xl space-y-3 text-xs text-red-950">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h4 className="text-sm font-bold text-red-900">
                  تحذير: مستند السياسة الحالي في الخادم تالف أو مخالف لعقد Policy.java
                </h4>
                <p className="leading-relaxed">
                  حفاظًا على سلامة البيانات، لم تقم اللوحة باستبدال{' '}
                  <code className="font-mono">schema_version</code> أو تصفير{' '}
                  <code className="font-mono">blocked_apps</code> بصمت، وتم قفل الحفظ التلقائي حتى
                  تراجع البيانات الخام وتبدأ وضع التصحيح الصريح.
                </p>
              </div>
            </div>
            {!repairModeEnabled && (
              <button
                type="button"
                onClick={() => {
                  setBlockTethering(
                    typeof activeDevice.policy?.rawData?.block_tethering === 'boolean'
                      ? (activeDevice.policy.rawData.block_tethering as boolean)
                      : false
                  );
                  setBlockedApps(
                    (activeDevice.policy?.blocked_apps || []).filter(
                      (pkg) => validatePackageName(pkg).valid
                    )
                  );
                  setRepairModeEnabled(true);
                  setIsDirty(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-red-700 hover:bg-red-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Wrench className="w-3.5 h-3.5" />
                <span>بدء تصحيح السياسة التالفة</span>
              </button>
            )}
          </div>

          <ul className="list-disc list-inside space-y-1 text-red-900 font-medium">
            {(activeDevice.policy.corruptionErrors || []).map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>

          <div>
            <span className="block font-semibold text-red-900 mb-1">
              البيانات الخام المخزنة حاليًا في الخادم (Raw Document):
            </span>
            <pre
              dir="ltr"
              className="p-3 bg-slate-900 text-red-200 rounded-lg text-[11px] font-mono overflow-x-auto"
            >
              {JSON.stringify(activeDevice.policy.rawData, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Save Status Notification Banner */}
      {saveBanner && (
        <div
          className={`p-4 rounded-xl border text-xs flex items-start gap-3 ${
            saveBanner.type === 'saved_pending'
              ? 'bg-blue-50 border-blue-200 text-blue-950'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          {saveBanner.type === 'saved_pending' ? (
            <Clock className="w-5 h-5 text-blue-700 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          )}
          <div className="space-y-1">
            <p className="font-bold text-sm">{saveBanner.message}</p>
            {saveBanner.type === 'saved_pending' && (
              <p className="text-blue-900 leading-relaxed">
                لا يوجد أمر دفع فوري (FCM) في نسخة الوكيل الحالية (<code className="font-mono">0.1.0-pilot</code>).
                سيقوم الهاتف بتطبيق الإصدار {saveBanner.revision} وإرسال تأكيد{' '}
                <code className="font-mono">deviceStatus</code> عند فتح شاشة التطبيق على الهاتف
                أو في دورة <code className="font-mono">WorkManager</code> القادمة (كل 15 دقيقة كحد
                أدنى).
              </p>
            )}
          </div>
        </div>
      )}

      {!activeUid ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-xs text-slate-500">
          اختر جهازًا من القائمة أو أدخل معرّف UID لعرض أو إنشاء سياسته.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Right Column (in RTL): Policy Editor */}
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-blue-700" />
                  <span>عقد السياسة المطلوب: policies/{activeUid}</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  تُحفظ السياسة كاملة داخل Transaction مع كشف التعارض وزيادة{' '}
                  <code className="font-mono">revision</code> تلقائيًا.
                </p>
              </div>
              {activeDevice && <EnforcementBadge state={activeDevice.enforcementState} />}
            </div>

            {/* If no policy exists yet, require explicit action to create the first policy */}
            {!activeDevice?.policy && !initiatingFirstPolicy ? (
              <div className="p-8 bg-slate-50 border border-slate-200 rounded-xl text-center space-y-4">
                <FilePlus2 className="w-10 h-10 text-blue-700 mx-auto" />
                <div className="space-y-1.5 max-w-md mx-auto">
                  <h4 className="text-sm font-bold text-slate-900">
                    لا توجد سياسة منشأة لهذا الجهاز حتى الآن
                  </h4>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    التزامًا بضوابط الأمان، لا تكتب اللوحة سياسة تلقائيًا بمجرد فتح الصفحة. لبدء
                    إدارة قيود هذا الجهاز، اضغط الزر أدناه لتهيئة السياسة الأولى (الإصدار{' '}
                    <code className="font-mono">{nextExpectedRevision}</code>) ومراجعتها قبل الحفظ.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setLoadedRevision(null);
                    setBlockTethering(false);
                    setBlockedApps([]);
                    setInitiatingFirstPolicy(true);
                  }}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
                >
                  <FilePlus2 className="w-4 h-4" />
                  <span>إعداد وإنشاء السياسة الأولى للجهاز</span>
                </button>
              </div>
            ) : (
              <>
                {/* Contract Metadata Strip */}
                <div className="grid grid-cols-3 gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                  <div>
                    <span className="text-slate-500 block text-[11px]">schema_version</span>
                    <span
                      className={`font-mono font-bold tabular-nums ${
                        activeDevice?.policy && activeDevice.policy.schema_version !== 1
                          ? 'text-red-700'
                          : 'text-slate-900'
                      }`}
                    >
                      {activeDevice?.policy && !repairModeEnabled
                        ? `${JSON.stringify(activeDevice.policy.rawData?.schema_version)}`
                        : '1 (ثابت)'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[11px]">الإصدار المحمّل</span>
                    <span className="font-mono font-bold text-slate-900 tabular-nums">
                      {loadedRevision !== null ? `v${loadedRevision}` : 'لم يُحفظ بعد'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[11px]">الإصدار عند الحفظ القادم</span>
                    <span className="font-mono font-bold text-blue-700 tabular-nums">
                      v{nextExpectedRevision}
                    </span>
                  </div>
                </div>

                {/* 1. Block Tethering Toggle */}
                <div className="p-4 border border-slate-200 rounded-xl space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <span className="text-sm font-bold text-slate-900 block">
                        منع مشاركة الإنترنت (block_tethering)
                      </span>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        يفرض القيد الرسمي{' '}
                        <code className="font-mono">UserManager.DISALLOW_CONFIG_TETHERING</code>{' '}
                        لمنع نقطة الاتصال (Hotspot) ومشاركة الإنترنت عبر USB والبلوتوث، مع إبقاء
                        البلوتوث العادي للطابعات والمكالمات وتطبيق المبيعات دون تقييد.
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={!canEditAndSave}
                      onClick={() => {
                        setBlockTethering((prev) => !prev);
                        setIsDirty(true);
                      }}
                      className={`px-4 py-2 text-xs font-bold rounded-lg border transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 ${
                        blockTethering
                          ? 'bg-red-700 text-white border-red-800'
                          : 'bg-slate-100 text-slate-800 border-slate-300 hover:bg-slate-200'
                      }`}
                    >
                      {blockTethering
                        ? 'مفعّل: منع مشاركة الإنترنت (true)'
                        : 'ملغى: السماح بمشاركة الإنترنت (false)'}
                    </button>
                  </div>

                  <div className="text-[11px] text-slate-500 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                    <strong>طريقة إلغاء الحظر:</strong> لإلغاء منع مشاركة الإنترنت، اجعل القيمة{' '}
                    <code className="font-mono">block_tethering = false</code> واحفظ السياسة ليرتفع
                    رقم الإصدار (<code className="font-mono">revision: {nextExpectedRevision}</code>
                    ). لا يُحذف مستند السياسة أبدًا لأن حذف المستند لا يفك القيد عن الهاتف.
                  </div>
                </div>

                {/* 2. Blocked Apps Array Manager */}
                <div className="p-4 border border-slate-200 rounded-xl space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h4 className="text-sm font-bold text-slate-900">
                        قائمة التطبيقات المحظورة (blocked_apps)
                      </h4>
                      <p className="text-xs text-slate-600 mt-0.5">
                        يخفي الوكيل التطبيقات المحددة عبر{' '}
                        <code className="font-mono">setApplicationHidden</code>. لإعادة إظهار تطبيق،
                        احذف اسم حزمته من القائمة واحفظ السياسة بإصدار أحدث.
                      </p>
                    </div>
                    <span className="font-mono text-xs font-semibold text-slate-600 tabular-nums shrink-0">
                      {blockedApps.length} / {MAX_BLOCKED_APPS}
                    </span>
                  </div>

                  {/* Honest note that agent does not send installed apps inventory */}
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-2.5 text-[11px] text-slate-700 leading-relaxed">
                    <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
                    <div>
                      <strong>ملاحظة حول قائمة التطبيقات المثبتة:</strong> وكيل Android الحالي (
                      <code className="font-mono">0.1.0-pilot</code>) لا يرسل قائمة بالتطبيقات
                      المثبتة على الهاتف؛ لذا تُدار القائمة بإدخال أسماء الحزم (
                      <code className="font-mono">package names</code>) مباشرة. وتتحقق قواعد{' '}
                      <code className="font-mono">firestore.rules</code> من صحة جميع الحزم (حتى 50
                      عنصرًا).
                    </div>
                  </div>

                  {/* Add Package Form */}
                  <form onSubmit={handleAddPackage} className="flex flex-col sm:flex-row gap-2">
                    <input
                      dir="ltr"
                      type="text"
                      disabled={!canEditAndSave}
                      value={newPkgInput}
                      onChange={(e) => {
                        setNewPkgInput(e.target.value);
                        if (pkgError) setPkgError(null);
                      }}
                      placeholder="com.example.app"
                      className="flex-1 px-3.5 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 disabled:bg-slate-100"
                    />
                    <button
                      type="submit"
                      disabled={!canEditAndSave}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                    >
                      <Plus className="w-4 h-4" />
                      <span>إضافة حزمة للحظر</span>
                    </button>
                  </form>

                  {pkgError && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 font-medium">
                      {pkgError}
                    </div>
                  )}

                  {pkgWarning && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
                      {pkgWarning}
                    </div>
                  )}

                  {/* Current Blocked Packages List */}
                  {blockedApps.length === 0 ? (
                    <div className="p-4 text-center border border-dashed border-slate-300 rounded-lg text-xs text-slate-500">
                      المصفوفة فارغة (<code className="font-mono">blocked_apps: []</code>) — سيقوم
                      الوكيل بإعادة إظهار أي تطبيقات كان قد أخفاها سابقًا.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden">
                      {blockedApps.map((pkg, idx) => (
                        <div
                          key={`${pkg}-${idx}`}
                          className="px-3.5 py-2.5 bg-white flex items-center justify-between gap-3 hover:bg-slate-50"
                        >
                          <code dir="ltr" className="text-xs font-mono font-semibold text-slate-900">
                            {pkg}
                          </code>
                          <button
                            type="button"
                            disabled={!canEditAndSave}
                            onClick={() => handleRemovePackage(pkg)}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-900 disabled:opacity-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>إزالة الحظر</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Protected Packages Reference */}
                  <details className="text-xs text-slate-600">
                    <summary className="cursor-pointer font-semibold text-slate-700 hover:text-slate-900">
                      عرض قائمة الحزم المحمية الممنوع حظرها في AppRestrictions.java و firestore.rules
                    </summary>
                    <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
                      {Object.entries(HARDCODED_PROTECTED_PACKAGES).map(([pkg, desc]) => (
                        <div
                          key={pkg}
                          className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[11px]"
                        >
                          <code dir="ltr" className="font-mono font-semibold text-slate-800">
                            {pkg}
                          </code>
                          <span className="text-slate-600">{desc}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>

                {/* JSON Preview & Transaction Save Button */}
                <div className="space-y-3 pt-2">
                  <div
                    className="p-3 bg-slate-900 text-slate-100 rounded-lg text-[11px] font-mono overflow-x-auto"
                    dir="ltr"
                  >
                    {JSON.stringify(
                      {
                        schema_version: 1,
                        revision: nextExpectedRevision,
                        block_tethering: blockTethering,
                        blocked_apps: blockedApps,
                      },
                      null,
                      2
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <span className="text-xs text-slate-500">
                      تطبيق الإدارة المحمي: <code className="font-mono">{MDM_AGENT_PACKAGE_NAME}</code>
                    </span>
                    <button
                      type="button"
                      disabled={saving || !canEditAndSave || hasConcurrentRemoteChange}
                      onClick={() => void handleSave()}
                      className="inline-flex items-center gap-2 px-6 py-2.5 text-xs font-bold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <Save className="w-4 h-4" />
                      <span>
                        {saving
                          ? 'جارٍ تنفيذ Transaction...'
                          : !canEditAndSave
                          ? 'يجب تفعيل وضع تصحيح السياسة التالفة أولًا'
                          : activeDevice?.policy
                          ? `حفظ السياسة ورفع الإصدار إلى (v${nextExpectedRevision})`
                          : `إنشاء وحفظ السياسة الأولى (v${nextExpectedRevision})`}
                      </span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Left Column (in RTL): Live Verification & Device Status Comparison */}
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                حالة التحقق والتنفيذ الفعلية من الهاتف (
                <code className="font-mono">deviceStatus/{activeUid}</code>)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                لا تُعتبر السياسة مطبّقة إلا بتطابق الإصدار المبلّغ عنه مع المطلوب وعدم وجود خطأ.
              </p>
            </div>

            {activeDevice ? (
              <div className="space-y-4 text-xs">
                <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="font-semibold text-slate-700">حالة اعتماد الجهاز</span>
                  <ApprovalBadge state={activeDevice.approvalState} />
                </div>

                <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="font-semibold text-slate-700">صلاحية Device Owner</span>
                  <DeviceOwnerBadge isOwner={activeDevice.status?.device_owner} />
                </div>

                <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="font-semibold text-slate-700">نتيجة تطبيق السياسة</span>
                  <EnforcementBadge state={activeDevice.enforcementState} />
                </div>

                {/* Comparison Grid */}
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="grid grid-cols-3 bg-slate-100 px-3 py-2 font-semibold text-slate-700 text-[11px]">
                    <span>البند</span>
                    <span>المطلوب (policies)</span>
                    <span>المبلّغ عنه (deviceStatus)</span>
                  </div>
                  <div className="divide-y divide-slate-200 text-[11px]">
                    <div className="grid grid-cols-3 px-3 py-2.5 items-center">
                      <span className="font-medium text-slate-700">رقم الإصدار</span>
                      <span className="font-mono font-bold text-slate-900">
                        {activeDevice.policy ? `v${activeDevice.policy.revision}` : '—'}
                      </span>
                      <span className="font-mono font-bold text-slate-900">
                        {activeDevice.status ? `v${activeDevice.status.applied_revision}` : '—'}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 px-3 py-2.5 items-center">
                      <span className="font-medium text-slate-700">منع مشاركة الإنترنت</span>
                      <span className="font-semibold text-slate-900">
                        {activeDevice.policy
                          ? activeDevice.policy.isCorrupted
                            ? 'بيانات تالفة'
                            : activeDevice.policy.block_tethering
                            ? 'مطلوب المنع (true)'
                            : 'مسموح (false)'
                          : '—'}
                      </span>
                      <span
                        className={`font-semibold ${
                          activeDevice.status?.tethering_restricted
                            ? 'text-emerald-800'
                            : 'text-slate-700'
                        }`}
                      >
                        {activeDevice.status
                          ? activeDevice.status.tethering_restricted
                            ? 'ممنوع فعليًا (true)'
                            : 'غير ممنوع (false)'
                          : '—'}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 px-3 py-2.5 items-center">
                      <span className="font-medium text-slate-700">آخر اتصال</span>
                      <span className="text-slate-400">دوري (15 د+)</span>
                      <span className="font-mono text-slate-800">
                        {formatTimestampAr(activeDevice.lastSeenMs).relative}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Detailed Diagnosis Box */}
                <div
                  className={`p-3.5 rounded-lg border leading-relaxed ${
                    activeDevice.enforcementState === 'applied'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : activeDevice.enforcementState === 'error' ||
                        activeDevice.enforcementState === 'corrupted_policy'
                      ? 'bg-red-50 border-red-200 text-red-900'
                      : 'bg-blue-50 border-blue-200 text-blue-900'
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold mb-1">
                    {activeDevice.enforcementState === 'applied' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                    ) : activeDevice.enforcementState === 'error' ||
                      activeDevice.enforcementState === 'corrupted_policy' ? (
                      <ShieldAlert className="w-4 h-4 text-red-700 shrink-0" />
                    ) : (
                      <Clock className="w-4 h-4 text-blue-700 shrink-0" />
                    )}
                    <span>تشخيص حالة التنفيذ</span>
                  </div>
                  <p className="text-xs">{activeDevice.enforcementDetail}</p>
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-500">
                لم يتم العثور على سجلات سابقة لهذا المعرّف في قاعدة البيانات.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
