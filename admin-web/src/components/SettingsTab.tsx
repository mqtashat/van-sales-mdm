import React, { useState, useEffect } from 'react';
import type { Firestore } from 'firebase/firestore';
import {
  MergedDeviceRecord,
  AdminIdentity,
} from '../types/mdm';
import {
  CURATED_APP_CATALOG,
  lookupAppInfo,
} from '../utils/appCatalog';
import {
  HARDCODED_PROTECTED_PACKAGES,
  PROTECTED_PACKAGES,
  validatePackageName,
} from '../utils/validation';
import { saveDevicePolicyTransaction } from '../services/mdmService';
import { resolveFirebaseConfig } from '../services/firebaseClient';
import { getDeviceFriendlyName } from '../utils/presentation';
import { DocsAndSecurityTab } from './DocsAndSecurityTab';
import { FirebaseSetupView } from './FirebaseSetupView';
import {
  Sliders,
  Shield,
  Lock,
  Plus,
  CheckCircle2,
  AlertCircle,
  Send,
  X,
  Download,
  Smartphone,
  Terminal,
  Copy,
  Check,
  Code2,
  Database,
} from 'lucide-react';

interface SettingsTabProps {
  devices: MergedDeviceRecord[];
  db: Firestore;
  actor: AdminIdentity;
  initialSection?: 'general' | 'advanced';
  onConfigSaved?: () => void;
}

const DEFAULT_TEMPLATE_STORAGE_KEY = 'vansales_mdm_default_policy_template_v1';

interface DefaultPolicyTemplate {
  block_tethering: boolean;
  blocked_apps: string[];
}

function loadDefaultTemplate(): DefaultPolicyTemplate {
  try {
    const raw = localStorage.getItem(DEFAULT_TEMPLATE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        block_tethering:
          typeof parsed.block_tethering === 'boolean' ? parsed.block_tethering : true,
        blocked_apps: Array.isArray(parsed.blocked_apps)
          ? parsed.blocked_apps.filter((x: unknown) => typeof x === 'string')
          : [],
      };
    }
  } catch {
    // ignore
  }
  return {
    block_tethering: true,
    blocked_apps: [
      'com.zhiliaoapp.musically',
      'com.ss.android.ugc.trill',
      'com.snapchat.android',
      'com.instagram.android',
      'com.facebook.katana',
      'com.tencent.ig',
      'com.dts.freefireth',
    ],
  };
}

const ADB_PROVISION_CMD =
  'adb shell dpm set-device-owner com.company.mdmagent/.admin.MdmDeviceAdminReceiver';

export const SettingsTab: React.FC<SettingsTabProps> = ({
  devices,
  db,
  actor,
  initialSection = 'general',
  onConfigSaved,
}) => {
  const [activeSection, setActiveSection] = useState<'general' | 'advanced'>(initialSection);

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  const [template, setTemplate] = useState<DefaultPolicyTemplate>(loadDefaultTemplate);
  const [customPkg, setCustomPkg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [copiedAdb, setCopiedAdb] = useState(false);

  // Modal for applying template to devices
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const handleCopyAdb = () => {
    navigator.clipboard.writeText(ADB_PROVISION_CMD);
    setCopiedAdb(true);
    setTimeout(() => setCopiedAdb(false), 2000);
  };

  const approvedDevices = devices.filter((d) => d.approvalState === 'approved');

  const saveTemplateLocally = (next: DefaultPolicyTemplate) => {
    setTemplate(next);
    try {
      localStorage.setItem(DEFAULT_TEMPLATE_STORAGE_KEY, JSON.stringify(next));
      setSavedNotice('تم حفظ القالب الافتراضي.');
      setTimeout(() => setSavedNotice(null), 3000);
    } catch {
      // ignore
    }
  };

  const toggleSuggestedApp = (pkg: string) => {
    setError(null);
    const exists = template.blocked_apps.includes(pkg);
    const nextBlocked = exists
      ? template.blocked_apps.filter((p) => p !== pkg)
      : [...template.blocked_apps, pkg];
    saveTemplateLocally({ ...template, blocked_apps: nextBlocked });
  };

  const handleAddCustom = () => {
    setError(null);
    const trimmed = customPkg.trim();
    if (!trimmed) return;
    const check = validatePackageName(trimmed, template.blocked_apps);
    if (!check.valid) {
      setError(check.error || 'معرف الحزمة غير صالح');
      return;
    }
    saveTemplateLocally({
      ...template,
      blocked_apps: [...template.blocked_apps, trimmed],
    });
    setCustomPkg('');
  };

  const handleOpenApplyModal = () => {
    setError(null);
    setSelectedUids(new Set(approvedDevices.map((d) => d.uid)));
    setShowApplyModal(true);
  };

  const handleConfirmApply = async () => {
    if (selectedUids.size === 0) return;
    setApplying(true);
    setError(null);
    try {
      const targets = devices.filter((d) => selectedUids.has(d.uid));
      let updatedCount = 0;
      for (const dev of targets) {
        if (dev.approvalState !== 'approved') continue;
        await saveDevicePolicyTransaction(
          db,
          dev.uid,
          {
            block_tethering: template.block_tethering,
            blocked_apps: template.blocked_apps,
            expectedCurrentRevision: dev.policy ? dev.policy.revision : null,
          },
          actor
        );
        updatedCount++;
      }
      setShowApplyModal(false);
      setSavedNotice(
        `تم تطبيق القالب الافتراضي بالخادم على (${updatedCount}) جهاز بنجاح، وبانتظار تأكيد الهواتف.`
      );
    } catch (err: any) {
      setError(err?.message || 'فشل تطبيق القالب');
    } finally {
      setApplying(false);
    }
  };

  const resolution = resolveFirebaseConfig();

  return (
    <div className="space-y-6" dir="rtl">
      {/* Top Section Switcher: General Settings vs Advanced Settings */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">إعدادات النظام</h2>
          <p className="text-xs text-slate-600 mt-0.5">
            إدارة القالب الافتراضي للسياسات، تجهيز الهواتف الجديدة، والإعدادات المتقدمة للخادم وقواعد الأمان.
          </p>
        </div>

        <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setActiveSection('general')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
              activeSection === 'general'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>الإعدادات العامة</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('advanced')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
              activeSection === 'advanced'
                ? 'bg-slate-900 text-white shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Code2 className="w-4 h-4" />
            <span>الإعدادات المتقدمة وقواعد الأمان</span>
          </button>
        </div>
      </div>

      {activeSection === 'general' ? (
        <div className="space-y-6">
          {/* Default Policy Template Card */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Sliders className="w-5 h-5 text-blue-600" />
                  <span>قالب السياسة الافتراضية لأجهزة المندوبين</span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  جهّز قائمة الحظر القياسية وإعداد مشاركة الإنترنت، ثم طبّقها دفعة واحدة على الأجهزة المعتمدة.
                </p>
              </div>
              <button
                type="button"
                onClick={handleOpenApplyModal}
                disabled={approvedDevices.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-xs self-start sm:self-auto cursor-pointer"
              >
                <Send className="w-4 h-4" />
                <span>تطبيق القالب على الأجهزة...</span>
              </button>
            </div>

            {savedNotice && (
              <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2 font-semibold">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{savedNotice}</span>
              </div>
            )}

            {error && (
              <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Default Tethering Switch */}
            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-bold text-slate-900">
                  الوضع الافتراضي لمشاركة الإنترنت ونقطة الاتصال
                </div>
                <p className="text-xs text-slate-600 mt-0.5">
                  منع فتح نقطة الاتصال اللاسلكية (Hotspot) ومشاركة بيانات شريحة العمل.
                </p>
              </div>
              <div className="flex items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  role="switch"
                  aria-checked={template.block_tethering}
                  onClick={() =>
                    saveTemplateLocally({
                      ...template,
                      block_tethering: !template.block_tethering,
                    })
                  }
                  className={`relative inline-flex h-7 w-13 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                    template.block_tethering ? 'bg-blue-600' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                      template.block_tethering ? '-translate-x-6' : 'translate-x-0'
                    }`}
                  />
                </button>
                <span className="text-xs font-bold text-slate-800">
                  {template.block_tethering ? 'ممنوعة افتراضياً' : 'مسموحة افتراضياً'}
                </span>
              </div>
            </div>

            {/* Default Blocked Apps Selection */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-slate-700">
                التطبيقات المحظورة ضمن القالب الافتراضي ({template.blocked_apps.length})
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {CURATED_APP_CATALOG.filter(
                  (a) => !HARDCODED_PROTECTED_PACKAGES[a.packageName] && !a.isProtected
                ).map((item) => {
                  const isBlocked = template.blocked_apps.includes(item.packageName);
                  return (
                    <button
                      key={item.packageName}
                      type="button"
                      onClick={() => toggleSuggestedApp(item.packageName)}
                      className={`p-3 rounded-xl border text-right transition-all flex items-center justify-between gap-2 cursor-pointer ${
                        isBlocked
                          ? 'bg-red-50/70 border-red-300 text-red-950'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold truncate">{item.nameAr}</div>
                        <div className="text-[11px] text-slate-500">{item.nameEn}</div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-bold shrink-0 ${
                          isBlocked
                            ? 'bg-red-600 text-white'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {isBlocked ? 'محظور بالقالب' : 'غير محظور'}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Add custom package to template */}
              <div className="pt-2 flex flex-col sm:flex-row gap-2 max-w-xl">
                <input
                  type="text"
                  dir="ltr"
                  value={customPkg}
                  onChange={(e) => setCustomPkg(e.target.value)}
                  placeholder="إضافة معرف حزمة مخصص للقالب (مثال: com.example.game)"
                  className="flex-1 px-3.5 py-2 text-xs font-mono rounded-lg border border-slate-300 focus:border-blue-600 outline-hidden"
                />
                <button
                  type="button"
                  onClick={handleAddCustom}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>إضافة للقالب</span>
                </button>
              </div>
            </div>
          </div>

          {/* Protected System Apps Reference */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs space-y-4">
            <div className="flex items-center gap-2.5">
              <Shield className="w-5 h-5 text-blue-600" />
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  التطبيقات الأساسية المحمية من الحظر ({PROTECTED_PACKAGES.length})
                </h3>
                <p className="text-xs text-slate-500">
                  هذه الحزم ضرورية لعمل نظام أندرويد وتطبيق الحماية، ويمنع النظام حظرها لضمان عدم تعطل الهاتف.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {PROTECTED_PACKAGES.map((pkg) => {
                const info = lookupAppInfo(pkg);
                return (
                  <div
                    key={pkg}
                    className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-start gap-2.5"
                  >
                    <Lock className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-900">{info.nameAr}</div>
                      <p className="text-[11px] text-slate-600 mt-0.5 leading-relaxed">
                        {HARDCODED_PROTECTED_PACKAGES[pkg]}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Android Agent Setup Guide */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    تجهيز هاتف مندوب جديد وتثبيت تطبيق الحماية
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    خطوات تفعيل صلاحية إدارة الشركة (Device Owner) على الهواتف الجديدة قبل تسليمها للمندوبين.
                  </p>
                </div>
              </div>
              <a
                href="/mdm/agent.apk"
                download="vansales-mdm-agent.apk"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 transition-colors self-start sm:self-auto"
              >
                <Download className="w-4 h-4" />
                <span>تحميل ملف APK</span>
              </a>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                <div className="font-bold text-slate-900">خطوات التجهيز الأولي:</div>
                <ol className="list-decimal list-inside space-y-1.5 text-slate-700 leading-relaxed">
                  <li>أفرمت الهاتف أو أزل جميع الحسابات المسجلة عليه مؤقتاً.</li>
                  <li>ثبّت تطبيق الحماية (APK) على الهاتف، وفعّل تصحيح USB من خيارات المطور.</li>
                  <li>وصّل الهاتف بالكمبيوتر ونفّذ أمر التفعيل المقابل، ثم افتح التطبيق واعتمد الجهاز من هذه اللوحة.</li>
                </ol>
              </div>

              <div className="p-4 rounded-xl bg-slate-900 text-slate-100 space-y-2 flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300 font-bold flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                    <span>أمر تفعيل Device Owner عبر ADB</span>
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyAdb}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold cursor-pointer"
                  >
                    {copiedAdb ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span>تم النسخ</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>نسخ الأمر</span>
                      </>
                    )}
                  </button>
                </div>
                <pre
                  dir="ltr"
                  className="p-2.5 rounded bg-slate-950 text-emerald-300 font-mono text-[11px] overflow-x-auto"
                >
                  {ADB_PROVISION_CMD}
                </pre>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ADVANCED SETTINGS SECTION (الإعدادات المتقدمة وقواعد الأمان) */
        <div className="space-y-6">
          <DocsAndSecurityTab />

          <details className="bg-white rounded-xl border border-slate-200 shadow-xs group">
            <summary className="px-6 py-4 flex items-center justify-between cursor-pointer list-none select-none">
              <div className="flex items-center gap-2.5">
                <Database className="w-5 h-5 text-slate-700" />
                <div>
                  <span className="text-sm font-bold text-slate-900 block">
                    إعدادات اتصال Firebase Web (للمسؤول التقني)
                  </span>
                  <span className="text-xs text-slate-500">
                    مراجعة أو تحديث مفاتيح ربط الواجهة بمشروع Firebase
                  </span>
                </div>
              </div>
              <span className="text-xs font-bold text-blue-600 group-open:rotate-180 transition-transform">
                ▼
              </span>
            </summary>
            <div className="p-6 border-t border-slate-100">
              <FirebaseSetupView
                resolution={resolution}
                onConfigSaved={onConfigSaved || (() => {})}
                onNavigateDocs={() => setActiveSection('advanced')}
              />
            </div>
          </details>
        </div>
      )}

      {/* Apply Default Template Modal */}
      {showApplyModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs"
          dir="rtl"
        >
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  تطبيق القالب الافتراضي على الأجهزة
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  سيتم حفظ إعدادات القالب بالخادم للأجهزة المختارة.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowApplyModal(false)}
                className="p-2 rounded-lg text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1">
                <div>
                  <span className="text-slate-500">مشاركة الإنترنت: </span>
                  <span className="font-bold text-slate-900">
                    {template.block_tethering ? 'ممنوعة' : 'مسموحة'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">عدد التطبيقات المحظورة بالقالب: </span>
                  <span className="font-bold text-slate-900">
                    {template.blocked_apps.length} تطبيق
                  </span>
                </div>
              </div>

              <div className="divide-y divide-slate-200 border border-slate-200 rounded-xl max-h-52 overflow-y-auto">
                {approvedDevices.map((d) => {
                  const checked = selectedUids.has(d.uid);
                  const friendlyName = getDeviceFriendlyName(d);
                  return (
                    <label
                      key={d.uid}
                      className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 cursor-pointer text-xs"
                    >
                      <div className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = new Set(selectedUids);
                            if (next.has(d.uid)) next.delete(d.uid);
                            else next.add(d.uid);
                            setSelectedUids(next);
                          }}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600"
                        />
                        <span className="font-bold text-slate-900">
                          {friendlyName}
                        </span>
                      </div>
                      <span className="text-[11px] text-slate-500">
                        المندوب: {d.metadata?.rep_name || 'غير محدد'}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowApplyModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-bold border border-slate-300 text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={applying || selectedUids.size === 0}
                onClick={() => void handleConfirmApply()}
                className="px-5 py-2 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
              >
                {applying
                  ? 'جارٍ الحفظ...'
                  : `تطبيق على (${selectedUids.size}) جهاز`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
