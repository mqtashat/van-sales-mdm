import React, { useState, useMemo } from 'react';
import type { Firestore } from 'firebase/firestore';
import {
  MergedDeviceRecord,
  AdminIdentity,
  BulkActionType,
} from '../types/mdm';
import {
  CURATED_APP_CATALOG,
  lookupAppInfo,
} from '../utils/appCatalog';
import {
  HARDCODED_PROTECTED_PACKAGES,
  validatePackageName,
} from '../utils/validation';
import { BulkActionModal } from './BulkActionModal';
import {
  Search,
  Lock,
  Ban,
  Plus,
  Copy,
  Check,
  SlidersHorizontal,
  Info,
  X,
} from 'lucide-react';
import { getDeviceFriendlyName } from '../utils/presentation';

interface FleetAppsTabProps {
  devices: MergedDeviceRecord[];
  db: Firestore;
  actor: AdminIdentity;
}

const CATEGORY_LABELS: Record<string, string> = {
  social: 'تواصل اجتماعي',
  games: 'ألعاب',
  video: 'فيديو وبث',
  browsers: 'متصفحات',
  tools: 'أدوات',
  system: 'تطبيق نظام',
  other: 'أخرى',
};

export const FleetAppsTab: React.FC<FleetAppsTabProps> = ({
  devices,
  db,
  actor,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [customPkgInput, setCustomPkgInput] = useState('');
  const [customPkgError, setCustomPkgError] = useState<string | null>(null);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [showPackageNames, setShowPackageNames] = useState(false);
  const [copiedPkg, setCopiedPkg] = useState<string | null>(null);

  // Target device picker modal for a chosen app before opening BulkActionModal
  const [activeAppModal, setActiveAppModal] = useState<{
    packageName: string;
    appName: string;
    mode: 'allow_apps' | 'block_apps';
  } | null>(null);
  const [selectedDeviceUids, setSelectedDeviceUids] = useState<Set<string>>(new Set());

  // BulkActionModal execution state
  const [bulkExecutionConfig, setBulkExecutionConfig] = useState<{
    actionType: BulkActionType;
    packages: string[];
    targetUids: string[];
  } | null>(null);

  const approvedDevices = useMemo(
    () => devices.filter((d) => d.approvalState === 'approved'),
    [devices]
  );

  // Aggregate all apps from curated catalog + any custom blocked_apps across fleet policies
  const fleetApps = useMemo(() => {
    const map = new Map<
      string,
      {
        package_name: string;
        app_name: string;
        category: string;
        categoryLabel: string;
        description: string;
        isProtected: boolean;
        protectedReason: string | null;
        blockedDeviceCount: number;
      }
    >();

    for (const item of CURATED_APP_CATALOG) {
      const isProt = Boolean(
        HARDCODED_PROTECTED_PACKAGES[item.packageName] || item.isProtected
      );
      map.set(item.packageName, {
        package_name: item.packageName,
        app_name: item.nameAr,
        category: item.category,
        categoryLabel: CATEGORY_LABELS[item.category] || item.category,
        description: item.descriptionAr,
        isProtected: isProt,
        protectedReason:
          HARDCODED_PROTECTED_PACKAGES[item.packageName] || item.protectionReason || null,
        blockedDeviceCount: 0,
      });
    }

    for (const d of devices) {
      const blocked = d.policy?.blocked_apps ?? [];
      for (const pkg of blocked) {
        if (!map.has(pkg)) {
          const info = lookupAppInfo(pkg);
          map.set(pkg, {
            package_name: pkg,
            app_name: info.nameAr,
            category: info.category,
            categoryLabel: CATEGORY_LABELS[info.category] || 'أخرى',
            description: info.descriptionAr,
            isProtected: Boolean(HARDCODED_PROTECTED_PACKAGES[pkg] || info.isProtected),
            protectedReason:
              HARDCODED_PROTECTED_PACKAGES[pkg] || info.protectionReason || null,
            blockedDeviceCount: 0,
          });
        }
      }
    }

    for (const entry of map.values()) {
      if (entry.isProtected) {
        entry.blockedDeviceCount = 0;
        continue;
      }
      let bCount = 0;
      for (const d of approvedDevices) {
        const blocked = d.policy?.blocked_apps ?? [];
        if (blocked.includes(entry.package_name)) {
          bCount++;
        }
      }
      entry.blockedDeviceCount = bCount;
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.blockedDeviceCount !== b.blockedDeviceCount) {
        return b.blockedDeviceCount - a.blockedDeviceCount;
      }
      if (a.isProtected !== b.isProtected) {
        return a.isProtected ? 1 : -1;
      }
      return a.app_name.localeCompare(b.app_name, 'ar');
    });
  }, [devices, approvedDevices]);

  const filteredApps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return fleetApps.filter((app) => {
      if (categoryFilter === 'blocked_any' && app.blockedDeviceCount === 0) return false;
      if (categoryFilter === 'protected' && !app.isProtected) return false;
      if (
        categoryFilter !== 'all' &&
        categoryFilter !== 'blocked_any' &&
        categoryFilter !== 'protected' &&
        app.category !== categoryFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        app.app_name.toLowerCase().includes(q) ||
        app.package_name.toLowerCase().includes(q) ||
        app.categoryLabel.toLowerCase().includes(q)
      );
    });
  }, [fleetApps, searchQuery, categoryFilter]);

  const openDevicePickerForApp = (
    packageName: string,
    appName: string,
    mode: 'allow_apps' | 'block_apps'
  ) => {
    const defaultSet = new Set<string>(approvedDevices.map((d) => d.uid));
    setSelectedDeviceUids(defaultSet);
    setActiveAppModal({ packageName, appName, mode });
  };

  const handleOpenCustomAppModal = () => {
    setCustomPkgError(null);
    const trimmed = customPkgInput.trim();
    const check = validatePackageName(trimmed, []);
    if (!check.valid) {
      setCustomPkgError(check.error || 'معرف الحزمة غير صالح');
      return;
    }
    const info = lookupAppInfo(trimmed);
    setCustomPkgInput('');
    setShowCustomModal(false);
    openDevicePickerForApp(trimmed, info.nameAr, 'block_apps');
  };

  const handleCopyPackage = (pkg: string) => {
    navigator.clipboard.writeText(pkg);
    setCopiedPkg(pkg);
    setTimeout(() => setCopiedPkg(null), 1800);
  };

  const handleProceedToBulkModal = () => {
    if (!activeAppModal || selectedDeviceUids.size === 0) return;
    const modalData = activeAppModal;
    const targetUids = Array.from(selectedDeviceUids);
    setActiveAppModal(null);
    setBulkExecutionConfig({
      actionType: modalData.mode,
      packages: [modalData.packageName],
      targetUids,
    });
  };

  return (
    <div className="space-y-5" dir="rtl">
      {/* Header Banner */}
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              دليل التطبيقات المقترحة والإجراءات الجماعية
            </h2>
            <p className="text-xs text-slate-600 mt-1 leading-relaxed">
              تتيح هذه الصفحة حظر أو رفع الحظر عن التطبيقات الشائعة على عدة أجهزة دفعة واحدة. لرؤية التطبيقات المثبتة فعلياً على هاتف معين، افتح صفحة الجهاز من قسم «الأجهزة».
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start lg:self-center shrink-0">
            <button
              type="button"
              onClick={() => setShowPackageNames(!showPackageNames)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>{showPackageNames ? 'إخفاء المعرفات التقنية' : 'إظهار المعرفات التقنية'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCustomModal(!showCustomModal);
                setCustomPkgError(null);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-700 transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>حظر تطبيق بمعرف الحزمة</span>
            </button>
          </div>
        </div>

        <div className="p-3 rounded-xl bg-blue-50/70 border border-blue-200/80 text-xs text-blue-950 flex items-start gap-2.5">
          <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
          <span>
            الأرقام الموضحة أدناه تعبّر عن <strong>عدد الأجهزة التي تحظر التطبيق في سياستها</strong>، ولا تعني بالضرورة أن التطبيق مثبت حالياً على بقية الهواتف.
          </span>
        </div>
      </div>

      {/* Optional Custom Package Input Panel */}
      {showCustomModal && (
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-900">
              حظر تطبيق مخصص على أجهزة مختارة عبر معرف الحزمة (Package Name)
            </h3>
            <button
              type="button"
              onClick={() => setShowCustomModal(false)}
              className="text-xs text-slate-500 hover:text-slate-800 font-bold cursor-pointer"
            >
              إغلاق
            </button>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              dir="ltr"
              value={customPkgInput}
              onChange={(e) => setCustomPkgInput(e.target.value)}
              placeholder="com.example.app"
              className="flex-1 px-3.5 py-2 text-xs font-mono rounded-lg border border-slate-300 focus:border-blue-600 outline-hidden"
            />
            <button
              type="button"
              onClick={handleOpenCustomAppModal}
              className="px-4 py-2 rounded-lg text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 cursor-pointer"
            >
              اختيار الأجهزة وتطبيق الحظر...
            </button>
          </div>
          {customPkgError && (
            <p className="text-xs text-red-600">{customPkgError}</p>
          )}
        </div>
      )}

      {/* Search & Category Filter */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث باسم التطبيق (تيك توك، يوتيوب، ببجي...)"
            className="w-full pr-10 pl-4 py-2.5 text-sm rounded-xl border border-slate-200 bg-slate-50/50 focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-500/20 outline-hidden"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[
            { id: 'all', label: `الكل (${fleetApps.length})` },
            { id: 'blocked_any', label: 'محظورة في أجهزة' },
            { id: 'social', label: 'تواصل اجتماعي' },
            { id: 'games', label: 'ألعاب' },
            { id: 'protected', label: 'محمية للنظام' },
          ].map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategoryFilter(cat.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                categoryFilter === cat.id
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* App Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filteredApps.map((app) => (
          <div
            key={app.package_name}
            className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs flex flex-col justify-between gap-3 hover:border-slate-300 transition-all"
          >
            <div className="space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold shrink-0 ${
                      app.isProtected
                        ? 'bg-blue-50 text-blue-700 border border-blue-200'
                        : app.blockedDeviceCount > 0
                        ? 'bg-red-50 text-red-700 border border-red-200'
                        : 'bg-slate-100 text-slate-700 border border-slate-200'
                    }`}
                  >
                    {app.app_name.trim().charAt(0)}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-slate-900 truncate">
                      {app.app_name}
                    </h3>
                    <span className="text-[11px] text-slate-500">
                      {app.categoryLabel}
                    </span>
                  </div>
                </div>

                {app.isProtected ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
                    <Lock className="w-3 h-3" />
                    محمي للنظام
                  </span>
                ) : app.blockedDeviceCount > 0 ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-red-100 text-red-800 border border-red-200 shrink-0">
                    <Ban className="w-3 h-3" />
                    محظور في {app.blockedDeviceCount} جهاز
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 shrink-0">
                    غير مدرج بالحظر
                  </span>
                )}
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">
                {app.description}
              </p>

              {app.isProtected && app.protectedReason && (
                <div className="p-2.5 rounded-lg bg-blue-50/70 border border-blue-200/80 text-[11px] text-blue-900">
                  {app.protectedReason}
                </div>
              )}

              {/* Optional / Collapsible Package Name */}
              {showPackageNames ? (
                <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-slate-500 truncate" dir="ltr">
                    {app.package_name}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopyPackage(app.package_name)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
                  >
                    {copiedPkg === app.package_name ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600" />
                        <span className="text-emerald-700">تم النسخ</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>نسخ المعرف</span>
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <details className="text-[11px] text-slate-400">
                  <summary className="cursor-pointer hover:text-slate-600 select-none">
                    معرف الحزمة التقني
                  </summary>
                  <div className="mt-1 flex items-center justify-between gap-2 bg-slate-50 px-2 py-1 rounded">
                    <span className="font-mono text-slate-600 truncate" dir="ltr">
                      {app.package_name}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopyPackage(app.package_name)}
                      className="text-blue-600 hover:underline font-semibold cursor-pointer"
                    >
                      {copiedPkg === app.package_name ? 'تم النسخ' : 'نسخ'}
                    </button>
                  </div>
                </details>
              )}
            </div>

            {!app.isProtected && (
              <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-600">
                  محظور في سياسة:{' '}
                  <strong className="text-slate-900">{app.blockedDeviceCount}</strong> من{' '}
                  <strong className="text-slate-900">{approvedDevices.length}</strong> جهاز معتمد
                </div>
                <div className="flex items-center gap-1.5">
                  {app.blockedDeviceCount > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        openDevicePickerForApp(
                          app.package_name,
                          app.app_name,
                          'allow_apps'
                        )
                      }
                      className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors cursor-pointer"
                    >
                      رفع الحظر...
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      openDevicePickerForApp(
                        app.package_name,
                        app.app_name,
                        'block_apps'
                      )
                    }
                    className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 transition-colors cursor-pointer"
                  >
                    حظر بالأجهزة...
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Modal to pick target devices for bulk app allow/block */}
      {activeAppModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs"
          dir="rtl"
        >
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {activeAppModal.mode === 'block_apps'
                    ? `حظر «${activeAppModal.appName}» على أجهزة مختارة`
                    : `رفع الحظر عن «${activeAppModal.appName}» على أجهزة مختارة`}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setActiveAppModal(null)}
                className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700">
                  اختر الأجهزة المعتمدة ({selectedDeviceUids.size} من {approvedDevices.length})
                </span>
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedDeviceUids(new Set(approvedDevices.map((d) => d.uid)))
                    }
                    className="text-blue-600 hover:underline font-bold cursor-pointer"
                  >
                    تحديد الكل
                  </button>
                  <span className="text-slate-300">|</span>
                  <button
                    type="button"
                    onClick={() => setSelectedDeviceUids(new Set())}
                    className="text-slate-500 hover:underline cursor-pointer"
                  >
                    إلغاء الكل
                  </button>
                </div>
              </div>

              <div className="divide-y divide-slate-200 border border-slate-200 rounded-xl max-h-60 overflow-y-auto">
                {approvedDevices.map((d) => {
                  const isCurrentlyBlocked = (d.policy?.blocked_apps ?? []).includes(
                    activeAppModal.packageName
                  );
                  const checked = selectedDeviceUids.has(d.uid);
                  const friendlyName = getDeviceFriendlyName(d);
                  return (
                    <label
                      key={d.uid}
                      className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 cursor-pointer text-xs"
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = new Set(selectedDeviceUids);
                            if (next.has(d.uid)) next.delete(d.uid);
                            else next.add(d.uid);
                            setSelectedDeviceUids(next);
                          }}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <div>
                          <div className="font-bold text-slate-900">
                            {friendlyName}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            المندوب: {d.metadata?.rep_name || 'غير محدد'}
                          </div>
                        </div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          isCurrentlyBlocked
                            ? 'bg-red-100 text-red-700'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {isCurrentlyBlocked ? 'محظور بالسياسة' : 'غير مدرج بالحظر'}
                      </span>
                    </label>
                  );
                })}
                {approvedDevices.length === 0 && (
                  <div className="p-4 text-center text-xs text-slate-500">
                    لا توجد أجهزة معتمدة حالياً.
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setActiveAppModal(null)}
                className="px-4 py-2 rounded-lg text-xs font-bold border border-slate-300 text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={selectedDeviceUids.size === 0}
                onClick={handleProceedToBulkModal}
                className={`px-5 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50 cursor-pointer ${
                  activeAppModal.mode === 'block_apps'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
              >
                متابعة المعاينة والتنفيذ ({selectedDeviceUids.size} جهاز)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Action Execution Modal */}
      {bulkExecutionConfig && (
        <BulkActionModal
          isOpen={true}
          onClose={() => setBulkExecutionConfig(null)}
          devices={devices}
          selectedUids={bulkExecutionConfig.targetUids}
          actionType={bulkExecutionConfig.actionType}
          actionParams={{ packages: bulkExecutionConfig.packages }}
          db={db}
          actor={actor}
        />
      )}
    </div>
  );
};
