import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import {
  ShieldAlert,
  LogOut,
  Settings,
} from 'lucide-react';
import type {
  AdminIdentity,
  AuditLogDoc,
  BulkActionType,
  DeviceMetadataDoc,
  DeviceStatusDoc,
  EnrollmentDoc,
  PolicyDoc,
} from './types/mdm';
import {
  getFirebaseServices,
  resolveFirebaseConfig,
  translateFirestoreErrorAr,
} from './services/firebaseClient';
import {
  reloadUserAndVerifyAdmin,
  saveDeviceMetadata,
  saveDevicePolicyTransaction,
  setDeviceApproval,
  subscribeToFleetData,
  verifyAdminIdentity,
} from './services/mdmService';
import { buildMergedDevices } from './utils/validation';
import { AdminAuthScreen } from './components/AdminAuthScreen';
import { OverviewTab } from './components/OverviewTab';
import { DevicesTab, type DeviceFilterKey } from './components/DevicesTab';
import { FleetAppsTab } from './components/FleetAppsTab';
import { AuditLogTab } from './components/AuditLogTab';
import { SettingsTab } from './components/SettingsTab';

export type NavTab =
  | 'overview'
  | 'devices'
  | 'apps'
  | 'audit'
  | 'settings';

export default function App() {
  const [configVersion, setConfigVersion] = useState(0);
  const resolution = useMemo(() => resolveFirebaseConfig(), [configVersion]);
  const services = useMemo(() => getFirebaseServices(), [configVersion]);

  const [activeTab, setActiveTab] = useState<NavTab>(
    resolution.isConfigured ? 'overview' : 'settings'
  );
  const [deviceFilter, setDeviceFilter] = useState<DeviceFilterKey>('all');
  const [selectedDeviceUid, setSelectedDeviceUid] = useState<string | null>(null);
  const [externalBulkAction, setExternalBulkAction] = useState<{
    type: BulkActionType;
    params?: { packages?: string[]; allowTethering?: boolean };
  } | null>(null);

  // Auth & Admin verification state
  const [authLoading, setAuthLoading] = useState<boolean>(Boolean(services));
  const [adminIdentity, setAdminIdentity] = useState<AdminIdentity | null>(null);

  // Monotonic sequence counter to prevent stale async auth checks from overwriting newer sessions
  const authCheckSeqRef = useRef<number>(0);

  // Real Firestore collections state (never mock data)
  const [enrollments, setEnrollments] = useState<Record<string, EnrollmentDoc>>({});
  const [policies, setPolicies] = useState<Record<string, PolicyDoc>>({});
  const [statuses, setStatuses] = useState<Record<string, DeviceStatusDoc>>({});
  const [metadataMap, setMetadataMap] = useState<Record<string, DeviceMetadataDoc>>({});
  const [auditLogs, setAuditLogs] = useState<AuditLogDoc[]>([]);
  const [dataLoading, setDataLoading] = useState<boolean>(false);
  const [dataLoadedOnce, setDataLoadedOnce] = useState<boolean>(false);
  const [permissionBanner, setPermissionBanner] = useState<string | null>(null);

  // Periodic clock tick every 30s solely for relative time & stale connection calculation (no Firestore reads)
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // Listen to Firebase Auth state when configured, guarding against stale session race conditions
  useEffect(() => {
    authCheckSeqRef.current += 1;
    const effectBaseSeq = authCheckSeqRef.current;

    if (!services) {
      setAuthLoading(false);
      setAdminIdentity(null);
      return;
    }

    setAuthLoading(true);
    let cancelled = false;

    const unsub = onAuthStateChanged(services.auth, async (user) => {
      authCheckSeqRef.current += 1;
      const currentCheckSeq = authCheckSeqRef.current;

      if (!user) {
        if (!cancelled && currentCheckSeq === authCheckSeqRef.current) {
          setAdminIdentity(null);
          setAuthLoading(false);
        }
        return;
      }

      const targetUid = user.uid;

      // Disallow Anonymous accounts on the Admin Web Console immediately
      if (user.isAnonymous) {
        await signOut(services.auth);
        if (!cancelled && currentCheckSeq === authCheckSeqRef.current) {
          setAdminIdentity(null);
          setAuthLoading(false);
        }
        return;
      }

      try {
        const verified = await verifyAdminIdentity(services.db, user, false);
        // Only apply result if session has not changed or signed out while awaiting
        if (
          !cancelled &&
          currentCheckSeq === authCheckSeqRef.current &&
          services.auth.currentUser?.uid === targetUid
        ) {
          setAdminIdentity(verified);
          setAuthLoading(false);
        }
      } catch {
        if (
          !cancelled &&
          currentCheckSeq === authCheckSeqRef.current &&
          services.auth.currentUser?.uid === targetUid
        ) {
          setAdminIdentity({
            uid: user.uid,
            email: user.email || '',
            emailVerified: user.emailVerified === true,
            isAnonymous: user.isAnonymous,
            hasCustomAdminClaim: false,
            hasAdminDocRecord: false,
            adminDocCheckStatus: 'network_or_unavailable',
            adminDocCheckDetail: 'تعذر إتمام التحقق من الصلاحية.',
            isAuthorizedAdmin: false,
            signInProvider: 'unknown',
          });
          setAuthLoading(false);
        }
      }
    });

    return () => {
      cancelled = true;
      if (authCheckSeqRef.current === effectBaseSeq) {
        authCheckSeqRef.current += 1;
      }
      unsub();
    };
  }, [services]);

  const handleReloadAndVerify = useCallback(async () => {
    if (!services?.auth.currentUser) return;
    authCheckSeqRef.current += 1;
    const checkSeq = authCheckSeqRef.current;
    const currentUser = services.auth.currentUser;
    const expectedUid = currentUser.uid;

    const verified = await reloadUserAndVerifyAdmin(services.db, currentUser);
    if (
      checkSeq === authCheckSeqRef.current &&
      services.auth.currentUser?.uid === expectedUid
    ) {
      setAdminIdentity(verified);
    }
  }, [services]);

  // Attach single set of Firestore listeners ONLY when user is a verified Admin,
  // and re-initialize cleanly whenever the verified Admin UID changes!
  useEffect(() => {
    setEnrollments({});
    setPolicies({});
    setStatuses({});
    setMetadataMap({});
    setAuditLogs([]);
    setDataLoadedOnce(false);
    setPermissionBanner(null);

    if (!services || !adminIdentity?.isAuthorizedAdmin || !adminIdentity.uid) {
      setDataLoading(false);
      return;
    }

    setDataLoading(true);
    let active = true;

    const unsub = subscribeToFleetData(services.db, {
      onEnrollments: (map) => {
        if (!active) return;
        setEnrollments(map);
        setDataLoading(false);
        setDataLoadedOnce(true);
      },
      onPolicies: (map) => {
        if (!active) return;
        setPolicies(map);
        setDataLoading(false);
        setDataLoadedOnce(true);
      },
      onStatuses: (map) => {
        if (!active) return;
        setStatuses(map);
        setDataLoading(false);
        setDataLoadedOnce(true);
      },
      onMetadata: (map) => {
        if (!active) return;
        setMetadataMap(map);
      },
      onAuditLogs: (logs) => {
        if (!active) return;
        setAuditLogs(logs);
      },
      onPermissionError: (_msg, rawError) => {
        if (!active) return;
        setDataLoading(false);
        setPermissionBanner(translateFirestoreErrorAr(rawError));
      },
    });

    return () => {
      active = false;
      unsub();
    };
  }, [services, adminIdentity?.uid, adminIdentity?.isAuthorizedAdmin]);

  // Merge records by UID across enrollments, policies, deviceStatus, and deviceMetadata
  const mergedDevices = useMemo(
    () => buildMergedDevices(enrollments, policies, statuses, metadataMap, nowMs),
    [enrollments, policies, statuses, metadataMap, nowMs]
  );

  // Precise status label distinguishing config saved, signed in, authorized, and data loaded
  const connectionStateLabel = useMemo(() => {
    if (!resolution.isConfigured || !services) {
      return 'غير مهيأ (بانتظار إعدادات Firebase)';
    }
    if (authLoading) {
      return 'إعدادات محفوظة (جارٍ فحص الجلسة...)';
    }
    if (!adminIdentity) {
      return 'إعدادات محفوظة (بانتظار تسجيل الدخول)';
    }
    if (!adminIdentity.emailVerified) {
      return 'تم تسجيل الدخول (بانتظار توثيق البريد)';
    }
    if (!adminIdentity.isAuthorizedAdmin) {
      return 'تم تسجيل الدخول (بانتظار اعتماد المسؤول)';
    }
    if (dataLoading && !dataLoadedOnce) {
      return 'صلاحية مؤكدة (جارٍ تحميل البيانات...)';
    }
    return 'صلاحية مؤكدة (البيانات محمّلة)';
  }, [
    resolution.isConfigured,
    services,
    authLoading,
    adminIdentity,
    dataLoading,
    dataLoadedOnce,
  ]);

  // Handlers passed to tabs
  const handleApproveDevice = async (
    uid: string,
    approved: boolean,
    optionalMetadata?: { device_name: string; rep_name: string }
  ) => {
    if (!services || !adminIdentity?.isAuthorizedAdmin) {
      throw new Error('غير مصرح بالكتابة قبل التحقق من صلاحية المسؤول.');
    }
    try {
      await setDeviceApproval(services.db, uid, approved, adminIdentity, optionalMetadata);
    } catch (err) {
      throw new Error(translateFirestoreErrorAr(err));
    }
  };

  const handleSaveMetadata = async (
    uid: string,
    deviceName: string,
    repName: string
  ) => {
    if (!services || !adminIdentity?.isAuthorizedAdmin) {
      throw new Error('غير مصرح بالكتابة قبل التحقق من صلاحية المسؤول.');
    }
    try {
      await saveDeviceMetadata(services.db, uid, deviceName, repName, adminIdentity);
    } catch (err) {
      throw new Error(translateFirestoreErrorAr(err));
    }
  };

  const handleSavePolicy = async (
    uid: string,
    payload: {
      block_tethering: boolean;
      blocked_apps: string[];
      expectedCurrentRevision: number | null;
      allowRepairCorrupted?: boolean;
    }
  ) => {
    if (!services || !adminIdentity?.isAuthorizedAdmin) {
      throw new Error('غير مصرح بالكتابة قبل التحقق من صلاحية المسؤول.');
    }
    try {
      return await saveDevicePolicyTransaction(
        services.db,
        uid,
        payload,
        adminIdentity
      );
    } catch (err) {
      throw new Error(translateFirestoreErrorAr(err));
    }
  };

  const handleOpenDevice = (uid: string) => {
    setSelectedDeviceUid(uid);
    setActiveTab('devices');
  };

  const navigateDevicesWithFilter = (filterKey?: string) => {
    setDeviceFilter((filterKey as DeviceFilterKey) || 'all');
    setActiveTab('devices');
  };

  const handleTriggerBulkActionForApp = (pkg: string, action: 'block_apps' | 'allow_apps') => {
    setExternalBulkAction({
      type: action,
      params: { packages: [pkg] },
    });
    setActiveTab('devices');
  };

  // Modernized 5-Tab Navigation Contract
  const navItems: { key: NavTab; label: string }[] = [
    { key: 'overview', label: 'الرئيسية' },
    { key: 'devices', label: 'الأجهزة' },
    { key: 'apps', label: 'التطبيقات' },
    { key: 'audit', label: 'سجل العمليات' },
    { key: 'settings', label: 'الإعدادات' },
  ];

  return (
    <div dir="rtl" className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans">
      {/* Top Bar: Brand Wordmark — 5 Nav Links — Primary Action */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-2xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-6">
          {/* Brand Wordmark */}
          <a
            href="#overview"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab(resolution.isConfigured ? 'overview' : 'settings');
            }}
            className="text-base sm:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 hover:text-blue-700 transition-colors"
          >
            إنجاز | إدارة أجهزة المندوبين
          </a>

          {/* 5 Primary Navigation Links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-semibold text-slate-600">
            {navItems.map((item) => (
              <a
                key={item.key}
                href={`#${item.key}`}
                onClick={(e) => {
                  e.preventDefault();
                  setActiveTab(item.key);
                }}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                  activeTab === item.key
                    ? 'text-blue-700 border-blue-700 font-bold'
                    : 'border-transparent hover:text-slate-900'
                }`}
              >
                {item.label}
              </a>
            ))}
          </nav>

          {/* Header Action Button */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() =>
                setActiveTab(activeTab === 'settings' ? 'overview' : 'settings')
              }
              className="px-4 py-2 text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 rounded-xl transition-colors whitespace-nowrap shrink-0 shadow-2xs"
            >
              {activeTab === 'settings' ? 'العودة للوحة الإدارة' : 'الإعدادات وقواعد الأمان'}
            </button>
          </div>
        </div>
      </header>

      {/* Secondary Workspace Context & Mobile Navigation Bar */}
      <div className="bg-slate-100/90 border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          {/* Breadcrumb & Target Project Info */}
          <div className="flex flex-wrap items-center gap-2 text-slate-600">
            <span className="font-bold text-slate-800">المشروع: vansales-mdm</span>
            <span aria-hidden="true" className="text-slate-400">·</span>
            <span>قاعدة البيانات: (default)</span>
            <span aria-hidden="true" className="text-slate-400">·</span>
            <span className="text-slate-800 font-semibold">{connectionStateLabel}</span>
          </div>

          {/* Admin Session & Settings Controls */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'settings'
                  ? 'bg-blue-700 text-white'
                  : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Settings className="w-3.5 h-3.5" />
              <span>الإعدادات</span>
            </button>

            {services && adminIdentity && (
              <div className="flex items-center gap-2 pr-2 border-r border-slate-300">
                <span className="font-mono text-[11px] text-slate-700 hidden sm:inline">
                  {adminIdentity.email}
                </span>
                <button
                  type="button"
                  onClick={() => void signOut(services.auth)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-red-700 bg-white border border-slate-200 hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>خروج</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Mobile Tab Strip */}
        <div className="md:hidden flex items-center gap-1 overflow-x-auto px-4 pb-2 pt-1">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveTab(item.key)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg whitespace-nowrap shrink-0 ${
                activeTab === item.key
                  ? 'bg-blue-700 text-white'
                  : 'bg-white text-slate-700 border border-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        {/* Global Firestore Permission Error Banner */}
        {permissionBanner && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-xs text-red-900 shadow-2xs">
            <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold">تنبيه صلاحيات قاعدة البيانات (Firestore Rules)</p>
              <p className="leading-relaxed">{permissionBanner}</p>
            </div>
          </div>
        )}

        {/* Always allow viewing SettingsTab even when unconfigured or not signed in */}
        {activeTab === 'settings' ? (
          <SettingsTab
            resolution={resolution}
            onConfigSaved={() => {
              setConfigVersion((v) => v + 1);
              setActiveTab('overview');
            }}
          />
        ) : !resolution.isConfigured || !services ? (
          <SettingsTab
            resolution={resolution}
            onConfigSaved={() => {
              setConfigVersion((v) => v + 1);
              setActiveTab('overview');
            }}
          />
        ) : !adminIdentity?.isAuthorizedAdmin ? (
          <AdminAuthScreen
            auth={services.auth}
            adminIdentity={adminIdentity}
            authLoading={authLoading}
            onReloadAndVerify={handleReloadAndVerify}
            onOpenDocs={() => setActiveTab('settings')}
            onOpenFirebaseSetup={() => setActiveTab('settings')}
          />
        ) : (
          <>
            {activeTab === 'overview' && (
              <OverviewTab
                devices={mergedDevices}
                loading={dataLoading}
                onSelectDeviceForPolicy={handleOpenDevice}
                onNavigateDevices={navigateDevicesWithFilter}
                onNavigateEnrollments={() => navigateDevicesWithFilter('pending_approval')}
              />
            )}

            {activeTab === 'devices' && (
              <DevicesTab
                devices={mergedDevices}
                initialFilter={deviceFilter}
                auditLogs={auditLogs}
                db={services.db}
                actor={adminIdentity}
                selectedDeviceUid={selectedDeviceUid}
                onSelectDeviceUid={setSelectedDeviceUid}
                externalBulkAction={externalBulkAction}
                onClearExternalBulkAction={() => setExternalBulkAction(null)}
                onSaveMetadata={handleSaveMetadata}
                onToggleApproval={(uid, approved) => handleApproveDevice(uid, approved)}
                onSavePolicy={handleSavePolicy}
              />
            )}

            {activeTab === 'apps' && (
              <FleetAppsTab
                devices={mergedDevices}
                onTriggerBulkActionForApp={handleTriggerBulkActionForApp}
              />
            )}

            {activeTab === 'audit' && (
              <AuditLogTab
                logs={auditLogs}
                onSelectDevice={handleOpenDevice}
              />
            )}
          </>
        )}
      </main>

      {/* Quiet Institutional Footer */}
      <footer className="bg-white border-t border-slate-200 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span className="font-medium">إنجاز | إدارة أجهزة المندوبين — لوحة إدارة وكيل Android Device Owner</span>
          <span>مشروع Firebase المستهدف: vansales-mdm · قاعدة البيانات: (default)</span>
        </div>
      </footer>
    </div>
  );
}
