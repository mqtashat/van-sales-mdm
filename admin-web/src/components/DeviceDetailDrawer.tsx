import React, { useState, useEffect, useMemo } from 'react';
import type { Firestore } from 'firebase/firestore';
import {
  MergedDeviceRecord,
  AuditLogDoc,
  DeviceAppInventoryDoc,
  AdminIdentity,
} from '../types/mdm';
import {
  ApprovalBadge,
  DeviceOwnerBadge,
  EnforcementBadge,
  StaleConnectionBadge,
} from './StatusBadges';
import {
  HARDCODED_PROTECTED_PACKAGES,
  MAX_BLOCKED_APPS,
  validatePackageName,
  formatTimestampAr,
  formatLastSeenAr,
  formatAndroidSdk,
} from '../utils/validation';
import {
  CURATED_APP_CATALOG,
  lookupAppInfo,
} from '../utils/appCatalog';
import {
  getDeviceFriendlyName,
  formatEnforcementSummaryAr,
  formatAuditLogSummaryAr,
} from '../utils/presentation';
import {
  subscribeToDeviceAppInventory,
  saveDeviceMetadata,
  setDeviceApproval,
  saveDevicePolicyTransaction,
  setDeviceArchivedStatus,
} from '../services/mdmService';
import { KioskPanel } from './KioskPanel';
import {
  Smartphone,
  Shield,
  WifiOff,
  AppWindow,
  Save,
  Plus,
  AlertCircle,
  CheckCircle2,
  History,
  Search,
  Lock,
  Code2,
  Copy,
  Check,
  ArrowRight,
  ChevronLeft,
  SlidersHorizontal,
  AlertTriangle,
  Archive,
  ArchiveRestore,
} from 'lucide-react';

export type DeviceManagementTabId = 'overview' | 'apps' | 'kiosk' | 'tethering' | 'history';

interface DeviceDetailDrawerProps {
  device: MergedDeviceRecord | null;
  allDevices?: MergedDeviceRecord[];
  auditLogs: AuditLogDoc[];
  db: Firestore;
  actor: AdminIdentity;
  activeTab?: DeviceManagementTabId;
  onTabChange?: (tab: DeviceManagementTabId) => void;
  discardDraftSignal?: number;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onNavigateAdvancedSettings?: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  approve_device: 'اعتماد جهاز',
  revoke_approval: 'سحب اعتماد جهاز',
  create_policy: 'إنشاء سياسة جهاز',
  update_policy: 'تحديث سياسة جهاز',
  update_metadata: 'تعديل بيانات التعريف',
  archive_device: 'إزالة جهاز من القائمة (أرشفة)',
  restore_device: 'استعادة جهاز إلى القائمة',
};

export const DeviceDetailDrawer: React.FC<DeviceDetailDrawerProps> = ({
  device,
  allDevices = [],
  auditLogs,
  db,
  actor,
  activeTab: controlledActiveTab,
  onTabChange,
  discardDraftSignal = 0,
  onClose,
  onDirtyChange,
  onNavigateAdvancedSettings,
}) => {
  const [internalActiveTab, setInternalActiveTab] = useState<DeviceManagementTabId>('overview');
  const activeTab = controlledActiveTab ?? internalActiveTab;
  const [localDiscardSignal, setLocalDiscardSignal] = useState(0);
  const effectiveDiscardSignal = discardDraftSignal + localDiscardSignal;

  // Metadata form state
  const [deviceName, setDeviceName] = useState('');
  const [repName, setRepName] = useState('');
  const [metaEdited, setMetaEdited] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaSuccess, setMetaSuccess] = useState<string | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);

  // Approval state
  const [savingApproval, setSavingApproval] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [confirmRevokeApproval, setConfirmRevokeApproval] = useState(false);

  // Policy form state
  const [blockTethering, setBlockTethering] = useState(true);
  const [blockedApps, setBlockedApps] = useState<string[]>([]);
  const [policyEdited, setPolicyEdited] = useState(false);
  const [pinnedPolicyRevision, setPinnedPolicyRevision] = useState<number | null>(null);
  const [policyRevisionConflict, setPolicyRevisionConflict] = useState<{
    pinned: number | null;
    incoming: number | null;
  } | null>(null);
  const [newPackageInput, setNewPackageInput] = useState('');
  const [showAddCustomModal, setShowAddCustomModal] = useState(false);
  const [appSearchQuery, setAppSearchQuery] = useState('');
  const [appFilter, setAppFilter] = useState<'all' | 'blocked' | 'allowed' | 'protected'>('all');
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const [showPackageNames, setShowPackageNames] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policySuccess, setPolicySuccess] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [copiedUid, setCopiedUid] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);
  const [copiedPkg, setCopiedPkg] = useState<string | null>(null);

  // Child Kiosk dirty state
  const [kioskDirty, setKioskDirty] = useState(false);

  // Archiving state
  const [showArchiveConfirmModal, setShowArchiveConfirmModal] = useState(false);
  const [savingArchive, setSavingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveSuccess, setArchiveSuccess] = useState<string | null>(null);

  const handleArchiveToggle = async (archived: boolean) => {
    if (!device) return;
    setSavingArchive(true);
    setArchiveError(null);
    setArchiveSuccess(null);
    try {
      await setDeviceArchivedStatus(db, device.uid, archived, actor);
      setShowArchiveConfirmModal(false);
      setArchiveSuccess(
        archived
          ? 'تمت إزالة الجهاز من القائمة الرئيسية بنجاح، ويمكن الوصول إليه عبر فلتر «الأجهزة المؤرشفة».'
          : 'تمت استعادة الجهاز إلى القائمة الرئيسية بنجاح.'
      );
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'تعذر تحديث حالة أرشفة الجهاز');
    } finally {
      setSavingArchive(false);
    }
  };

  // Pending navigation confirmation when form has unsaved edits
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // Real-time reported app inventory from Android 0.3.1+ agent
  const [appInventory, setAppInventory] = useState<DeviceAppInventoryDoc | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!device?.uid || !db) {
      setAppInventory(null);
      setInventoryError(null);
      return;
    }
    setInventoryLoading(true);
    setInventoryError(null);
    const unsub = subscribeToDeviceAppInventory(db, device.uid, {
      onData: (record) => {
        setAppInventory(record);
        setInventoryLoading(false);
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setInventoryError(msg);
        setInventoryLoading(false);
      },
    });
    return () => unsub();
  }, [device?.uid, db]);

  // Sync local state when switching to a different device UID
  useEffect(() => {
    if (device) {
      setDeviceName(device.metadata?.device_name ?? '');
      setRepName(device.metadata?.rep_name ?? '');
      setMetaEdited(false);
      setMetaError(null);
      setMetaSuccess(null);
      setApprovalError(null);
      setConfirmRevokeApproval(false);

      setBlockTethering(device.policy?.block_tethering ?? true);
      setBlockedApps(device.policy?.blocked_apps ? [...device.policy.blocked_apps] : []);
      setPolicyEdited(false);
      setPinnedPolicyRevision(device.policy?.revision ?? null);
      setPolicyRevisionConflict(null);
      setNewPackageInput('');
      setAppSearchQuery('');
      setAppFilter('all');
      setSelectedPackages(new Set());
      setPolicyError(null);
      setPolicySuccess(null);
      setKioskDirty(false);
    }
  }, [device?.uid]);

  // Preserve admin drafts on incoming snapshots; update clean fields and flag revision conflict if dirty
  useEffect(() => {
    if (!device) return;
    if (!metaEdited) {
      setDeviceName(device.metadata?.device_name ?? '');
      setRepName(device.metadata?.rep_name ?? '');
    }
    const incomingRev = device.policy?.revision ?? null;
    if (!policyEdited) {
      setBlockTethering(device.policy?.block_tethering ?? true);
      setBlockedApps(device.policy?.blocked_apps ? [...device.policy.blocked_apps] : []);
      setPinnedPolicyRevision(incomingRev);
      setPolicyRevisionConflict(null);
    } else if (incomingRev !== pinnedPolicyRevision) {
      setPolicyRevisionConflict({
        pinned: pinnedPolicyRevision,
        incoming: incomingRev,
      });
    }
  }, [
    device?.metadata?.device_name,
    device?.metadata?.rep_name,
    device?.policy?.revision,
    device?.policy?.block_tethering,
    device?.policy?.blocked_apps,
    metaEdited,
    policyEdited,
    pinnedPolicyRevision,
  ]);

  // Reset local drafts when parent discardDraftSignal increments
  useEffect(() => {
    if (discardDraftSignal > 0 && device) {
      setDeviceName(device.metadata?.device_name ?? '');
      setRepName(device.metadata?.rep_name ?? '');
      setMetaEdited(false);
      setMetaError(null);
      setBlockTethering(device.policy?.block_tethering ?? true);
      setBlockedApps(device.policy?.blocked_apps ? [...device.policy.blocked_apps] : []);
      setPolicyEdited(false);
      setPinnedPolicyRevision(device.policy?.revision ?? null);
      setPolicyRevisionConflict(null);
      setPolicyError(null);
    }
  }, [discardDraftSignal]);

  // Dirty checks for Metadata & Policy
  const isMetaDirty = useMemo(() => {
    if (!device) return false;
    return (
      deviceName.trim() !== (device.metadata?.device_name ?? '') ||
      repName.trim() !== (device.metadata?.rep_name ?? '')
    );
  }, [device, deviceName, repName]);

  const isPolicyDirty = useMemo(() => {
    if (!device) return false;
    const savedTethering = device.policy?.block_tethering ?? true;
    const savedBlocked = device.policy?.blocked_apps ?? [];
    if (blockTethering !== savedTethering) return true;
    if (blockedApps.length !== savedBlocked.length) return true;
    const sortedA = [...blockedApps].sort();
    const sortedB = [...savedBlocked].sort();
    return JSON.stringify(sortedA) !== JSON.stringify(sortedB);
  }, [device, blockTethering, blockedApps]);

  const hasAnyUnsavedChanges = isMetaDirty || isPolicyDirty || kioskDirty;

  useEffect(() => {
    onDirtyChange?.(hasAnyUnsavedChanges);
  }, [hasAnyUnsavedChanges, onDirtyChange]);

  useEffect(() => {
    return () => {
      onDirtyChange?.(false);
    };
  }, [onDirtyChange]);

  const deviceLogs = useMemo(() => {
    if (!device) return [];
    return auditLogs.filter((l) => l.target_uid === device.uid);
  }, [device, auditLogs]);

  const deviceMap = useMemo(() => {
    const map = new Map<string, MergedDeviceRecord>();
    allDevices.forEach((d) => map.set(d.uid, d));
    if (device) map.set(device.uid, device);
    return map;
  }, [allDevices, device]);

  // Unified app list for this device
  const unifiedDeviceApps = useMemo(() => {
    const map = new Map<
      string,
      {
        package_name: string;
        app_name: string;
        categoryLabel: string;
        description: string;
        isProtected: boolean;
        protectedReason: string | null;
        isBlocked: boolean;
        isInstalledOnDevice: boolean;
      }
    >();

    // 1. Add apps actually reported by the device (if inventory exists)
    if (appInventory && Array.isArray(appInventory.apps)) {
      for (const rep of appInventory.apps) {
        const info = lookupAppInfo(rep.package_name);
        const isHardcodedProtected =
          Boolean(HARDCODED_PROTECTED_PACKAGES[rep.package_name]) || Boolean(rep.is_protected);
        const isSystemNonLaunchable = Boolean(rep.is_system_app && !rep.has_launcher_icon);
        const isProtected = isHardcodedProtected || isSystemNonLaunchable;

        let protectedReason =
          HARDCODED_PROTECTED_PACKAGES[rep.package_name] ||
          rep.protection_reason ||
          info.protectionReason ||
          null;
        if (!protectedReason && isHardcodedProtected) {
          protectedReason = 'تطبيق أساسي أو مسؤول جهاز نشط؛ محمي من الحظر.';
        } else if (!protectedReason && isSystemNonLaunchable) {
          protectedReason = 'مكوّن نظام أساسي بدون واجهة تشغيل؛ محمي من الحظر.';
        }

        map.set(rep.package_name, {
          package_name: rep.package_name,
          app_name: rep.app_name || info.nameAr,
          categoryLabel: rep.is_system_app ? 'تطبيق نظام' : 'مثبت على الهاتف',
          description: info.descriptionAr,
          isProtected,
          protectedReason,
          isBlocked: blockedApps.includes(rep.package_name),
          isInstalledOnDevice: true,
        });
      }
    }

    // 2. Add any currently blocked apps not in reported inventory
    for (const pkg of blockedApps) {
      if (!map.has(pkg)) {
        const info = lookupAppInfo(pkg);
        map.set(pkg, {
          package_name: pkg,
          app_name: info.nameAr,
          categoryLabel: 'مضاف في قائمة الحظر',
          description: info.descriptionAr,
          isProtected: Boolean(HARDCODED_PROTECTED_PACKAGES[pkg]),
          protectedReason: HARDCODED_PROTECTED_PACKAGES[pkg] || info.protectionReason || null,
          isBlocked: true,
          isInstalledOnDevice: false,
        });
      }
    }

    // 3. If no inventory has arrived yet, also show the curated catalog as reference suggestions
    if (!appInventory || !Array.isArray(appInventory.apps) || appInventory.apps.length === 0) {
      for (const item of CURATED_APP_CATALOG) {
        if (!map.has(item.packageName)) {
          map.set(item.packageName, {
            package_name: item.packageName,
            app_name: item.nameAr,
            categoryLabel: 'دليل التطبيقات الشائعة',
            description: item.descriptionAr,
            isProtected: Boolean(HARDCODED_PROTECTED_PACKAGES[item.packageName] || item.isProtected),
            protectedReason:
              HARDCODED_PROTECTED_PACKAGES[item.packageName] || item.protectionReason || null,
            isBlocked: blockedApps.includes(item.packageName),
            isInstalledOnDevice: false,
          });
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.isBlocked !== b.isBlocked) return a.isBlocked ? -1 : 1;
      if (a.isInstalledOnDevice !== b.isInstalledOnDevice) return a.isInstalledOnDevice ? -1 : 1;
      if (a.isProtected !== b.isProtected) return a.isProtected ? 1 : -1;
      return a.app_name.localeCompare(b.app_name, 'ar');
    });
  }, [blockedApps, appInventory]);

  const filteredApps = useMemo(() => {
    const q = appSearchQuery.trim().toLowerCase();
    return unifiedDeviceApps.filter((app) => {
      if (appFilter === 'blocked' && !app.isBlocked) return false;
      if (appFilter === 'allowed' && (app.isBlocked || app.isProtected)) return false;
      if (appFilter === 'protected' && !app.isProtected) return false;
      if (!q) return true;
      return (
        app.app_name.toLowerCase().includes(q) ||
        app.package_name.toLowerCase().includes(q) ||
        app.categoryLabel.toLowerCase().includes(q)
      );
    });
  }, [unifiedDeviceApps, appSearchQuery, appFilter]);

  if (!device) return null;

  const friendlyName = getDeviceFriendlyName(device);
  const enforcementSummary = formatEnforcementSummaryAr(device);
  const lastSeenInfo = formatLastSeenAr(device.lastSeenMs);

  const resetAllLocalDrafts = () => {
    setDeviceName(device.metadata?.device_name ?? '');
    setRepName(device.metadata?.rep_name ?? '');
    setMetaEdited(false);
    setMetaError(null);
    setBlockTethering(device.policy?.block_tethering ?? true);
    setBlockedApps(device.policy?.blocked_apps ? [...device.policy.blocked_apps] : []);
    setPolicyEdited(false);
    setPinnedPolicyRevision(device.policy?.revision ?? null);
    setPolicyRevisionConflict(null);
    setPolicyError(null);
    setKioskDirty(false);
    setLocalDiscardSignal((s) => s + 1);
  };

  const guardNavigation = (action: () => void) => {
    if (hasAnyUnsavedChanges) {
      setPendingAction(() => () => {
        resetAllLocalDrafts();
        onDirtyChange?.(false);
        action();
      });
    } else {
      action();
    }
  };

  const handleTabSwitch = (nextTab: DeviceManagementTabId) => {
    if (nextTab === activeTab) return;
    if (onTabChange) {
      // Controlled by App.tsx guarded router (which guards URL hash, active tab, and form values)
      onTabChange(nextTab);
      return;
    }
    guardNavigation(() => {
      setInternalActiveTab(nextTab);
    });
  };

  const handleCopyUid = () => {
    navigator.clipboard.writeText(device.uid);
    setCopiedUid(true);
    setTimeout(() => setCopiedUid(false), 2000);
  };

  const handleCopyDiagnostics = () => {
    const diagPayload = {
      uid: device.uid,
      friendly_name: friendlyName,
      enrollment: device.enrollment,
      status: device.status,
      policy: device.policy,
      metadata: device.metadata,
      computed: {
        approvalState: device.approvalState,
        enforcementState: device.enforcementState,
        enforcementDetail: device.enforcementDetail,
        isStaleConnection: device.isStaleConnection,
      },
    };
    navigator.clipboard.writeText(JSON.stringify(diagPayload, null, 2));
    setCopiedDiag(true);
    setTimeout(() => setCopiedDiag(false), 2000);
  };

  const handleCopyPackage = (pkg: string) => {
    navigator.clipboard.writeText(pkg);
    setCopiedPkg(pkg);
    setTimeout(() => setCopiedPkg(null), 1800);
  };

  const handleMetadataSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMetaError(null);
    setMetaSuccess(null);

    if (!deviceName.trim()) {
      setMetaError('يرجى إدخال اسم الجهاز الإداري.');
      return;
    }

    setSavingMeta(true);
    try {
      await saveDeviceMetadata(db, device.uid, deviceName, repName, actor);
      setMetaEdited(false);
      setMetaSuccess('تم حفظ بيانات تعريف الجهاز بنجاح.');
    } catch (err: any) {
      setMetaError(err?.message || 'فشل حفظ البيانات التعريفية');
    } finally {
      setSavingMeta(false);
    }
  };

  const handleApprovalToggle = async (nextApproved: boolean) => {
    setApprovalError(null);
    setSavingApproval(true);
    try {
      await setDeviceApproval(db, device.uid, nextApproved, actor);
      setConfirmRevokeApproval(false);
    } catch (err: any) {
      setApprovalError(err?.message || 'فشل تحديث حالة الاعتماد');
    } finally {
      setSavingApproval(false);
    }
  };

  const savePolicyChanges = async (
    nextTethering: boolean,
    nextBlocked: string[],
    successText: string
  ) => {
    setPolicyError(null);
    setPolicySuccess(null);
    if (policyRevisionConflict) {
      setPolicyError(
        `تعارض تعديل: تم تحديث السياسة في الخادم إلى الإصدار v${policyRevisionConflict.incoming} بينما مسودتك مبنية على v${policyRevisionConflict.pinned}. راجع القيم المحدثة أولًا.`
      );
      return;
    }
    setSavingPolicy(true);
    try {
      const expectedRev = policyEdited
        ? pinnedPolicyRevision
        : device.policy
        ? device.policy.revision
        : null;
      const { savedRevision } = await saveDevicePolicyTransaction(
        db,
        device.uid,
        {
          block_tethering: nextTethering,
          blocked_apps: nextBlocked,
          expectedCurrentRevision: expectedRev,
          allowRepairCorrupted: Boolean(device.policy?.isCorrupted),
        },
        actor
      );
      setBlockedApps(nextBlocked);
      setBlockTethering(nextTethering);
      setPolicyEdited(false);
      setPinnedPolicyRevision(savedRevision);
      setPolicyRevisionConflict(null);
      setPolicySuccess(successText);
    } catch (err: any) {
      setPolicyError(err?.message || 'فشل حفظ السياسة');
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleInstantSingleAppToggle = async (pkg: string, shouldBlock: boolean) => {
    if (HARDCODED_PROTECTED_PACKAGES[pkg]) {
      setPolicyError(`التطبيق (${pkg}) محمي: ${HARDCODED_PROTECTED_PACKAGES[pkg]}`);
      return;
    }

    const nextBlocked = shouldBlock
      ? Array.from(new Set([...blockedApps, pkg]))
      : blockedApps.filter((item) => item !== pkg);

    if (nextBlocked.length > MAX_BLOCKED_APPS) {
      setPolicyError(`الحد الأقصى للتطبيقات المحظورة هو ${MAX_BLOCKED_APPS} تطبيق.`);
      return;
    }

    const info = lookupAppInfo(pkg);
    await savePolicyChanges(
      blockTethering,
      nextBlocked,
      shouldBlock
        ? `تم حفظ أمر حظر «${info.nameAr}» بالخادم، وبانتظار تأكيد الهاتف.`
        : `تم حفظ أمر السماح لتطبيق «${info.nameAr}» بالخادم، وبانتظار تأكيد الهاتف.`
    );
  };

  const handleBatchDeviceAppsAction = async (shouldBlock: boolean) => {
    if (selectedPackages.size === 0) return;

    const targets = Array.from(selectedPackages).filter(
      (pkg) => !HARDCODED_PROTECTED_PACKAGES[pkg]
    );

    const nextBlocked = shouldBlock
      ? Array.from(new Set([...blockedApps, ...targets]))
      : blockedApps.filter((item) => !targets.includes(item));

    if (nextBlocked.length > MAX_BLOCKED_APPS) {
      setPolicyError(`الحد الأقصى للتطبيقات المحظورة هو ${MAX_BLOCKED_APPS} تطبيق.`);
      return;
    }

    await savePolicyChanges(
      blockTethering,
      nextBlocked,
      shouldBlock
        ? `تم حفظ حظر (${targets.length}) تطبيق بالخادم، وبانتظار تأكيد الهاتف.`
        : `تم حفظ السماح لـ (${targets.length}) تطبيق بالخادم، وبانتظار تأكيد الهاتف.`
    );
    setSelectedPackages(new Set());
  };

  const handleAddCustomPackage = async () => {
    setPolicyError(null);
    setPolicySuccess(null);
    const trimmed = newPackageInput.trim();
    if (!trimmed) return;

    const check = validatePackageName(trimmed, blockedApps);
    if (!check.valid) {
      setPolicyError(check.error || 'اسم الحزمة غير صالح');
      return;
    }

    const nextBlocked = [...blockedApps, trimmed];
    setNewPackageInput('');
    setShowAddCustomModal(false);

    await savePolicyChanges(
      blockTethering,
      nextBlocked,
      'تمت إضافة التطبيق إلى قائمة الحظر وحفظ السياسة بالخادم، وبانتظار تأكيد الهاتف.'
    );
  };

  const handleSaveTethering = async () => {
    await savePolicyChanges(
      blockTethering,
      blockedApps,
      'تم حفظ إعدادات مشاركة الإنترنت بالخادم، وبانتظار تأكيد الهاتف.'
    );
  };

  const toggleSelectPackage = (pkg: string) => {
    const next = new Set(selectedPackages);
    if (next.has(pkg)) next.delete(pkg);
    else next.add(pkg);
    setSelectedPackages(next);
  };

  const blockedCount = unifiedDeviceApps.filter((a) => a.isBlocked).length;
  const protectedCount = unifiedDeviceApps.filter((a) => a.isProtected).length;
  const allowedCount = unifiedDeviceApps.filter((a) => !a.isBlocked && !a.isProtected).length;
  const hasRealInventory = Boolean(appInventory && Array.isArray(appInventory.apps));

  const tabs: { id: DeviceManagementTabId; label: string; badge?: string | number; icon: React.ReactNode }[] = [
    {
      id: 'overview',
      label: 'ملخص الجهاز',
      icon: <Smartphone className="w-4 h-4" />,
    },
    {
      id: 'apps',
      label: 'التطبيقات',
      badge: `${blockedApps.length} محظور`,
      icon: <AppWindow className="w-4 h-4" />,
    },
    {
      id: 'kiosk',
      label: 'شاشة الشركة',
      icon: <Shield className="w-4 h-4" />,
    },
    {
      id: 'tethering',
      label: 'مشاركة الإنترنت',
      badge: blockTethering ? 'ممنوعة' : 'مسموحة',
      icon: <WifiOff className="w-4 h-4" />,
    },
    {
      id: 'history',
      label: 'سجل الجهاز',
      badge: deviceLogs.length,
      icon: <History className="w-4 h-4" />,
    },
  ];

  return (
    <div className="space-y-6" dir="rtl">
      {/* Unsaved Changes Confirmation Modal */}
      {pendingAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-amber-100 text-amber-700 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">توجد تعديلات غير محفوظة</h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  لديك تعديلات لم يتم حفظها في صفحة هذا الجهاز. هل تريد تجاهل التعديلات ومغادرة الصفحة؟
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setPendingAction(null)}
                className="px-4 py-2 rounded-lg text-xs font-bold border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                البقاء في الصفحة
              </button>
              <button
                type="button"
                onClick={() => {
                  const act = pendingAction;
                  setPendingAction(null);
                  onDirtyChange?.(false);
                  act();
                }}
                className="px-4 py-2 rounded-lg text-xs font-bold bg-red-600 text-white hover:bg-red-700 cursor-pointer"
              >
                تجاهل التعديلات والمغادرة
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top Breadcrumb + Back Button Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white border border-slate-200 rounded-xl px-5 py-3.5 shadow-2xs">
        <nav aria-label="مسار التنقل" className="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => guardNavigation(onClose)}
            className="font-bold text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1.5 cursor-pointer"
          >
            <span>الأجهزة</span>
          </button>
          <ChevronLeft className="w-4 h-4 text-slate-400 shrink-0" />
          <span className="font-bold text-slate-900 truncate max-w-[260px] sm:max-w-md">
            {friendlyName}
          </span>
        </nav>

        <button
          type="button"
          onClick={() => guardNavigation(onClose)}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-bold bg-slate-100 text-slate-800 hover:bg-slate-200 transition-colors self-start sm:self-auto cursor-pointer"
        >
          <ArrowRight className="w-4 h-4" />
          <span>العودة إلى قائمة الأجهزة</span>
        </button>
      </div>

      {/* Full-Page Device Header Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="p-3.5 rounded-2xl bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
              <Smartphone className="w-7 h-7" />
            </div>
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-xl font-bold text-slate-900">{friendlyName}</h2>
                {device.isArchived && (
                  <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-slate-100 text-slate-700 border border-slate-300">
                    مؤرشف
                  </span>
                )}
                <ApprovalBadge state={device.approvalState} />
                <EnforcementBadge state={device.enforcementState} />
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                <span>
                  <strong className="text-slate-800">المندوب:</strong>{' '}
                  {device.metadata?.rep_name || 'غير محدد'}
                </span>
                <span>•</span>
                <span>
                  <strong className="text-slate-800">الطراز:</strong>{' '}
                  {device.status?.model || 'في انتظار بيانات الهاتف'}
                </span>
                <span>•</span>
                <span>
                  <strong className="text-slate-800">آخر تواصل:</strong>{' '}
                  {lastSeenInfo.relative} ({lastSeenInfo.formatted})
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 self-start lg:self-center">
            <StaleConnectionBadge isStale={device.isStaleConnection} />
            <DeviceOwnerBadge isOwner={device.status?.device_owner} />
          </div>
        </div>

        {/* Organized 5-Tab Bar (Wraps cleanly, no horizontal clipping) */}
        <div className="pt-3 border-t border-slate-100">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="أقسام إدارة الجهاز">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => handleTabSwitch(tab.id)}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all cursor-pointer ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'bg-slate-100/80 text-slate-700 hover:bg-slate-200/70 hover:text-slate-900'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                  {tab.badge !== undefined && (
                    <span
                      className={`px-2 py-0.5 rounded-md text-xs font-bold ${
                        isActive
                          ? 'bg-white/20 text-white'
                          : 'bg-white text-slate-600 border border-slate-200'
                      }`}
                    >
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* TAB 1: OVERVIEW (ملخص الجهاز) */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Top Grid: Sync Status + KPI Metrics */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-3">
              <h3 className="text-base font-bold text-slate-900">حالة التنفيذ والتواصل</h3>
              <p className="text-sm text-slate-700 leading-relaxed">{enforcementSummary.summary}</p>

              {device.status?.error && (
                <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900 space-y-1.5">
                  <div className="flex items-center gap-2 font-bold text-red-800">
                    <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
                    <span>أبلغ الهاتف عن مشكلة أثناء تطبيق السياسة</span>
                  </div>
                  <p className="text-red-700 leading-relaxed">
                    تأكد من تفعيل صلاحية إدارة الجهاز على الهاتف واتصاله بالإنترنت.
                  </p>
                  <details className="pt-1">
                    <summary className="cursor-pointer font-semibold text-red-800 hover:underline">
                      عرض رسالة الخطأ التقنية الواردة من الهاتف
                    </summary>
                    <pre className="mt-1.5 p-2 rounded bg-white/90 border border-red-200 font-mono text-[11px] text-red-900 overflow-x-auto" dir="ltr">
                      {device.status.error}
                    </pre>
                  </details>
                </div>
              )}

              <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                <span>آخر تواصل مسجل: {lastSeenInfo.relative}</span>
                <span>الوقت الدقيق: {lastSeenInfo.formatted}</span>
              </div>
            </div>

            <div className="lg:col-span-5 grid grid-cols-2 gap-3">
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
                <span className="text-xs font-semibold text-slate-500">البطارية</span>
                <span className="text-xl font-bold text-slate-900 mt-1">
                  {device.status?.battery_percent !== undefined && device.status?.battery_percent >= 0
                    ? `${device.status.battery_percent}%`
                    : 'غير متوفر'}
                </span>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
                <span className="text-xs font-semibold text-slate-500">نظام أندرويد</span>
                <span className="text-base font-bold text-slate-900 mt-1" dir="ltr">
                  {device.status?.android_sdk
                    ? formatAndroidSdk(device.status.android_sdk)
                    : 'غير متوفر'}
                </span>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
                <span className="text-xs font-semibold text-slate-500">إصدار تطبيق الحماية</span>
                <span className="text-base font-bold text-slate-900 font-mono mt-1" dir="ltr">
                  {device.status?.agent_version || '—'}
                </span>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
                <span className="text-xs font-semibold text-slate-500">رقم الإصدار المطبق</span>
                <span className="text-base font-bold text-slate-900 mt-1">
                  {device.status?.applied_revision !== undefined && device.status.applied_revision > 0
                    ? `الإصدار ${device.status.applied_revision}`
                    : 'لم يطبق بعد'}
                </span>
              </div>
            </div>
          </div>

          {/* Two-Column Form Row: Administrative Identity + Device Approval */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Administrative Metadata Form */}
            <form
              onSubmit={handleMetadataSubmit}
              className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-base font-bold text-slate-900">التعريف الإداري للجهاز</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    حدد اسماً واضحاً للجهاز واسم المندوب المسؤول عنه لسهولة المتابعة في اللوحة وسجل العمليات.
                  </p>
                </div>
                {isMetaDirty && (
                  <span className="px-2.5 py-1 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs font-bold">
                    تعديلات غير محفوظة
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    اسم الجهاز الإداري
                  </label>
                  <input
                    type="text"
                    value={deviceName}
                    onChange={(e) => {
                      setMetaEdited(true);
                      setDeviceName(e.target.value);
                    }}
                    placeholder="مثال: هاتف مندوب الرياض 1"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:border-blue-600 focus:ring-2 focus:ring-blue-500/20 outline-hidden"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    اسم المندوب المسؤول
                  </label>
                  <input
                    type="text"
                    value={repName}
                    onChange={(e) => {
                      setMetaEdited(true);
                      setRepName(e.target.value);
                    }}
                    placeholder="مثال: أحمد العتيبي"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:border-blue-600 focus:ring-2 focus:ring-blue-500/20 outline-hidden"
                  />
                </div>
              </div>

              {metaError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{metaError}</span>
                </div>
              )}

              {metaSuccess && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-700 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{metaSuccess}</span>
                </div>
              )}

              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={savingMeta}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <Save className="w-4 h-4" />
                  <span>{savingMeta ? 'جارٍ الحفظ...' : 'حفظ بيانات الجهاز'}</span>
                </button>
              </div>
            </form>

            {/* Approval Control Card */}
            <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">اعتماد الجهاز في النظام</h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  {device.approvalState === 'approved'
                    ? 'الجهاز معتمد حالياً ومسموح له باستلام السياسات وإرسال تقارير الحالة.'
                    : 'الجهاز غير معتمد حالياً؛ لن يتمكن الهاتف من قراءة السياسات حتى يتم اعتماده.'}
                </p>
              </div>

              {approvalError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {approvalError}
                </div>
              )}

              {device.approvalState === 'approved' ? (
                !confirmRevokeApproval ? (
                  <button
                    type="button"
                    onClick={() => setConfirmRevokeApproval(true)}
                    className="w-full px-4 py-2.5 rounded-xl text-xs font-bold bg-amber-50 text-amber-900 border border-amber-300 hover:bg-amber-100 transition-colors cursor-pointer"
                  >
                    سحب اعتماد الجهاز...
                  </button>
                ) : (
                  <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 space-y-3">
                    <p className="text-xs text-amber-950 font-semibold leading-relaxed">
                      هل أنت متأكد من سحب اعتماد هذا الجهاز؟ سيتوقف الهاتف عن مزامنة السياسات الجديدة، مع بقاء القيود المطبقة حالياً على الهاتف.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={savingApproval}
                        onClick={() => handleApprovalToggle(false)}
                        className="flex-1 px-3 py-2 rounded-lg text-xs font-bold bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-50 cursor-pointer"
                      >
                        {savingApproval ? 'جارٍ التنفيذ...' : 'تأكيد سحب الاعتماد'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRevokeApproval(false)}
                        className="px-3 py-2 rounded-lg text-xs font-bold bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 cursor-pointer"
                      >
                        إلغاء
                      </button>
                    </div>
                  </div>
                )
              ) : (
                <button
                  type="button"
                  disabled={savingApproval}
                  onClick={() => handleApprovalToggle(true)}
                  className="w-full px-4 py-3 rounded-xl text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors shadow-xs cursor-pointer"
                >
                  {savingApproval ? 'جارٍ الاعتماد...' : 'اعتماد الجهاز الآن'}
                </button>
              )}
            </div>
          </div>

          {/* Device Visibility & Archiving Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-900">إدارة ظهور الجهاز في القائمة</h3>
                {device.isArchived && (
                  <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-slate-100 text-slate-700 border border-slate-300">
                    مؤرشف حالياً
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-600 max-w-2xl leading-relaxed">
                {device.isArchived
                  ? 'هذا الجهاز مؤرشف حالياً ومخفي من القائمة الرئيسية والعدادات. إدارته وقيوده ومزامنته مستمرة على الهاتف كما هي.'
                  : 'يمكنك إزالة الجهاز من القائمة الرئيسية لإخفائه عن العرض اليومي، مع بقاء إدارته وقيوده على الهاتف كما هي.'}
              </p>
              {archiveError && (
                <div className="text-xs text-red-600 font-semibold pt-1">{archiveError}</div>
              )}
              {archiveSuccess && (
                <div className="text-xs text-emerald-700 font-semibold pt-1">{archiveSuccess}</div>
              )}
            </div>

            <div className="shrink-0">
              {device.isArchived ? (
                <button
                  type="button"
                  disabled={savingArchive}
                  onClick={() => handleArchiveToggle(false)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 transition-colors shadow-xs cursor-pointer"
                >
                  <ArchiveRestore className="w-4 h-4" />
                  <span>{savingArchive ? 'جارٍ الاستعادة...' : 'استعادة الجهاز'}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowArchiveConfirmModal(true)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 border border-slate-300 hover:bg-slate-200 transition-colors cursor-pointer"
                >
                  <Archive className="w-4 h-4" />
                  <span>إزالة الجهاز من القائمة</span>
                </button>
              )}
            </div>
          </div>

          {/* Collapsed Technical Details Section (تفاصيل تقنية) */}
          <details className="bg-white border border-slate-200 rounded-xl shadow-2xs group">
            <summary className="px-5 py-4 flex items-center justify-between cursor-pointer list-none select-none">
              <div className="flex items-center gap-2.5">
                <Code2 className="w-4.5 h-4.5 text-slate-500" />
                <span className="text-sm font-bold text-slate-800">تفاصيل تقنية ومعلومات التشخيص</span>
                <span className="text-xs text-slate-500">(معرف الجهاز، نسخ السياسات، والبيانات الخام)</span>
              </div>
              <span className="text-xs font-bold text-blue-600 group-open:rotate-180 transition-transform">
                ▼
              </span>
            </summary>

            <div className="px-5 pb-5 pt-2 border-t border-slate-100 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-slate-600">المعرف التقني للجهاز (Device UID)</div>
                  <div className="font-mono text-xs text-slate-900 select-all" dir="ltr">
                    {device.uid}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyUid}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 cursor-pointer"
                  >
                    {copiedUid ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedUid ? 'تم نسخ المعرف' : 'نسخ المعرف'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyDiagnostics}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 cursor-pointer"
                  >
                    {copiedDiag ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedDiag ? 'تم نسخ التشخيص' : 'نسخ معلومات التشخيص'}</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                  <div className="font-bold text-slate-800 border-b border-slate-200 pb-1.5">
                    معلومات الجهاز والنظام
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">الطراز:</span>
                    <span className="font-mono text-slate-900" dir="ltr">
                      {device.status?.model ?? '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">مستوى Android SDK:</span>
                    <span className="font-mono text-slate-900" dir="ltr">
                      {device.status?.android_sdk ?? '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">إصدار الوكيل:</span>
                    <span className="font-mono text-slate-900" dir="ltr">
                      {device.status?.agent_version ?? '—'}
                    </span>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                  <div className="font-bold text-slate-800 border-b border-slate-200 pb-1.5">
                    معلومات المزامنة والسياسة
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">إصدار السياسة بالخادم:</span>
                    <span className="font-mono text-slate-900">{device.policy?.revision ?? '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">الإصدار المطبق بالهاتف:</span>
                    <span className="font-mono text-slate-900">{device.status?.applied_revision ?? '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">التشخيص الكامل:</span>
                    <span className="text-slate-900 truncate max-w-[200px]" title={device.enforcementDetail}>
                      {device.enforcementDetail}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </details>
        </div>
      )}

      {/* TAB 2: APPS (التطبيقات) */}
      {activeTab === 'apps' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-5">
          {/* Header & Inventory Status Bar */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 className="text-base font-bold text-slate-900">إدارة تطبيقات الجهاز</h3>
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold border ${
                    hasRealInventory
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : 'bg-amber-50 text-amber-800 border-amber-200'
                  }`}
                >
                  {inventoryLoading
                    ? 'جارٍ قراءة جرد الهاتف...'
                    : hasRealInventory
                    ? `جرد فعلي من الهاتف (${appInventory?.apps.length ?? 0} تطبيق)`
                    : 'لم يصل جرد فعلي من الهاتف بعد'}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                {hasRealInventory
                  ? `آخر تحديث لجرد التطبيقات من الهاتف: ${
                      formatTimestampAr(appInventory?.reported_at?.toMillis?.() ?? null).formatted
                    }. يمكنك حظر أو السماح بالتطبيقات مباشرة.`
                  : 'يعرض هذا القسم التطبيقات المحظورة في السياسة الحالية بالإضافة إلى دليل التطبيقات الشائعة كمرجع لحين وصول جرد الهاتف الفعلي.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 self-start lg:self-center">
              <button
                type="button"
                onClick={() => setShowPackageNames(!showPackageNames)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>{showPackageNames ? 'إخفاء معرف الحزمة' : 'إظهار معرف الحزمة'}</span>
              </button>
              <button
                type="button"
                onClick={() => setShowAddCustomModal(!showAddCustomModal)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-700 transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>إضافة تطبيق للحظر بمعرف الحزمة</span>
              </button>
            </div>
          </div>

          {inventoryError && (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              <div>
                <span className="font-bold">تنبيه قراءة جرد التطبيقات:</span> تعذر قراءة الجرد الفعلي من الخادم ({inventoryError}).
              </div>
            </div>
          )}

          {/* Custom Package Inline Form */}
          {showAddCustomModal && (
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-900">
                  حظر تطبيق إضافي عبر معرف الحزمة (Package Name)
                </h4>
                <button
                  type="button"
                  onClick={() => setShowAddCustomModal(false)}
                  className="text-xs text-slate-500 hover:text-slate-700 font-bold cursor-pointer"
                >
                  إغلاق
                </button>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  dir="ltr"
                  value={newPackageInput}
                  onChange={(e) => setNewPackageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleAddCustomPackage();
                    }
                  }}
                  placeholder="com.example.app"
                  className="flex-1 px-3.5 py-2 text-sm font-mono rounded-lg border border-slate-300 bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-500/20 outline-hidden"
                />
                <button
                  type="button"
                  disabled={savingPolicy}
                  onClick={() => void handleAddCustomPackage()}
                  className="px-4 py-2 rounded-lg text-xs font-bold bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  حظر وحفظ بالسياسة
                </button>
              </div>
            </div>
          )}

          {/* Feedback Banners */}
          {policyError && (
            <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{policyError}</span>
            </div>
          )}

          {policySuccess && (
            <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              <span>{policySuccess}</span>
            </div>
          )}

          {/* Search & Filter Controls */}
          <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={appSearchQuery}
                onChange={(e) => setAppSearchQuery(e.target.value)}
                placeholder="ابحث باسم التطبيق..."
                className="w-full pr-10 pl-4 py-2.5 text-sm rounded-xl border border-slate-300 bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-500/20 outline-hidden"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 p-1 rounded-xl">
              <button
                type="button"
                onClick={() => setAppFilter('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  appFilter === 'all'
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                الكل ({unifiedDeviceApps.length})
              </button>
              <button
                type="button"
                onClick={() => setAppFilter('blocked')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  appFilter === 'blocked'
                    ? 'bg-red-600 text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                محظور ({blockedCount}/{MAX_BLOCKED_APPS})
              </button>
              <button
                type="button"
                onClick={() => setAppFilter('allowed')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  appFilter === 'allowed'
                    ? 'bg-emerald-600 text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {hasRealInventory ? `مسموح (${allowedCount})` : `غير محظور (${allowedCount})`}
              </button>
              <button
                type="button"
                onClick={() => setAppFilter('protected')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  appFilter === 'protected'
                    ? 'bg-blue-600 text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                محمي للنظام ({protectedCount})
              </button>
            </div>
          </div>

          {/* Batch Selection Bar */}
          {selectedPackages.size > 0 && (
            <div className="p-3.5 rounded-xl bg-slate-900 text-white flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs font-bold">
                تم تحديد {selectedPackages.size} تطبيق
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={savingPolicy}
                  onClick={() => void handleBatchDeviceAppsAction(false)}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 cursor-pointer"
                >
                  السماح بالمحدد
                </button>
                <button
                  type="button"
                  disabled={savingPolicy}
                  onClick={() => void handleBatchDeviceAppsAction(true)}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-500 text-white disabled:opacity-50 cursor-pointer"
                >
                  حظر المحدد
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedPackages(new Set())}
                  className="px-2.5 py-1.5 rounded-lg text-xs text-slate-300 hover:text-white cursor-pointer"
                >
                  إلغاء التحديد
                </button>
              </div>
            </div>
          )}

          {/* Wide Responsive Grid of Applications */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredApps.map((app) => {
              const isSelected = selectedPackages.has(app.package_name);
              return (
                <div
                  key={app.package_name}
                  className={`flex flex-col justify-between p-4 rounded-xl border transition-all ${
                    app.isBlocked
                      ? 'bg-red-50/40 border-red-200'
                      : app.isProtected
                      ? 'bg-slate-50/70 border-slate-200'
                      : 'bg-white border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {!app.isProtected ? (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectPackage(app.package_name)}
                          className="mt-1.5 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer shrink-0"
                        />
                      ) : (
                        <div className="mt-1.5 w-4 h-4 shrink-0" />
                      )}

                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold shrink-0 ${
                          app.isBlocked
                            ? 'bg-red-100 text-red-800 border border-red-200'
                            : app.isProtected
                            ? 'bg-blue-50 text-blue-700 border border-blue-200'
                            : 'bg-slate-100 text-slate-700 border border-slate-200'
                        }`}
                      >
                        {(app.app_name || '?').trim().charAt(0).toUpperCase()}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h4 className="text-sm font-bold text-slate-900 truncate">
                            {app.app_name}
                          </h4>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          {app.isProtected ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                              <Lock className="w-3 h-3" />
                              محمي للنظام
                            </span>
                          ) : app.isBlocked ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-red-100 text-red-800 border border-red-200">
                              محظور بالسياسة
                            </span>
                          ) : app.isInstalledOnDevice ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                              مثبت ومسموح
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                              غير مدرج بالحظر (مقترح)
                            </span>
                          )}
                        </div>

                        {app.isProtected && app.protectedReason && (
                          <p className="text-[11px] text-blue-700 mt-1.5 leading-relaxed">
                            {app.protectedReason}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Action Button */}
                    <div className="shrink-0">
                      {app.isProtected ? (
                        <span className="text-[11px] font-semibold text-slate-400 px-2 py-1">
                          محمي
                        </span>
                      ) : app.isBlocked ? (
                        <button
                          type="button"
                          disabled={savingPolicy}
                          onClick={() => void handleInstantSingleAppToggle(app.package_name, false)}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors shadow-2xs cursor-pointer"
                        >
                          السماح
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={savingPolicy}
                          onClick={() => void handleInstantSingleAppToggle(app.package_name, true)}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50 transition-colors cursor-pointer"
                        >
                          حظر التطبيق
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Optional / Collapsible Package Name Details */}
                  {showPackageNames ? (
                    <div className="mt-3 pt-2.5 border-t border-slate-200/70 flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-slate-500 truncate" dir="ltr">
                        {app.package_name}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyPackage(app.package_name)}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800 shrink-0 cursor-pointer"
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
                    <details className="mt-2 pt-1.5 border-t border-slate-100 text-[11px] text-slate-400">
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
                          className="text-blue-600 hover:underline font-semibold shrink-0 cursor-pointer"
                        >
                          {copiedPkg === app.package_name ? 'تم النسخ' : 'نسخ'}
                        </button>
                      </div>
                    </details>
                  )}
                </div>
              );
            })}

            {filteredApps.length === 0 && (
              <div className="col-span-full py-12 text-center text-sm text-slate-500 bg-slate-50 rounded-xl border border-slate-200">
                لا توجد تطبيقات تطابق البحث أو التصفية الحالية.
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: KIOSK (شاشة الشركة) — kept mounted while viewing device to preserve state */}
      <div className={activeTab === 'kiosk' ? 'block' : 'hidden'}>
        <KioskPanel
          db={db}
          uid={device.uid}
          actor={actor}
          approved={device.approvalState === 'approved'}
          status={device.status}
          devicePolicy={device.policy}
          inventory={appInventory}
          discardDraftSignal={effectiveDiscardSignal}
          onDirtyChange={setKioskDirty}
          onNavigateAdvancedSettings={onNavigateAdvancedSettings}
        />
      </div>

      {/* TAB 4: TETHERING (مشاركة الإنترنت) */}
      {activeTab === 'tethering' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-6 max-w-3xl">
          {policyRevisionConflict && (
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 flex items-center justify-between gap-3 text-xs text-amber-950">
              <div>
                <p className="font-bold">
                  تعارض إصدارات: وصلت سياسة أحدث من الخادم (الإصدار v{policyRevisionConflict.incoming} بينما مسودتك على v{policyRevisionConflict.pinned ?? 0}).
                </p>
                <p className="mt-0.5 text-amber-800">
                  تم الحفاظ على تعديلاتك الحالية ولم تُستبدل تلقائيًا.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setBlockTethering(device.policy?.block_tethering ?? true);
                  setBlockedApps(device.policy?.blocked_apps ? [...device.policy.blocked_apps] : []);
                  setPolicyEdited(false);
                  setPinnedPolicyRevision(device.policy?.revision ?? null);
                  setPolicyRevisionConflict(null);
                }}
                className="px-3 py-1.5 rounded-lg bg-amber-800 text-white font-bold shrink-0 cursor-pointer"
              >
                اعتماد نسخة الخادم
              </button>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-100">
            <div className="space-y-1">
              <h3 className="text-base font-bold text-slate-900">التحكم في مشاركة الإنترنت ونقطة الاتصال</h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                عند تفعيل المنع، يوقف الهاتف نقطة الاتصال اللاسلكية (Wi-Fi Hotspot) ومشاركة الإنترنت عبر البلوتوث أو الكابل لمنع استهلاك باقة بيانات العمل.
              </p>
            </div>

            <div className="flex items-center gap-3 bg-slate-50 px-4 py-2.5 rounded-xl border border-slate-200 shrink-0">
              <span className="text-xs font-bold text-slate-700">منع مشاركة الإنترنت:</span>
              <button
                type="button"
                role="switch"
                aria-checked={blockTethering}
                onClick={() => {
                  if (!policyEdited) {
                    setPolicyEdited(true);
                    setPinnedPolicyRevision(device.policy?.revision ?? null);
                  }
                  setBlockTethering(!blockTethering);
                }}
                className={`relative inline-flex h-7 w-13 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                  blockTethering ? 'bg-blue-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                    blockTethering ? '-translate-x-6' : 'translate-x-0'
                  }`}
                />
              </button>
              <span className={`text-xs font-bold ${blockTethering ? 'text-blue-700' : 'text-slate-500'}`}>
                {blockTethering ? 'ممنوعة' : 'مسموحة'}
              </span>
            </div>
          </div>

          {/* Comparison Cards in Plain Arabic */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
              <span className="text-xs font-semibold text-slate-500">الإعداد المحفوظ في الخادم</span>
              <div className="text-sm font-bold text-slate-900">
                {device.policy === null
                  ? 'لم تُحفظ سياسة بعد'
                  : device.policy.block_tethering
                  ? 'مشاركة الإنترنت ممنوعة'
                  : 'مشاركة الإنترنت مسموحة'}
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
              <span className="text-xs font-semibold text-slate-500">حالة التأكيد من الهاتف</span>
              <div className="text-sm font-bold text-slate-900">
                {device.enforcementState === 'applied'
                  ? 'مؤكدة ومطبقة على الهاتف'
                  : device.enforcementState === 'pending'
                  ? 'بانتظار تأكيد الهاتف'
                  : device.enforcementState === 'error'
                  ? 'أبلغ الهاتف عن مشكلة في التطبيق'
                  : 'لم يطبق بعد'}
              </div>
            </div>
          </div>

          {policyError && (
            <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{policyError}</span>
            </div>
          )}

          {policySuccess && (
            <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              <span>{policySuccess}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              disabled={savingPolicy}
              onClick={() => void handleSaveTethering()}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-xs cursor-pointer"
            >
              <Save className="w-4 h-4" />
              <span>{savingPolicy ? 'جارٍ الحفظ...' : 'حفظ إعدادات مشاركة الإنترنت'}</span>
            </button>
          </div>
        </div>
      )}

      {/* TAB 5: HISTORY (سجل الجهاز) */}
      {activeTab === 'history' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">سجل عمليات هذا الجهاز</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                جميع التعديلات الإدارية المسجلة على هذا الجهاز مرتبة من الأحدث إلى الأقدم.
              </p>
            </div>
            <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold">
              {deviceLogs.length} عملية
            </span>
          </div>

          {deviceLogs.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-500 bg-slate-50 rounded-xl border border-slate-200">
              لا توجد عمليات مسجلة لهذا الجهاز حتى الآن.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-bold text-slate-600">
                    <th className="py-3 px-4">الوقت</th>
                    <th className="py-3 px-4">المدير</th>
                    <th className="py-3 px-4">الإجراء</th>
                    <th className="py-3 px-4">ملخص التغيير</th>
                    <th className="py-3 px-4">التفاصيل التقنية</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {deviceLogs.map((log) => {
                    const tsInfo = formatTimestampAr(log.created_at?.toMillis?.() ?? null);
                    return (
                      <tr key={log.id} className="hover:bg-slate-50/80 transition-colors align-top">
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <div className="font-bold text-slate-900">{tsInfo.relative}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">{tsInfo.formatted}</div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-slate-800" dir="ltr">{log.actor_email}</div>
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <span className="inline-flex px-2.5 py-1 rounded-md text-xs font-bold bg-blue-50 text-blue-800 border border-blue-200">
                            {ACTION_LABELS[log.action] || log.action}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-slate-800 leading-relaxed max-w-md">
                          {formatAuditLogSummaryAr(log, deviceMap)}
                        </td>
                        <td className="py-3.5 px-4">
                          <details className="text-xs">
                            <summary className="cursor-pointer text-blue-600 hover:text-blue-800 font-bold select-none">
                              عرض القيم الخام
                            </summary>
                            <div className="mt-2 p-2.5 rounded-lg bg-slate-900 text-slate-100 font-mono text-[11px] space-y-2 max-w-xs overflow-x-auto" dir="ltr">
                              <div>
                                <span className="text-slate-400 block">Before:</span>
                                <pre>{JSON.stringify(log.before, null, 2)}</pre>
                              </div>
                              <div>
                                <span className="text-slate-400 block">After:</span>
                                <pre>{JSON.stringify(log.after, null, 2)}</pre>
                              </div>
                            </div>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Archiving Confirmation Modal */}
      {showArchiveConfirmModal && device && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 space-y-4 text-right" dir="rtl">
            <div className="flex items-center gap-3 text-slate-900 font-bold text-base">
              <div className="p-2.5 rounded-xl bg-slate-100 text-slate-700 shrink-0">
                <Archive className="w-5 h-5" />
              </div>
              <span>إزالة الجهاز من القائمة الرئيسية</span>
            </div>

            <div className="space-y-3 text-sm text-slate-700 leading-relaxed">
              <div className="font-bold text-slate-900">
                اسم الجهاز: {friendlyName}
              </div>
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-950 font-semibold leading-relaxed">
                سيُخفى الجهاز من القائمة الرئيسية، وستبقى إدارته وقيوده على الهاتف كما هي
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                لن يتم حذف أي وثائق أو تسجيلات أو حسابات. يمكنك استعادة ظهور الجهاز في أي وقت عبر تبويب «الأجهزة المؤرشفة».
              </p>
            </div>

            {archiveError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {archiveError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowArchiveConfirmModal(false)}
                className="px-4 py-2.5 rounded-xl text-xs font-bold bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 transition-colors cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={savingArchive}
                onClick={() => handleArchiveToggle(true)}
                className="px-5 py-2.5 rounded-xl text-xs font-bold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors shadow-xs cursor-pointer"
              >
                {savingArchive ? 'جارٍ الإزالة...' : 'تأكيد إزالة الجهاز من القائمة'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
