import {KioskPanel} from './KioskPanel';
import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  Smartphone,
  Shield,
  Wifi,
  WifiOff,
  History,
  Terminal,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Search,
  Plus,
  Trash2,
  Ban,
  Check,
  Save,
  RotateCcw,
  Battery,
  Layers,
  Info,
  Wrench,
  ShieldAlert,
} from 'lucide-react';
import type { Firestore } from 'firebase/firestore';
import type {
  AdminIdentity,
  AuditLogDoc,
  DeviceAppInventoryDoc,
  DeviceAppItem,
  MergedDeviceRecord,
} from '../types/mdm';
import {
  formatAndroidSdk,
  formatLastSeenAr,
  HARDCODED_PROTECTED_PACKAGES,
  MAX_BLOCKED_APPS,
  sanitizeManualUid,
  validatePackageName,
} from '../utils/validation';
import {
  CURATED_APP_CATALOG,
  lookupAppInfo,
  searchCuratedCatalog,
} from '../utils/appCatalog';
import {
  subscribeToDeviceAppInventory,
} from '../services/mdmService';
import {
  ApprovalBadge,
  DeviceOwnerBadge,
  EnforcementBadge,
  StaleConnectionBadge,
} from './StatusBadges';

interface DeviceDetailDrawerProps {
  device: MergedDeviceRecord;
  onClose: () => void;
  auditLogs: AuditLogDoc[];
  db: Firestore;
  actor: AdminIdentity;
  onSavePolicy: (
    uid: string,
    payload: {
      block_tethering: boolean;
      blocked_apps: string[];
      expectedCurrentRevision: number | null;
      allowRepairCorrupted?: boolean;
    }
  ) => Promise<{ savedRevision: number }>;
  onSaveMetadata: (uid: string, deviceName: string, repName: string) => Promise<void>;
  onToggleApproval: (uid: string, approved: boolean) => Promise<void>;
}

type DrawerTab = 'kiosk' | 'overview' | 'apps' | 'tethering' | 'audit' | 'technical';

export const DeviceDetailDrawer: React.FC<DeviceDetailDrawerProps> = ({
  device,
  onClose,
  auditLogs,
  db,
  actor,
  onSavePolicy,
  onSaveMetadata,
  onToggleApproval,
}) => {
  const [activeTab, setActiveTab] = useState<DrawerTab>('overview');

  // Policy Form State
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const [allowTethering, setAllowTethering] = useState<boolean>(true); // allowTethering = !block_tethering
  const [blockedApps, setBlockedApps] = useState<string[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyFeedback, setPolicyFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // App Inventory real-time state from deviceAppInventory/{uid}
  const [inventory, setInventory] = useState<DeviceAppInventoryDoc | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(true);

  // App search & filter in Apps Tab
  const [appSearch, setAppSearch] = useState('');
  const [appFilter, setAppFilter] = useState<'all' | 'blocked' | 'allowed' | 'protected' | 'pending'>('all');
  const [selectedApps, setSelectedApps] = useState<Set<string>>(new Set());

  // Quick Catalog Picker Modal / Section
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [customPackageInput, setCustomPackageInput] = useState('');
  const [customPackageError, setCustomPackageError] = useState<string | null>(null);

  // Metadata Edit State
  const [editName, setEditName] = useState(device.metadata?.device_name || '');
  const [editRep, setEditRep] = useState(device.metadata?.rep_name || '');
  const [savingMeta, setSavingMeta] = useState(false);
  const [metaFeedback, setMetaFeedback] = useState<string | null>(null);

  // Stored corrupted policy repair toggle
  const [repairMode, setRepairMode] = useState(false);

  // Sync form with device policy
  useEffect(() => {
    if (device.policy) {
      setLoadedRevision(device.policy.revision);
      setAllowTethering(!device.policy.block_tethering);
      setBlockedApps([...device.policy.blocked_apps]);
      setIsDirty(false);
    } else {
      setLoadedRevision(null);
      setAllowTethering(true); // default: allowed
      setBlockedApps([]);
      setIsDirty(false);
    }
    setEditName(device.metadata?.device_name || '');
    setEditRep(device.metadata?.rep_name || '');
    setPolicyFeedback(null);
    setMetaFeedback(null);
  }, [device.uid, device.policy?.revision, device.policy?.block_tethering]);

  // Subscribe to real-time app inventory
  useEffect(() => {
    setInventoryLoading(true);
    const unsub = subscribeToDeviceAppInventory(db, device.uid, {
      onData: (data) => {
        setInventory(data);
        setInventoryLoading(false);
      },
      onError: () => {
        setInventoryLoading(false);
      },
    });
    return () => unsub();
  }, [db, device.uid]);

  // Unified application list for the device:
  // Combines:
  // 1. Apps reported in actual inventory (if available)
  // 2. Apps currently in the device's blocked_apps list (so they are always visible even if inventory hasn't reported them yet)
  // 3. System protected apps
  const combinedAppList = useMemo(() => {
    const map = new Map<
      string,
      {
        packageName: string;
        appName: string;
        category: string;
        isBlocked: boolean;
        isProtected: boolean;
        protectionReason?: string;
        reportedInInventory: boolean;
        hasLauncherIcon: boolean;
        isSystemApp: boolean;
        isHiddenByAgent: boolean;
        badgeBg: string;
        badgeTextColor: string;
      }
    >();

    // 1. Add apps from inventory if present
    if (inventory?.apps) {
      for (const item of inventory.apps) {
        const info = lookupAppInfo(item.package_name);
        map.set(item.package_name, {
          packageName: item.package_name,
          appName: item.app_name || info.nameAr,
          category: info.category,
          isBlocked: blockedApps.includes(item.package_name),
          isProtected: item.is_protected || info.isProtected,
          protectionReason: item.protection_reason || info.protectionReason,
          reportedInInventory: true,
          hasLauncherIcon: item.has_launcher_icon,
          isSystemApp: item.is_system_app,
          isHiddenByAgent: item.is_hidden_by_agent,
          badgeBg: info.badgeBg,
          badgeTextColor: info.badgeTextColor,
        });
      }
    }

    // 2. Ensure every currently blocked package is visible in the list even if not in inventory
    for (const pkg of blockedApps) {
      if (!map.has(pkg)) {
        const info = lookupAppInfo(pkg);
        map.set(pkg, {
          packageName: pkg,
          appName: info.nameAr,
          category: info.category,
          isBlocked: true,
          isProtected: info.isProtected,
          protectionReason: info.protectionReason,
          reportedInInventory: false,
          hasLauncherIcon: true,
          isSystemApp: false,
          isHiddenByAgent: false,
          badgeBg: info.badgeBg,
          badgeTextColor: info.badgeTextColor,
        });
      }
    }

    // 3. Also include core system protected packages for full transparency
    for (const [pkg, reason] of Object.entries(HARDCODED_PROTECTED_PACKAGES)) {
      if (!map.has(pkg)) {
        const info = lookupAppInfo(pkg);
        map.set(pkg, {
          packageName: pkg,
          appName: info.nameAr,
          category: 'system',
          isBlocked: false,
          isProtected: true,
          protectionReason: reason,
          reportedInInventory: false,
          hasLauncherIcon: false,
          isSystemApp: true,
          isHiddenByAgent: false,
          badgeBg: info.badgeBg,
          badgeTextColor: info.badgeTextColor,
        });
      }
    }

    return Array.from(map.values());
  }, [inventory, blockedApps]);

  // Filtered applications
  const filteredApps = useMemo(() => {
    return combinedAppList.filter((app) => {
      // Search
      const q = appSearch.trim().toLowerCase();
      if (q) {
        const matchesName = app.appName.toLowerCase().includes(q);
        const matchesPkg = app.packageName.toLowerCase().includes(q);
        if (!matchesName && !matchesPkg) return false;
      }

      // Filter
      if (appFilter === 'blocked') return app.isBlocked;
      if (appFilter === 'allowed') return !app.isBlocked && !app.isProtected;
      if (appFilter === 'protected') return app.isProtected;
      if (appFilter === 'pending') {
        // Pending enforcement: blocked in desired policy but device reported revision is behind
        const isDeviceBehind = (device.status?.applied_revision || 0) < (device.policy?.revision || 0);
        return app.isBlocked && isDeviceBehind;
      }
      return true;
    });
  }, [combinedAppList, appSearch, appFilter, device.status?.applied_revision, device.policy?.revision]);

  // Single app toggle
  const handleToggleApp = (pkg: string, targetBlocked: boolean) => {
    if (HARDCODED_PROTECTED_PACKAGES[pkg]) {
      setPolicyFeedback({
        type: 'error',
        message: `لا يمكن حظر التطبيق المحمي: ${pkg}`,
      });
      return;
    }

    if (targetBlocked) {
      if (blockedApps.includes(pkg)) return;
      if (blockedApps.length >= MAX_BLOCKED_APPS) {
        setPolicyFeedback({
          type: 'error',
          message: `تم الوصول إلى الحد الأقصى للتطبيقات المحظورة (${MAX_BLOCKED_APPS}).`,
        });
        return;
      }
      setBlockedApps([...blockedApps, pkg]);
    } else {
      setBlockedApps(blockedApps.filter((p) => p !== pkg));
    }
    setIsDirty(true);
    setPolicyFeedback(null);
  };

  // Bulk allow/block selected apps within drawer
  const handleBulkAllowSelected = () => {
    if (selectedApps.size === 0) return;
    setBlockedApps(blockedApps.filter((p) => !selectedApps.has(p)));
    setSelectedApps(new Set());
    setIsDirty(true);
    setPolicyFeedback(null);
  };

  const handleBulkBlockSelected = () => {
    if (selectedApps.size === 0) return;
    const toAdd: string[] = [];
    for (const pkg of selectedApps) {
      if (HARDCODED_PROTECTED_PACKAGES[pkg]) continue;
      if (!blockedApps.includes(pkg)) {
        toAdd.push(pkg);
      }
    }
    const union = Array.from(new Set([...blockedApps, ...toAdd]));
    if (union.length > MAX_BLOCKED_APPS) {
      setPolicyFeedback({
        type: 'error',
        message: `سيتجاوز إجمالي المحظورات الحد الأقصى (${MAX_BLOCKED_APPS}). اختر عدداً أقل.`,
      });
      return;
    }
    setBlockedApps(union);
    setSelectedApps(new Set());
    setIsDirty(true);
    setPolicyFeedback(null);
  };

  // Add custom package input
  const handleAddCustomPackage = (e: React.FormEvent) => {
    e.preventDefault();
    setCustomPackageError(null);
    const trimmed = customPackageInput.trim();
    if (!trimmed) return;

    if (HARDCODED_PROTECTED_PACKAGES[trimmed]) {
      setCustomPackageError(`تطبيق محمي ولا يمكن حظره: ${trimmed}`);
      return;
    }

    const val = validatePackageName(trimmed, blockedApps);
    if (!val.valid) {
      setCustomPackageError(val.error || 'اسم حزمة غير صالح وفق شروط أندرويد.');
      return;
    }

    setBlockedApps([...blockedApps, trimmed]);
    setCustomPackageInput('');
    setIsDirty(true);
    setShowCatalogPicker(false);
  };

  // Add app from catalog picker
  const handleSelectFromCatalog = (entry: typeof CURATED_APP_CATALOG[0]) => {
    if (entry.isProtected || HARDCODED_PROTECTED_PACKAGES[entry.packageName]) {
      setCustomPackageError(`تطبيق محمي برمجياً: ${entry.nameAr}`);
      return;
    }
    if (blockedApps.includes(entry.packageName)) {
      setCustomPackageError('التطبيق محظور بالفعل في القائمة.');
      return;
    }
    if (blockedApps.length >= MAX_BLOCKED_APPS) {
      setCustomPackageError(`تم الوصول للحد الأقصى (${MAX_BLOCKED_APPS}).`);
      return;
    }

    setBlockedApps([...blockedApps, entry.packageName]);
    setIsDirty(true);
    setShowCatalogPicker(false);
  };

  // Save Policy to Firestore with conflict detection
  const handleSavePolicySubmit = async () => {
    setSavingPolicy(true);
    setPolicyFeedback(null);
    try {
      const res = await onSavePolicy(device.uid, {
        block_tethering: !allowTethering, // Invert: block_tethering = !allowTethering
        blocked_apps: blockedApps,
        expectedCurrentRevision: loadedRevision,
        allowRepairCorrupted: repairMode,
      });

      setIsDirty(false);
      setRepairMode(false);
      setLoadedRevision(res.savedRevision);
      setPolicyFeedback({
        type: 'success',
        message: `تم حفظ السياسة (الإصدار v${res.savedRevision}) بنجاح. حُفظ التغيير وبانتظار تأكيد الهاتف عند المزامنة.`,
      });
    } catch (err) {
      setPolicyFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingPolicy(false);
    }
  };

  // Save Administrative Metadata
  const handleSaveMetadataSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingMeta(true);
    setMetaFeedback(null);
    try {
      await onSaveMetadata(device.uid, editName, editRep);
      setMetaFeedback('تم حفظ الاسم الإداري واسم المندوب بنجاح.');
    } catch (err) {
      setMetaFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingMeta(false);
    }
  };

  const lastSeenDetails = formatLastSeenAr(device.lastSeenMs);
  const deviceLogs = auditLogs.filter((log) => log.target_uid === device.uid);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white w-full max-w-3xl h-full shadow-2xl flex flex-col border-r border-slate-200 text-right overflow-hidden">
        {/* Drawer Header */}
        <div className="p-5 border-b border-slate-200 bg-slate-50 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 bg-blue-100 text-blue-800 rounded-lg">
                <Smartphone className="w-5 h-5" />
              </span>
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  {device.metadata?.device_name || device.status?.model || 'جهاز بدون اسم'}
                </h2>
                <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                  <span>المندوب: {device.metadata?.rep_name || 'غير محدد'}</span>
                  <span>·</span>
                  <span>الطراز: {device.status?.model || 'غير محدد'}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 rounded-lg transition-colors"
              title="إغلاق"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Unsaved Changes Banner */}
        {isDirty && (
          <div className="bg-amber-50 border-b border-amber-200 px-5 py-2.5 flex items-center justify-between gap-3 text-xs text-amber-900">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>توجد تعديلات غير محفوظة على سياسة هذا الجهاز.</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setBlockedApps([...(device.policy?.blocked_apps || [])]);
                  setAllowTethering(!(device.policy?.block_tethering ?? false));
                  setIsDirty(false);
                }}
                className="px-2.5 py-1 text-slate-600 hover:bg-amber-100 rounded-md font-semibold"
              >
                تراجع
              </button>
              <button
                type="button"
                disabled={savingPolicy}
                onClick={handleSavePolicySubmit}
                className="inline-flex items-center gap-1 px-3 py-1 bg-blue-700 hover:bg-blue-800 text-white rounded-md font-bold shadow-xs"
              >
                <Save className="w-3.5 h-3.5" />
                <span>حفظ التعديلات</span>
              </button>
            </div>
          </div>
        )}

        {/* Drawer Tabs Navigation */}
        <div className="flex items-center gap-1 px-5 border-b border-slate-200 bg-white overflow-x-auto text-xs font-semibold">
          <button className="py-3 px-3 whitespace-nowrap text-blue-700" onClick={() => setActiveTab('kiosk')}>شاشة الشركة</button>
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`py-3 px-3 border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'overview'
                ? 'border-blue-700 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Smartphone className="w-4 h-4" />
            <span>نظرة عامة</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('apps')}
            className={`py-3 px-3 border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'apps'
                ? 'border-blue-700 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>التطبيقات ({blockedApps.length} ممنوع)</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('tethering')}
            className={`py-3 px-3 border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'tethering'
                ? 'border-blue-700 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            {allowTethering ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
            <span>مشاركة الإنترنت ({allowTethering ? 'مسموح' : 'ممنوع'})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('audit')}
            className={`py-3 px-3 border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'audit'
                ? 'border-blue-700 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <History className="w-4 h-4" />
            <span>سجل العمليات ({deviceLogs.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('technical')}
            className={`py-3 px-3 border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'technical'
                ? 'border-blue-700 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Terminal className="w-4 h-4" />
            <span>تفاصيل تقنية</span>
          </button>
        </div>

        {/* Feedback alert inside drawer */}
        {policyFeedback && (
          <div
            className={`mx-5 mt-4 p-3.5 rounded-xl border text-xs flex items-start gap-2.5 ${
              policyFeedback.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-900'
            }`}
          >
            {policyFeedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
            ) : (
              <ShieldAlert className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
            )}
            <div className="leading-relaxed">{policyFeedback.message}</div>
          </div>
        )}

        {/* Tab Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* ===================== TAB 1: OVERVIEW ===================== */}
          {activeTab === 'overview' && (
            <div className="space-y-6 text-xs">
              {/* Device Status Badges Row */}
              <div className="flex flex-wrap items-center gap-2 p-4 bg-slate-50 border border-slate-200 rounded-xl">
                <ApprovalBadge state={device.approvalState} />
                <DeviceOwnerBadge isOwner={device.status?.device_owner} />
                <EnforcementBadge state={device.enforcementState} />
                <StaleConnectionBadge isStale={device.isStaleConnection} />
              </div>

              {/* Status explanation */}
              <div className="p-4 bg-white border border-slate-200 rounded-xl space-y-2">
                <span className="font-bold text-slate-900 block text-sm">حالة المزامنة والاتصال</span>
                <p className="text-slate-700 leading-relaxed">{device.enforcementDetail}</p>
                <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-slate-500 text-[11px]">
                  <span>آخر تواصل مسجل: {lastSeenDetails.relative} ({lastSeenDetails.formatted})</span>
                  <span className="text-[10px]">{lastSeenDetails.explanation}</span>
                </div>
              </div>

              {/* Hardware & Agent Info Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <span className="text-slate-500 text-[11px] block">البطارية</span>
                  <span className="text-base font-bold font-mono text-slate-900 mt-1 block">
                    {device.status ? `${device.status.battery_percent}%` : 'غير متوفر'}
                  </span>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <span className="text-slate-500 text-[11px] block">نظام أندرويد</span>
                  <span className="text-base font-bold font-mono text-slate-900 mt-1 block">
                    {formatAndroidSdk(device.status?.android_sdk)}
                  </span>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <span className="text-slate-500 text-[11px] block">إصدار الوكيل</span>
                  <span className="text-base font-bold font-mono text-slate-900 mt-1 block">
                    {device.status?.agent_version || 'غير معروف'}
                  </span>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <span className="text-slate-500 text-[11px] block">الإصدار المطبق</span>
                  <span className="text-base font-bold font-mono text-slate-900 mt-1 block">
                    v{device.status?.applied_revision ?? 0}
                  </span>
                </div>
              </div>

              {/* Administrative Names Form */}
              <form
                onSubmit={handleSaveMetadataSubmit}
                className="p-4 bg-white border border-slate-200 rounded-xl space-y-4"
              >
                <div>
                  <h4 className="text-sm font-bold text-slate-900">التعريف الإداري للجهاز</h4>
                  <p className="text-slate-500 text-[11px] mt-0.5">
                    يُحفظ في مجموعة <code className="font-mono">deviceMetadata</code> المنفصلة دون المساس بإعدادات الوكيل على الهاتف.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      اسم الجهاز الإداري
                    </label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="مثال: جهاز خط مبيعات شمال الرياض"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-blue-600"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      اسم المندوب المسؤول
                    </label>
                    <input
                      type="text"
                      value={editRep}
                      onChange={(e) => setEditRep(e.target.value)}
                      placeholder="مثال: أحمد العتيبي"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-blue-600"
                    />
                  </div>
                </div>

                {metaFeedback && (
                  <p className="text-[11px] text-emerald-700 font-semibold">{metaFeedback}</p>
                )}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={savingMeta}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-colors"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>حفظ بيانات الجهاز</span>
                  </button>
                </div>
              </form>

              {/* Approval status toggle */}
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
                <div>
                  <span className="font-bold text-slate-900 block">اعتماد الجهاز في النظام</span>
                  <span className="text-[11px] text-slate-500 mt-0.5 block">
                    {device.approvalState === 'approved'
                      ? 'الجهاز معتمد ومسموح له بمزامنة السياسات.'
                      : 'الجهاز غير معتمد ولا يمكنه قراءة السياسات.'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onToggleApproval(device.uid, device.approvalState !== 'approved')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                    device.approvalState === 'approved'
                      ? 'bg-amber-100 hover:bg-amber-200 text-amber-900'
                      : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                  }`}
                >
                  {device.approvalState === 'approved' ? 'إلغاء الاعتماد' : 'اعتماد الجهاز'}
                </button>
              </div>
            </div>
          )}

          {/* ===================== TAB 2: APPS ===================== */}
          {activeTab === 'kiosk' && <KioskPanel db={db} device={device} actor={actor} inventory={inventory} />}

          {activeTab === 'apps' && (
            <div className="space-y-4 text-xs">
              {/* App Inventory Honest Notice */}
              {!inventory && !inventoryLoading && (
                <div className="p-4 bg-amber-50/70 border border-amber-200 rounded-xl flex items-start gap-3 text-amber-950">
                  <Info className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                  <div className="space-y-1 leading-relaxed">
                    <p className="font-bold">عرض تطبيقات هذا الجهاز يتطلب تحديث تطبيق إنجاز (0.3.1+)</p>
                    <p>
                      الوكيل الحالي لا يرفع بعد وثيقة جرد التطبيقات (<code className="font-mono">deviceAppInventory</code>).
                      يمكنك حالياً اختيار التطبيقات من الدليل المعتمد بالأسماء، أو إدخال الحزمة بالخيارات المتقدمة، وستُطبق السياسة فوراً على الوكيل.
                    </p>
                  </div>
                </div>
              )}

              {/* Search & Actions Bar */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
                  <input
                    type="text"
                    value={appSearch}
                    onChange={(e) => setAppSearch(e.target.value)}
                    placeholder="ابحث باسم التطبيق أو الحزمة…"
                    className="w-full pr-9 pl-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-blue-600"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowCatalogPicker(!showCatalogPicker)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded-lg text-xs font-bold transition-colors whitespace-nowrap"
                  >
                    <Plus className="w-4 h-4" />
                    <span>إضافة تطبيق للحظر</span>
                  </button>
                </div>
              </div>

              {/* Catalog Picker Drawer / Section */}
              {showCatalogPicker && (
                <div className="p-4 bg-blue-50/50 border border-blue-200 rounded-xl space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900 text-xs">اختر تطبيقاً شائعاً لحظر استخدامه:</span>
                    <button
                      type="button"
                      onClick={() => setShowCatalogPicker(false)}
                      className="text-slate-400 hover:text-slate-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <input
                    type="text"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    placeholder="ابحث في دليل التطبيقات (تيك توك، ببجي، نتفلكس...)"
                    className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs focus:outline-hidden focus:ring-1 focus:ring-blue-600"
                  />

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                    {searchCuratedCatalog(catalogSearch)
                      .filter((c) => !c.isProtected && !blockedApps.includes(c.packageName))
                      .map((entry) => (
                        <button
                          key={entry.packageName}
                          type="button"
                          onClick={() => handleSelectFromCatalog(entry)}
                          className="text-right p-2 bg-white hover:bg-blue-50 border border-slate-200 hover:border-blue-300 rounded-lg transition-colors flex items-center justify-between gap-2"
                        >
                          <div>
                            <span className="font-bold text-slate-900 block truncate">{entry.nameAr}</span>
                            <span className="font-mono text-[9px] text-slate-400 block truncate">
                              {entry.packageName}
                            </span>
                          </div>
                          <span className="p-1 text-blue-700">
                            <Plus className="w-3.5 h-3.5" />
                          </span>
                        </button>
                      ))}
                  </div>

                  {/* Manual package entry fallback in an advanced toggle */}
                  <details className="pt-2 border-t border-blue-200">
                    <summary className="cursor-pointer text-[11px] font-semibold text-blue-800 hover:underline">
                      إدخال اسم حزمة يدويًا (خيارات متقدمة)
                    </summary>
                    <form onSubmit={handleAddCustomPackage} className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={customPackageInput}
                        onChange={(e) => setCustomPackageInput(e.target.value)}
                        placeholder="com.example.app"
                        className="flex-1 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono"
                      />
                      <button
                        type="submit"
                        className="px-3 py-1.5 bg-slate-900 text-white font-semibold rounded-lg text-xs"
                      >
                        إضافة
                      </button>
                    </form>
                    {customPackageError && (
                      <p className="text-[11px] text-red-600 mt-1">{customPackageError}</p>
                    )}
                  </details>
                </div>
              )}

              {/* Filter Chips & Multi-selection Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-1.5 overflow-x-auto text-[11px]">
                  <button
                    type="button"
                    onClick={() => setAppFilter('all')}
                    className={`px-2.5 py-1 rounded-md font-semibold ${
                      appFilter === 'all'
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    الكل ({combinedAppList.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setAppFilter('blocked')}
                    className={`px-2.5 py-1 rounded-md font-semibold ${
                      appFilter === 'blocked'
                        ? 'bg-red-700 text-white'
                        : 'bg-red-50 text-red-800 hover:bg-red-100'
                    }`}
                  >
                    ممنوع ({combinedAppList.filter((a) => a.isBlocked).length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setAppFilter('allowed')}
                    className={`px-2.5 py-1 rounded-md font-semibold ${
                      appFilter === 'allowed'
                        ? 'bg-emerald-700 text-white'
                        : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                    }`}
                  >
                    مسموح ({combinedAppList.filter((a) => !a.isBlocked && !a.isProtected).length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setAppFilter('protected')}
                    className={`px-2.5 py-1 rounded-md font-semibold ${
                      appFilter === 'protected'
                        ? 'bg-blue-700 text-white'
                        : 'bg-blue-50 text-blue-800 hover:bg-blue-100'
                    }`}
                  >
                    محمي ({combinedAppList.filter((a) => a.isProtected).length})
                  </button>
                </div>

                {selectedApps.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-slate-700">
                      محدد: {selectedApps.size}
                    </span>
                    <button
                      type="button"
                      onClick={handleBulkBlockSelected}
                      className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded-md text-[11px] font-bold"
                    >
                      منع المحدد
                    </button>
                    <button
                      type="button"
                      onClick={handleBulkAllowSelected}
                      className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-[11px] font-bold"
                    >
                      السماح بالمحدد
                    </button>
                  </div>
                )}
              </div>

              {/* Apps List Table */}
              <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100">
                {filteredApps.length === 0 ? (
                  <div className="p-8 text-center text-slate-500">
                    لا توجد تطبيقات مطابقة لمعايير البحث.
                  </div>
                ) : (
                  filteredApps.map((app) => {
                    const isSelected = selectedApps.has(app.packageName);
                    return (
                      <div
                        key={app.packageName}
                        className={`p-3.5 flex items-center justify-between gap-3 transition-colors ${
                          app.isBlocked
                            ? 'bg-red-50/40'
                            : app.isProtected
                            ? 'bg-blue-50/30'
                            : 'bg-white hover:bg-slate-50/80'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {!app.isProtected && (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                const next = new Set(selectedApps);
                                if (e.target.checked) next.add(app.packageName);
                                else next.delete(app.packageName);
                                setSelectedApps(next);
                              }}
                              className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                            />
                          )}

                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs ${app.badgeBg} ${app.badgeTextColor}`}>
                            {app.appName.slice(0, 1)}
                          </div>

                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-900 text-xs">{app.appName}</span>
                              {app.isProtected && (
                                <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-800">
                                  <Shield className="w-3 h-3" />
                                  <span>محمي</span>
                                </span>
                              )}
                              {app.isBlocked && (
                                <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800">
                                  <Ban className="w-3 h-3" />
                                  <span>ممنوع</span>
                                </span>
                              )}
                              {!app.isBlocked && !app.isProtected && (
                                <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                                  <Check className="w-3 h-3" />
                                  <span>مسموح</span>
                                </span>
                              )}
                            </div>

                            <span className="font-mono text-[10px] text-slate-400 block mt-0.5">
                              {app.packageName}
                            </span>

                            {app.protectionReason && (
                              <p className="text-[10px] text-blue-700 mt-0.5">
                                {app.protectionReason}
                              </p>
                            )}

                            {!app.reportedInInventory && app.isBlocked && (
                              <p className="text-[10px] text-amber-700 mt-0.5">
                                لم يؤكد الجرد وجوده بعد على الهاتف؛ الحظر مسجل بالسياسة ويمكن فكه.
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Toggle Action Button */}
                        <div className="shrink-0">
                          {app.isProtected ? (
                            <span className="text-[11px] text-slate-400 font-medium">نظام محمي</span>
                          ) : app.isBlocked ? (
                            <button
                              type="button"
                              onClick={() => handleToggleApp(app.packageName, false)}
                              className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-800 font-bold rounded-lg text-xs transition-colors"
                            >
                              السماح بالتطبيق
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleToggleApp(app.packageName, true)}
                              className="px-3 py-1.5 bg-red-50 hover:bg-red-100 border border-red-300 text-red-800 font-bold rounded-lg text-xs transition-colors"
                            >
                              حظر التطبيق
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* ===================== TAB 3: TETHERING ===================== */}
          {activeTab === 'tethering' && (
            <div className="space-y-6 text-xs">
              <div className="p-5 bg-white border border-slate-200 rounded-xl space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-base font-bold text-slate-900">
                      إعداد مشاركة الإنترنت ونقطة الاتصال (Hotspot)
                    </h3>
                    <p className="text-slate-500 text-xs mt-1 leading-relaxed">
                      يتحكم في إمكانية استخدام هاتف المندوب كنقطة اتصال لمشاركة باقة الإنترنت مع أجهزة أخرى عبر شبكة Wi-Fi أو البلوتوث أو USB.
                    </p>
                  </div>
                  <div className={`p-3 rounded-2xl ${allowTethering ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
                    {allowTethering ? <Wifi className="w-6 h-6" /> : <WifiOff className="w-6 h-6" />}
                  </div>
                </div>

                {/* Clear Toggle Switch for Non-Technical Managers */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
                  <div>
                    <span className="font-bold text-sm text-slate-900 block">
                      السماح بمشاركة الإنترنت
                    </span>
                    <span className="text-[11px] text-slate-500 mt-0.5 block">
                      {allowTethering
                        ? 'مسموح: يمكن للمندوب تفعيل نقطة الاتصال (Hotspot).'
                        : 'ممنوع: تطبيق وكيل إنجاز يفرض قيد DISALLOW_CONFIG_TETHERING ويمنع تشغيل الهوتسبوت.'}
                    </span>
                  </div>

                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowTethering}
                      onChange={(e) => {
                        setAllowTethering(e.target.checked);
                        setIsDirty(true);
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-300 peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                  </label>
                </div>

                {/* Comparison Card: Desired vs Phone Reported */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                    <span className="text-slate-500 text-[11px] block">المطلوب من الإدارة (في السياسة)</span>
                    <span className="text-sm font-bold text-slate-900 mt-1 block">
                      {allowTethering ? 'مسموح بمشاركة الإنترنت' : 'حظر مشاركة الإنترنت (Hotspot)'}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono mt-0.5 block">
                      block_tethering = {!allowTethering ? 'true' : 'false'}
                    </span>
                  </div>

                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                    <span className="text-slate-500 text-[11px] block">الحالة المبلغ عنها من الهاتف</span>
                    <span className="text-sm font-bold text-slate-900 mt-1 block">
                      {device.status === null
                        ? 'لم يرد تقرير حالة بعد'
                        : device.status.tethering_restricted
                        ? 'ممنوعة ومقفلة فعلياً على الجهاز'
                        : 'غير ممنوعة (مفتوحة)'}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono mt-0.5 block">
                      tethering_restricted = {device.status?.tethering_restricted ? 'true' : 'false'}
                    </span>
                  </div>
                </div>

                {/* Save button if changed */}
                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    disabled={savingPolicy || !isDirty}
                    onClick={handleSavePolicySubmit}
                    className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-blue-700 hover:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl text-xs font-bold transition-colors shadow-xs"
                  >
                    <Save className="w-4 h-4" />
                    <span>حفظ إعداد المشاركة</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ===================== TAB 4: AUDIT LOGS ===================== */}
          {activeTab === 'audit' && (
            <div className="space-y-4 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-900 text-sm">
                  سجل التعديلات والإجراءات الإدارية الخاصة بهذا الجهاز
                </span>
                <span className="text-slate-500 text-[11px]">
                  سجل تدقيق محمي من الحذف والتعديل
                </span>
              </div>

              {deviceLogs.length === 0 ? (
                <div className="p-8 text-center text-slate-500 bg-slate-50 border border-slate-200 rounded-xl">
                  لا توجد عمليات مسجلة لهذا الجهاز حتى الآن.
                </div>
              ) : (
                <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100">
                  {deviceLogs.map((log) => (
                    <div key={log.id} className="p-3.5 bg-white space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-900 text-xs">{log.summary}</span>
                        <span className="text-[10px] font-mono text-slate-400">
                          {log.created_at ? log.created_at.toDate().toLocaleString('ar-SA') : 'منذ قليل'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-500">
                        <span>المسؤول: {log.actor_email}</span>
                        <span>·</span>
                        <span className="font-mono text-[10px]">{log.action}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ===================== TAB 5: TECHNICAL ===================== */}
          {activeTab === 'technical' && (
            <div className="space-y-4 text-xs">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                <span className="font-bold text-slate-900 block text-sm">المعرّفات وتفاصيل الوكيل الفنية</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-slate-700">
                  <div>
                    <span className="text-slate-400 text-[10px] block">معرّف الجهاز (Auth UID)</span>
                    <span className="font-mono text-xs text-slate-900 select-all block mt-0.5">
                      {device.uid}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 text-[10px] block">إصدار السياسة المخزنة</span>
                    <span className="font-mono text-xs text-slate-900 block mt-0.5">
                      الإصدار المطلوب: v{device.policy?.revision ?? 0} · الإصدار المطبق: v{device.status?.applied_revision ?? 0}
                    </span>
                  </div>
                </div>
              </div>

              {/* Repair Corrupted Policy Mode */}
              {device.policy?.isCorrupted && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-xl space-y-3">
                  <div className="flex items-start gap-2.5 text-red-900 font-bold">
                    <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    <span>تنبيه: وثيقة السياسة في الخادم تحتوي على حقول تالفة أو غير صالحة</span>
                  </div>
                  <ul className="list-disc list-inside space-y-1 text-red-800 text-[11px]">
                    {(device.policy.corruptionErrors || []).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                  <label className="flex items-center gap-2 text-xs font-bold text-red-950 cursor-pointer pt-2">
                    <input
                      type="checkbox"
                      checked={repairMode}
                      onChange={(e) => setRepairMode(e.target.checked)}
                      className="rounded border-red-400 text-red-700"
                    />
                    <span>تفعيل وضع تصحيح واستبدال الحقول التالفة عند الحفظ</span>
                  </label>
                </div>
              )}

              {/* Raw JSON documents inspect */}
              <details className="p-4 bg-white border border-slate-200 rounded-xl">
                <summary className="font-bold text-slate-800 cursor-pointer">
                  معاينة مستندات Firestore الخام (JSON)
                </summary>
                <div className="mt-3 space-y-3 text-[11px]">
                  <div>
                    <span className="font-mono font-bold text-slate-700 block">enrollments/{device.uid}</span>
                    <pre className="p-2.5 bg-slate-100 rounded-lg font-mono text-[10px] overflow-x-auto mt-1">
                      {JSON.stringify(device.enrollment?.rawData || device.enrollment, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <span className="font-mono font-bold text-slate-700 block">policies/{device.uid}</span>
                    <pre className="p-2.5 bg-slate-100 rounded-lg font-mono text-[10px] overflow-x-auto mt-1">
                      {JSON.stringify(device.policy?.rawData || device.policy, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <span className="font-mono font-bold text-slate-700 block">deviceStatus/{device.uid}</span>
                    <pre className="p-2.5 bg-slate-100 rounded-lg font-mono text-[10px] overflow-x-auto mt-1">
                      {JSON.stringify(device.status, null, 2)}
                    </pre>
                  </div>
                </div>
              </details>
            </div>
          )}
        </div>

        {/* Drawer Footer */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs">
          <span className="text-slate-500">
            {isDirty ? 'توجد تغييرات غير محفوظة' : 'جميع البيانات متزامنة مع الخادم'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 rounded-lg font-semibold transition-colors"
            >
              إغلاق
            </button>
            {isDirty && (
              <button
                type="button"
                disabled={savingPolicy}
                onClick={handleSavePolicySubmit}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white rounded-lg font-bold transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                <span>حفظ التعديلات</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
