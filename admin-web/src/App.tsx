import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  resolveFirebaseConfig,
  getFirebaseServices,
} from './services/firebaseClient';
import {
  verifyAdminIdentity,
  reloadUserAndVerifyAdmin,
  subscribeToFleetData,
} from './services/mdmService';
import { buildMergedDevices } from './utils/validation';
import {
  parseRouteFromHash,
  buildHashForRoute,
  areRoutesEqual,
  type MainTab,
  type DeviceManagementTabId,
  type AppRouteState,
} from './utils/navigationGuard';
import type {
  AdminIdentity,
  EnrollmentDoc,
  PolicyDoc,
  DeviceStatusDoc,
  DeviceMetadataDoc,
  AuditLogDoc,
} from './types/mdm';
import { FirebaseSetupView } from './components/FirebaseSetupView';
import { AdminAuthScreen } from './components/AdminAuthScreen';
import { OverviewTab } from './components/OverviewTab';
import { DevicesTab, type DeviceFilterCategory } from './components/DevicesTab';
import { FleetAppsTab } from './components/FleetAppsTab';
import { AuditLogTab } from './components/AuditLogTab';
import { SettingsTab } from './components/SettingsTab';
import { DocsAndSecurityTab } from './components/DocsAndSecurityTab';
import {
  Shield,
  Smartphone,
  LayoutDashboard,
  FileClock,
  LogOut,
  AlertTriangle,
  AppWindow,
  Sliders,
  PanelRightClose,
  PanelRightOpen,
  Menu,
  X,
} from 'lucide-react';

const HISTORY_INDEX_KEY = '__mdmHistoryIdx';

function readHistoryIndex(historyState: unknown): number | null {
  if (
    historyState &&
    typeof historyState === 'object' &&
    typeof (historyState as Record<string, unknown>)[HISTORY_INDEX_KEY] === 'number' &&
    Number.isInteger((historyState as Record<string, unknown>)[HISTORY_INDEX_KEY])
  ) {
    return (historyState as Record<string, number>)[HISTORY_INDEX_KEY];
  }
  return null;
}

function withHistoryIndex(historyState: unknown, idx: number): Record<string, unknown> {
  const base =
    historyState && typeof historyState === 'object' && !Array.isArray(historyState)
      ? (historyState as Record<string, unknown>)
      : {};
  return {
    ...base,
    [HISTORY_INDEX_KEY]: idx,
  };
}

export interface BrowserNavigationWindow {
  location: {
    hash: string;
  };
  history: {
    readonly state: unknown;
    readonly length: number;
    pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
    replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
    go: (delta?: number) => void;
    back?: () => void;
    forward?: () => void;
  };
  addEventListener: (type: string, listener: (ev: any) => void) => void;
  removeEventListener: (type: string, listener: (ev: any) => void) => void;
}

export interface AppBrowserNavigationOptions {
  win?: BrowserNavigationWindow;
  isDirty: () => boolean;
  onRouteChange: (nextRoute: AppRouteState) => void;
  onPendingActionChange: (action: (() => void) | null) => void;
  onDiscardDraft: () => void;
}

export interface AppBrowserNavigationController {
  getCommittedRoute: () => AppRouteState;
  getCommittedHistoryIndex: () => number;
  hasPendingNavigation: () => boolean;
  applyRouteChange: (
    nextTab: MainTab,
    nextDeviceUid?: string | null,
    nextSettingsSection?: 'general' | 'advanced',
    nextDeviceTab?: DeviceManagementTabId,
    replaceHistory?: boolean
  ) => void;
  navigateWithGuard: (
    nextTab: MainTab,
    nextDeviceUid?: string | null,
    nextSettingsSection?: 'general' | 'advanced',
    nextDeviceTab?: DeviceManagementTabId
  ) => void;
  cancelPendingNavigation: () => void;
  confirmPendingNavigation: () => void;
  attach: () => () => void;
}

/**
 * Actual browser navigation controller used by App.tsx.
 * Tracks session history index in window.history.state.__mdmHistoryIdx so that
 * intercepting Browser Back or Forward while dirty reverts via window.history.go(-delta)
 * without wiping Forward history or adding duplicate history entries.
 */
export function createAppBrowserNavigation(
  options: AppBrowserNavigationOptions
): AppBrowserNavigationController {
  const { win, isDirty, onRouteChange, onPendingActionChange, onDiscardDraft } = options;

  let committedRoute: AppRouteState = parseRouteFromHash(win ? win.location.hash : '');
  const initialIdx = win ? readHistoryIndex(win.history.state) : null;
  let committedHistoryIdx: number = initialIdx ?? 0;
  let suppressHashEvent = false;
  let restoringHistoryTargetIdx: number | null = null;
  let pendingAction: (() => void) | null = null;

  const setPending = (action: (() => void) | null) => {
    pendingAction = action;
    onPendingActionChange(action);
  };

  const applyRouteChange = (
    nextTab: MainTab,
    nextDeviceUid: string | null = null,
    nextSettingsSection: 'general' | 'advanced' = 'general',
    nextDeviceTab: DeviceManagementTabId = 'overview',
    replaceHistory = false
  ) => {
    const targetHash = buildHashForRoute(
      nextTab,
      nextDeviceUid,
      nextSettingsSection,
      nextDeviceTab
    );
    const nextRoute: AppRouteState = {
      tab: nextTab,
      deviceUid: nextDeviceUid,
      deviceTab: nextDeviceTab,
      settingsSection: nextSettingsSection,
      hash: targetHash,
    };

    committedRoute = nextRoute;
    onRouteChange(nextRoute);

    if (win && win.location.hash !== targetHash) {
      suppressHashEvent = true;
      if (replaceHistory) {
        win.history.replaceState(
          withHistoryIndex(win.history.state, committedHistoryIdx),
          '',
          targetHash
        );
      } else {
        committedHistoryIdx += 1;
        win.history.pushState(
          withHistoryIndex(null, committedHistoryIdx),
          '',
          targetHash
        );
      }
      queueMicrotask(() => {
        suppressHashEvent = false;
      });
    }
  };

  const navigateWithGuard = (
    nextTab: MainTab,
    nextDeviceUid: string | null = null,
    nextSettingsSection: 'general' | 'advanced' = 'general',
    nextDeviceTab: DeviceManagementTabId = 'overview'
  ) => {
    const targetHash = buildHashForRoute(
      nextTab,
      nextDeviceUid,
      nextSettingsSection,
      nextDeviceTab
    );
    const targetRoute: AppRouteState = {
      tab: nextTab,
      deviceUid: nextDeviceUid,
      deviceTab: nextDeviceTab,
      settingsSection: nextSettingsSection,
      hash: targetHash,
    };

    if (areRoutesEqual(committedRoute, targetRoute)) {
      return;
    }

    if (isDirty()) {
      setPending(() => {
        onDiscardDraft();
        applyRouteChange(nextTab, nextDeviceUid, nextSettingsSection, nextDeviceTab);
      });
      return;
    }

    applyRouteChange(nextTab, nextDeviceUid, nextSettingsSection, nextDeviceTab);
  };

  const cancelPendingNavigation = () => {
    setPending(null);
  };

  const confirmPendingNavigation = () => {
    const act = pendingAction;
    setPending(null);
    if (act) {
      act();
    }
  };

  const attach = () => {
    if (!win) {
      return () => {};
    }

    const existingIdx = readHistoryIndex(win.history.state);
    if (existingIdx !== null) {
      committedHistoryIdx = existingIdx;
    }
    if (!win.location.hash || existingIdx === null) {
      suppressHashEvent = true;
      win.history.replaceState(
        withHistoryIndex(win.history.state, committedHistoryIdx),
        '',
        committedRoute.hash
      );
      queueMicrotask(() => {
        suppressHashEvent = false;
      });
    }

    const handleHashOrPopState = () => {
      if (suppressHashEvent) {
        return;
      }

      if (restoringHistoryTargetIdx !== null) {
        const currentIdx = readHistoryIndex(win.history.state);
        const incoming = parseRouteFromHash(win.location.hash);
        if (
          currentIdx === restoringHistoryTargetIdx ||
          areRoutesEqual(committedRoute, incoming)
        ) {
          queueMicrotask(() => {
            restoringHistoryTargetIdx = null;
          });
        }
        return;
      }

      const incomingRoute = parseRouteFromHash(win.location.hash);
      const poppedIdx = readHistoryIndex(win.history.state);

      if (areRoutesEqual(committedRoute, incomingRoute)) {
        if (poppedIdx !== null) {
          committedHistoryIdx = poppedIdx;
        }
        if (win.location.hash !== committedRoute.hash) {
          suppressHashEvent = true;
          win.history.replaceState(
            withHistoryIndex(win.history.state, committedHistoryIdx),
            '',
            committedRoute.hash
          );
          queueMicrotask(() => {
            suppressHashEvent = false;
          });
        }
        return;
      }

      if (isDirty()) {
        const targetRestoreIdx = committedHistoryIdx;
        const delta = poppedIdx !== null ? poppedIdx - committedHistoryIdx : 1;

        if (delta !== 0) {
          restoringHistoryTargetIdx = targetRestoreIdx;
          win.history.go(-delta);
          queueMicrotask(() => {
            if (
              readHistoryIndex(win.history.state) === targetRestoreIdx ||
              win.location.hash === committedRoute.hash
            ) {
              restoringHistoryTargetIdx = null;
            }
          });
        }

        setPending(() => {
          onDiscardDraft();
          if (poppedIdx !== null) {
            committedRoute = incomingRoute;
            committedHistoryIdx = poppedIdx;
            onRouteChange(incomingRoute);
            const currentIdxNow = readHistoryIndex(win.history.state);
            const travelDelta =
              currentIdxNow !== null ? poppedIdx - currentIdxNow : delta;
            if (travelDelta !== 0) {
              suppressHashEvent = true;
              win.history.go(travelDelta);
              queueMicrotask(() => {
                suppressHashEvent = false;
              });
            }
          } else {
            applyRouteChange(
              incomingRoute.tab,
              incomingRoute.deviceUid,
              incomingRoute.settingsSection,
              incomingRoute.deviceTab
            );
          }
        });
        return;
      }

      if (poppedIdx !== null) {
        committedHistoryIdx = poppedIdx;
      } else {
        committedHistoryIdx += 1;
        suppressHashEvent = true;
        win.history.replaceState(
          withHistoryIndex(win.history.state, committedHistoryIdx),
          '',
          incomingRoute.hash
        );
        queueMicrotask(() => {
          suppressHashEvent = false;
        });
      }

      committedRoute = incomingRoute;
      onRouteChange(incomingRoute);
    };

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    win.addEventListener('popstate', handleHashOrPopState);
    win.addEventListener('hashchange', handleHashOrPopState);
    win.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      win.removeEventListener('popstate', handleHashOrPopState);
      win.removeEventListener('hashchange', handleHashOrPopState);
      win.removeEventListener('beforeunload', handleBeforeUnload);
    };
  };

  return {
    getCommittedRoute: () => committedRoute,
    getCommittedHistoryIndex: () => committedHistoryIdx,
    hasPendingNavigation: () => pendingAction !== null,
    applyRouteChange,
    navigateWithGuard,
    cancelPendingNavigation,
    confirmPendingNavigation,
    attach,
  };
}

export function App() {
  const [configVersion, setConfigVersion] = useState(0);
  const resolution = useMemo(() => resolveFirebaseConfig(), [configVersion]);

  const services = useMemo(() => {
    if (!resolution.isConfigured) return null;
    try {
      return getFirebaseServices();
    } catch {
      return null;
    }
  }, [resolution]);

  // Initial route from URL hash
  const initialRoute = useMemo(
    () => parseRouteFromHash(typeof window !== 'undefined' ? window.location.hash : ''),
    []
  );

  const [activeTab, setActiveTab] = useState<MainTab>(initialRoute.tab);
  const [selectedDeviceUid, setSelectedDeviceUid] = useState<string | null>(
    initialRoute.deviceUid
  );
  const [deviceTab, setDeviceTab] = useState<DeviceManagementTabId>(initialRoute.deviceTab);
  const [settingsSection, setSettingsSection] = useState<'general' | 'advanced'>(
    initialRoute.settingsSection || 'general'
  );

  // Preserved search & filter state for Devices list
  const [devicesSearchQuery, setDevicesSearchQuery] = useState('');
  const [devicesFilter, setDevicesFilter] = useState<DeviceFilterCategory>('all');

  // Sidebar state (desktop collapse + mobile drawer)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Unsaved changes guard for device management forms
  const [deviceFormDirty, setDeviceFormDirty] = useState(false);
  const deviceFormDirtyRef = useRef<boolean>(false);
  const [discardDraftSignal, setDiscardDraftSignal] = useState(0);
  const [pendingNavAction, setPendingNavAction] = useState<(() => void) | null>(null);

  useEffect(() => {
    deviceFormDirtyRef.current = deviceFormDirty;
  }, [deviceFormDirty]);

  // Auth & Admin verification state
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [adminIdentity, setAdminIdentity] = useState<AdminIdentity | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [unauthPreView, setUnauthPreView] = useState<'auth' | 'docs' | 'setup'>('auth');

  // Firestore real-time collections state
  const [enrollments, setEnrollments] = useState<Record<string, EnrollmentDoc>>({});
  const [policies, setPolicies] = useState<Record<string, PolicyDoc>>({});
  const [statuses, setStatuses] = useState<Record<string, DeviceStatusDoc>>({});
  const [metadata, setMetadata] = useState<Record<string, DeviceMetadataDoc>>({});
  const [auditLogs, setAuditLogs] = useState<AuditLogDoc[]>([]);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);

  const navControllerRef = useRef<AppBrowserNavigationController | null>(null);
  if (!navControllerRef.current) {
    navControllerRef.current = createAppBrowserNavigation({
      win: typeof window !== 'undefined' ? window : undefined,
      isDirty: () => deviceFormDirtyRef.current,
      onRouteChange: (nextRoute) => {
        setActiveTab(nextRoute.tab);
        setSelectedDeviceUid(nextRoute.deviceUid);
        setDeviceTab(nextRoute.deviceTab);
        setSettingsSection(nextRoute.settingsSection);
        setMobileSidebarOpen(false);
      },
      onPendingActionChange: (action) => {
        setPendingNavAction(() => action);
      },
      onDiscardDraft: () => {
        deviceFormDirtyRef.current = false;
        setDeviceFormDirty(false);
        setDiscardDraftSignal((s) => s + 1);
      },
    });
  }

  const navigateWithGuard = useCallback(
    (
      nextTab: MainTab,
      nextDeviceUid: string | null = null,
      nextSettingsSection: 'general' | 'advanced' = 'general',
      nextDeviceTab: DeviceManagementTabId = 'overview'
    ) => {
      navControllerRef.current?.navigateWithGuard(
        nextTab,
        nextDeviceUid,
        nextSettingsSection,
        nextDeviceTab
      );
    },
    []
  );

  useEffect(() => {
    const ctrl = navControllerRef.current;
    if (!ctrl) return;
    return ctrl.attach();
  }, []);

  // 1. Listen to Firebase Auth state
  useEffect(() => {
    if (!services) {
      setAuthLoading(false);
      setAdminIdentity(null);
      return;
    }

    setAuthLoading(true);
    const unsub = onAuthStateChanged(services.auth, async (user) => {
      setAuthUser(user);
      if (!user) {
        setAdminIdentity(null);
        setAuthLoading(false);
        return;
      }
      setAuthLoading(true);
      try {
        const identity = await verifyAdminIdentity(services.db, user);
        setAdminIdentity(identity);
      } finally {
        setAuthLoading(false);
      }
    });

    return () => unsub();
  }, [services]);

  const handleReloadAndVerify = async () => {
    if (!services || !authUser) return;
    setAuthLoading(true);
    try {
      const refreshed = await reloadUserAndVerifyAdmin(services.db, authUser);
      setAdminIdentity(refreshed);
    } finally {
      setAuthLoading(false);
    }
  };

  // 2. Subscribe to Firestore collections ONLY when admin is authorized
  useEffect(() => {
    if (!services || !adminIdentity?.isAuthorizedAdmin) {
      setEnrollments({});
      setPolicies({});
      setStatuses({});
      setMetadata({});
      setAuditLogs([]);
      setSubscriptionError(null);
      return;
    }

    const unsub = subscribeToFleetData(services.db, {
      onEnrollments: (map) => {
        setEnrollments(map);
        setSubscriptionError(null);
      },
      onPolicies: (map) => {
        setPolicies(map);
      },
      onStatuses: (map) => {
        setStatuses(map);
      },
      onMetadata: (map) => {
        setMetadata(map);
      },
      onAuditLogs: (logs) => {
        setAuditLogs(logs);
      },
      onPermissionError: (errMsg) => {
        setSubscriptionError(errMsg);
      },
    });

    return () => unsub();
  }, [services, adminIdentity?.isAuthorizedAdmin]);

  const mergedDevices = useMemo(() => {
    return buildMergedDevices(enrollments, policies, statuses, metadata);
  }, [enrollments, policies, statuses, metadata]);

  const effectiveAuditLogs = auditLogs;
  const effectiveAdminIdentity = adminIdentity;

  const attentionCount = useMemo(
    () =>
      mergedDevices.filter(
        (d) =>
          d.approvalState !== 'approved' ||
          d.enforcementState === 'error' ||
          d.enforcementState === 'pending'
      ).length,
    [mergedDevices]
  );

  // If Firebase config is missing or user opened Setup pre-login
  if (!resolution.isConfigured || !services || unauthPreView === 'setup') {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 p-4 sm:p-8" dir="rtl">
        <div className="max-w-5xl mx-auto space-y-4">
          {resolution.isConfigured && services && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setUnauthPreView('auth')}
                className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold cursor-pointer"
              >
                العودة لشاشة تسجيل الدخول
              </button>
            </div>
          )}
          <FirebaseSetupView
            resolution={resolution}
            onConfigSaved={() => {
              setConfigVersion((v) => v + 1);
              setUnauthPreView('auth');
            }}
            onNavigateDocs={() => setUnauthPreView('docs')}
          />
        </div>
      </div>
    );
  }

  if (unauthPreView === 'docs') {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 p-4 sm:p-8" dir="rtl">
        <div className="max-w-5xl mx-auto space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold text-slate-900">
              إنجاز | الإعدادات المتقدمة وقواعد الأمان
            </h1>
            <button
              type="button"
              onClick={() => setUnauthPreView('auth')}
              className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold cursor-pointer"
            >
              العودة لشاشة تسجيل الدخول
            </button>
          </div>
          <DocsAndSecurityTab />
        </div>
      </div>
    );
  }

  // If not authenticated or not authorized admin
  if (!effectiveAdminIdentity || !effectiveAdminIdentity.isAuthorizedAdmin) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900" dir="rtl">
        <AdminAuthScreen
          auth={services.auth}
          adminIdentity={effectiveAdminIdentity}
          authLoading={authLoading}
          onReloadAndVerify={handleReloadAndVerify}
          onOpenDocs={() => setUnauthPreView('docs')}
          onOpenFirebaseSetup={() => setUnauthPreView('setup')}
        />
      </div>
    );
  }

  const activeActor = effectiveAdminIdentity;
  const activeDb = services.db;

  const navItems: {
    id: MainTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
    badgeTone?: 'amber' | 'slate';
  }[] = [
    {
      id: 'overview',
      label: 'الرئيسية',
      icon: <LayoutDashboard className="w-5 h-5 shrink-0" />,
      badge: attentionCount > 0 ? attentionCount : undefined,
      badgeTone: 'amber',
    },
    {
      id: 'devices',
      label: 'الأجهزة',
      icon: <Smartphone className="w-5 h-5 shrink-0" />,
      badge: mergedDevices.length,
      badgeTone: 'slate',
    },
    {
      id: 'apps',
      label: 'التطبيقات',
      icon: <AppWindow className="w-5 h-5 shrink-0" />,
    },
    {
      id: 'audit',
      label: 'سجل العمليات',
      icon: <FileClock className="w-5 h-5 shrink-0" />,
    },
    {
      id: 'settings',
      label: 'الإعدادات',
      icon: <Sliders className="w-5 h-5 shrink-0" />,
    },
  ];

  const handleSignOut = async () => {
    if (services?.auth) {
      await signOut(services.auth);
    }
  };

  return (
    <div className="min-h-screen bg-[#f4f6f9] text-slate-900 flex flex-col lg:flex-row" dir="rtl">
      {/* Unsaved Changes Confirmation Modal when switching top-level tabs */}
      {pendingNavAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-amber-100 text-amber-700 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">توجد تعديلات غير محفوظة</h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  لديك تعديلات لم يتم حفظها في صفحة الجهاز الحالية. هل تريد تجاهل التعديلات والانتقال إلى القسم الآخر؟
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => navControllerRef.current?.cancelPendingNavigation()}
                className="px-4 py-2 rounded-lg text-xs font-bold border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                البقاء في الصفحة
              </button>
              <button
                type="button"
                onClick={() => navControllerRef.current?.confirmPendingNavigation()}
                className="px-4 py-2 rounded-lg text-xs font-bold bg-red-600 text-white hover:bg-red-700 cursor-pointer"
              >
                تجاهل التعديلات والانتقال
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Top Header */}
      <header className="lg:hidden sticky top-0 z-30 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label="فتح القائمة الجانبية"
            className="p-2 rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-slate-900 leading-tight">
                إنجاز | إدارة أجهزة المندوبين
              </h1>
              <p className="text-[11px] text-slate-500">لوحة التحكم المركزية</p>
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-[11px] font-bold">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          متصل
        </span>
      </header>

      {/* Mobile Sidebar Backdrop & Drawer */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <aside className="relative z-10 w-72 max-w-[85vw] bg-slate-900 text-white h-full flex flex-col justify-between p-4 shadow-2xl">
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center">
                    <Shield className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-white">إنجاز | أجهزة المندوبين</h2>
                    <p className="text-[11px] text-slate-400">إدارة الهواتف والتطبيقات</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileSidebarOpen(false)}
                  aria-label="إغلاق القائمة"
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <nav className="space-y-1.5" aria-label="القائمة الرئيسية للهاتف">
                {navItems.map((item) => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        navigateWithGuard(
                          item.id,
                          item.id === 'devices' ? selectedDeviceUid : null
                        )
                      }
                      className={`w-full flex items-center justify-between gap-3 px-3.5 py-3 rounded-xl text-sm font-bold transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {item.icon}
                        <span>{item.label}</span>
                      </div>
                      {item.badge !== undefined && (
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                            isActive
                              ? 'bg-white/20 text-white'
                              : item.badgeTone === 'amber'
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>

            <div className="pt-4 border-t border-slate-800 space-y-3">
              <div className="px-2">
                <p className="text-xs font-bold text-slate-200 truncate" dir="ltr">
                  {activeActor.email}
                </p>
                <p className="text-[11px] text-emerald-400 mt-0.5">صلاحية مسؤول مؤكدة</p>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-red-600/90 text-slate-200 hover:text-white text-xs font-bold transition-colors cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                <span>تسجيل الخروج</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Desktop Right-Side Collapsible RTL Sidebar */}
      <aside
        aria-label="القائمة الجانبية الرئيسية"
        className={`hidden lg:flex flex-col justify-between bg-slate-900 text-white shrink-0 sticky top-0 h-screen border-l border-slate-800 transition-all duration-200 ${
          sidebarCollapsed ? 'w-20' : 'w-68'
        }`}
      >
        <div className="p-4 space-y-6">
          {/* Brand + Collapse Toggle */}
          <div
            className={`flex items-center ${
              sidebarCollapsed ? 'justify-center' : 'justify-between'
            } pb-4 border-b border-slate-800`}
          >
            {!sidebarCollapsed && (
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-xs">
                  <Shield className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-bold text-white truncate">
                    إنجاز | أجهزة المندوبين
                  </h1>
                  <p className="text-[11px] text-slate-400 truncate">
                    لوحة إدارة الهواتف والسياسات
                  </p>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => setSidebarCollapsed((c) => !c)}
              title={sidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'}
              aria-label={sidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
            >
              {sidebarCollapsed ? (
                <PanelRightOpen className="w-5 h-5" />
              ) : (
                <PanelRightClose className="w-5 h-5" />
              )}
            </button>
          </div>

          {/* Primary Navigation Items */}
          <nav className="space-y-1.5" aria-label="التنقل الرئيسي">
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  title={sidebarCollapsed ? item.label : undefined}
                  onClick={() => {
                    if (item.id === 'devices' && activeTab === 'devices' && selectedDeviceUid) {
                      // Clicking "الأجهزة" while inside a device returns to the devices list
                      navigateWithGuard('devices', null);
                    } else {
                      navigateWithGuard(
                        item.id,
                        item.id === 'devices' ? selectedDeviceUid : null
                      );
                    }
                  }}
                  className={`w-full flex items-center ${
                    sidebarCollapsed ? 'justify-center px-2 py-3' : 'justify-between px-3.5 py-3'
                  } rounded-xl text-sm font-bold transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {item.icon}
                    {!sidebarCollapsed && <span>{item.label}</span>}
                  </div>
                  {!sidebarCollapsed && item.badge !== undefined && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                        isActive
                          ? 'bg-white/20 text-white'
                          : item.badgeTone === 'amber'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Admin Account & Sign Out */}
        <div className="p-4 border-t border-slate-800 space-y-3">
          {!sidebarCollapsed ? (
            <>
              <div className="px-2.5 py-2 rounded-xl bg-slate-800/70 space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="text-[11px] font-bold text-emerald-300">
                    مسؤول معتمد ومتصل
                  </span>
                </div>
                <p className="text-xs font-mono text-slate-200 truncate" dir="ltr">
                  {activeActor.email}
                </p>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-red-600/90 text-slate-200 hover:text-white text-xs font-bold transition-colors cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                <span>تسجيل الخروج</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleSignOut}
              title="تسجيل الخروج"
              aria-label="تسجيل الخروج"
              className="w-full flex items-center justify-center p-2.5 rounded-xl bg-slate-800 hover:bg-red-600/90 text-slate-200 hover:text-white transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </aside>

      {/* Main Full-Width Content Workspace */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Workspace Bar */}
        <header className="hidden lg:flex items-center justify-between px-8 py-4 bg-white border-b border-slate-200/80">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {activeTab === 'overview' && 'الرئيسية — ملخص حالة أجهزة المندوبين'}
              {activeTab === 'devices' &&
                (selectedDeviceUid ? 'إدارة الجهاز وتطبيقاته' : 'أجهزة المندوبين')}
              {activeTab === 'apps' && 'دليل التطبيقات والإجراءات الجماعية'}
              {activeTab === 'audit' && 'سجل العمليات الإدارية'}
              {activeTab === 'settings' && 'الإعدادات والسياسة الافتراضية'}
            </h2>
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-600">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              متصل بقاعدة البيانات
            </span>
          </div>
        </header>

        {/* Subscription Warning Banner if any collection failed */}
        {subscriptionError && (
          <div className="mx-4 sm:mx-8 mt-4 p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
            <div className="space-y-1">
              <p className="font-bold">تنبيه في قراءة بعض مجموعات البيانات المباشرة:</p>
              <p>{subscriptionError}</p>
            </div>
          </div>
        )}

        {/* Active Tab Content — Full Width */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 w-full max-w-[1680px] mx-auto">
          {activeTab === 'overview' && (
            <OverviewTab
              devices={mergedDevices}
              onNavigateDevices={() => navigateWithGuard('devices', null)}
              onSelectDevice={(uid) => navigateWithGuard('devices', uid)}
            />
          )}

          {activeTab === 'devices' && (
            <DevicesTab
              devices={mergedDevices}
              auditLogs={effectiveAuditLogs}
              db={activeDb}
              actor={activeActor}
              selectedDeviceUid={selectedDeviceUid}
              onSelectDeviceUid={(uid) => navigateWithGuard('devices', uid, 'general', 'overview')}
              deviceTab={deviceTab}
              onDeviceTabChange={(nextSubTab) =>
                navigateWithGuard('devices', selectedDeviceUid, 'general', nextSubTab)
              }
              discardDraftSignal={discardDraftSignal}
              searchQuery={devicesSearchQuery}
              onSearchQueryChange={setDevicesSearchQuery}
              activeFilter={devicesFilter}
              onActiveFilterChange={setDevicesFilter}
              onDirtyChange={setDeviceFormDirty}
              onNavigateAdvancedSettings={() =>
                navigateWithGuard('settings', null, 'advanced')
              }
            />
          )}

          {activeTab === 'apps' && (
            <FleetAppsTab
              devices={mergedDevices}
              db={activeDb}
              actor={activeActor}
            />
          )}

          {activeTab === 'audit' && (
            <AuditLogTab
              logs={effectiveAuditLogs}
              devices={mergedDevices}
              onSelectDevice={(uid) => navigateWithGuard('devices', uid)}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsTab
              devices={mergedDevices}
              db={activeDb}
              actor={activeActor}
              initialSection={settingsSection}
              onConfigSaved={() => setConfigVersion((v) => v + 1)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
