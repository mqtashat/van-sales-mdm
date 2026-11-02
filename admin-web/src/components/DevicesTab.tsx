import React, { useState, useMemo, useEffect } from 'react';
import type { Firestore } from 'firebase/firestore';
import {
  MergedDeviceRecord,
  AuditLogDoc,
  AdminIdentity,
  BulkActionType,
} from '../types/mdm';
import {
  ApprovalBadge,
  EnforcementBadge,
} from './StatusBadges';
import { DeviceDetailDrawer } from './DeviceDetailDrawer';
import { BulkActionModal } from './BulkActionModal';
import {
  sanitizeManualUid,
  formatTimestampAr,
  HARDCODED_PROTECTED_PACKAGES,
  validatePackageName,
} from '../utils/validation';
import { CURATED_APP_CATALOG } from '../utils/appCatalog';
import { saveDeviceMetadata } from '../services/mdmService';
import { getDeviceFriendlyName } from '../utils/presentation';
import {
  Search,
  Plus,
  Smartphone,
  Battery,
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  AppWindow,
  WifiOff,
  Wifi,
  X,
} from 'lucide-react';

export type DeviceFilterCategory =
  | 'all'
  | 'approved'
  | 'unapproved'
  | 'applied'
  | 'pending'
  | 'error'
  | 'stale'
  | 'archived';

interface DevicesTabProps {
  devices: MergedDeviceRecord[];
  auditLogs: AuditLogDoc[];
  db: Firestore;
  actor: AdminIdentity;
  selectedDeviceUid: string | null;
  onSelectDeviceUid: (uid: string | null) => void;
  deviceTab?: 'overview' | 'apps' | 'kiosk' | 'tethering' | 'history';
  onDeviceTabChange?: (tab: 'overview' | 'apps' | 'kiosk' | 'tethering' | 'history') => void;
  discardDraftSignal?: number;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
  activeFilter?: DeviceFilterCategory;
  onActiveFilterChange?: (f: DeviceFilterCategory) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onNavigateAdvancedSettings?: () => void;
}

export const DevicesTab: React.FC<DevicesTabProps> = ({
  devices,
  auditLogs,
  db,
  actor,
  selectedDeviceUid,
  onSelectDeviceUid,
  deviceTab,
  onDeviceTabChange,
  discardDraftSignal,
  searchQuery: controlledSearchQuery,
  onSearchQueryChange,
  activeFilter: controlledActiveFilter,
  onActiveFilterChange,
  onDirtyChange,
  onNavigateAdvancedSettings,
}) => {
  const [internalSearchQuery, setInternalSearchQuery] = useState('');
  const [internalActiveFilter, setInternalActiveFilter] = useState<DeviceFilterCategory>('all');

  const searchQuery =
    controlledSearchQuery !== undefined ? controlledSearchQuery : internalSearchQuery;
  const setSearchQuery = onSearchQueryChange || setInternalSearchQuery;

  const activeFilter =
    controlledActiveFilter !== undefined ? controlledActiveFilter : internalActiveFilter;
  const setActiveFilter = onActiveFilterChange || setInternalActiveFilter;

  // Multi-select state for bulk actions
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());

  // App picker step when user clicks bulk "حظر تطبيق..." or "السماح بتطبيق..."
  const [appPickerMode, setAppPickerMode] = useState<'block_apps' | 'allow_apps' | null>(null);
  const [pickedPackages, setPickedPackages] = useState<Set<string>>(new Set());
  const [customBulkPkg, setCustomBulkPkg] = useState('');
  const [customBulkError, setCustomBulkError] = useState<string | null>(null);

  // Active BulkActionModal state
  const [bulkModalConfig, setBulkModalConfig] = useState<{
    actionType: BulkActionType;
    actionParams: { packages?: string[]; allowTethering?: boolean };
  } | null>(null);

  // Pre-register new device metadata modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newUid, setNewUid] = useState('');
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newRepName, setNewRepName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const activeDevices = useMemo(() => devices.filter((d) => !d.isArchived), [devices]);
  const archivedDevices = useMemo(() => devices.filter((d) => d.isArchived), [devices]);
  useEffect(() => {
    const eligible = new Set(activeDevices.map(d => d.uid));
    setSelectedUids(previous => {
      const next = new Set([...previous].filter(uid => eligible.has(uid)));
      return next.size === previous.size ? previous : next;
    });
  }, [activeDevices]);

  const counts = useMemo(() => {
    return {
      all: activeDevices.length,
      approved: activeDevices.filter((d) => d.approvalState === 'approved').length,
      unapproved: activeDevices.filter((d) => d.approvalState !== 'approved').length,
      applied: activeDevices.filter((d) => d.enforcementState === 'applied').length,
      pending: activeDevices.filter((d) => d.enforcementState === 'pending').length,
      error: activeDevices.filter((d) => d.enforcementState === 'error').length,
      stale: activeDevices.filter((d) => d.isStaleConnection).length,
      archived: archivedDevices.length,
    };
  }, [activeDevices, archivedDevices]);

  const filteredDevices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return devices.filter((d) => {
      if (activeFilter === 'archived') {
        if (!d.isArchived) return false;
      } else {
        if (d.isArchived) return false;
        if (activeFilter === 'approved' && d.approvalState !== 'approved') return false;
        if (activeFilter === 'unapproved' && d.approvalState === 'approved') return false;
        if (activeFilter === 'applied' && d.enforcementState !== 'applied') return false;
        if (activeFilter === 'pending' && d.enforcementState !== 'pending') return false;
        if (activeFilter === 'error' && d.enforcementState !== 'error') return false;
        if (activeFilter === 'stale' && !d.isStaleConnection) return false;
      }

      if (!q) return true;
      const uidMatch = d.uid.toLowerCase().includes(q);
      const nameMatch = (d.metadata?.device_name || '').toLowerCase().includes(q);
      const repMatch = (d.metadata?.rep_name || '').toLowerCase().includes(q);
      const modelMatch = (d.status?.model || '').toLowerCase().includes(q);
      return uidMatch || nameMatch || repMatch || modelMatch;
    });
  }, [devices, searchQuery, activeFilter]);

  const selectedDevice = useMemo(
    () => devices.find((d) => d.uid === selectedDeviceUid) || null,
    [devices, selectedDeviceUid]
  );

  const toggleSelectOne = (uid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(selectedUids);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    setSelectedUids(next);
  };

  const toggleSelectAllFiltered = () => {
    const allFilteredSelected =
      filteredDevices.length > 0 && filteredDevices.every((d) => selectedUids.has(d.uid));
    const next = new Set(selectedUids);
    if (allFilteredSelected) {
      filteredDevices.forEach((d) => next.delete(d.uid));
    } else {
      filteredDevices.forEach((d) => next.add(d.uid));
    }
    setSelectedUids(next);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setCreateSuccess(null);

    const uidCheck = sanitizeManualUid(newUid);
    if (!uidCheck.valid) {
      setCreateError(uidCheck.error || 'معرف الجهاز غير صالح');
      return;
    }

    if (!newDeviceName.trim()) {
      setCreateError('يرجى إدخال اسم الجهاز الإداري.');
      return;
    }

    setCreating(true);
    try {
      await saveDeviceMetadata(db, uidCheck.uid, newDeviceName, newRepName, actor);
      setCreateSuccess('تم حفظ تعريف الجهاز بنجاح.');
      setNewUid('');
      setNewDeviceName('');
      setNewRepName('');
      setShowCreateModal(false);
      onSelectDeviceUid(uidCheck.uid);
    } catch (err: any) {
      setCreateError(err?.message || 'فشل إنشاء تعريف الجهاز');
    } finally {
      setCreating(false);
    }
  };

  const handleAddCustomBulkPkg = () => {
    setCustomBulkError(null);
    const trimmed = customBulkPkg.trim();
    if (!trimmed) return;
    const check = validatePackageName(trimmed, Array.from(pickedPackages));
    if (!check.valid) {
      setCustomBulkError(check.error || 'اسم الحزمة غير صالح');
      return;
    }
    const next = new Set(pickedPackages);
    next.add(trimmed);
    setPickedPackages(next);
    setCustomBulkPkg('');
  };

  const filterButtons: { id: DeviceFilterCategory; label: string; count: number }[] = [
    { id: 'all', label: 'جميع الأجهزة', count: counts.all },
    { id: 'approved', label: 'معتمد', count: counts.approved },
    { id: 'unapproved', label: 'ينتظر الاعتماد', count: counts.unapproved },
    { id: 'applied', label: 'مطبق بالهاتف', count: counts.applied },
    { id: 'pending', label: 'بانتظار التأكيد', count: counts.pending },
    { id: 'error', label: 'أخطاء', count: counts.error },
    { id: 'stale', label: 'اتصال قديم', count: counts.stale },
    { id: 'archived', label: 'الأجهزة المؤرشفة', count: counts.archived },
  ];

  // Full-Page Device Management Mode when a device is selected
  if (selectedDeviceUid && selectedDevice) {
    return (
      <DeviceDetailDrawer
        device={selectedDevice}
        allDevices={devices}
        auditLogs={auditLogs}
        db={db}
        actor={actor}
        activeTab={deviceTab}
        onTabChange={onDeviceTabChange}
        discardDraftSignal={discardDraftSignal}
        onClose={() => onSelectDeviceUid(null)}
        onDirtyChange={onDirtyChange}
        onNavigateAdvancedSettings={onNavigateAdvancedSettings}
      />
    );
  }

  return (
    <div className="space-y-5" dir="rtl">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-xs">
        <div>
          <h2 className="text-lg font-bold text-slate-900">أجهزة المندوبين</h2>
          <p className="text-xs text-slate-600 mt-0.5">
            اختر أي جهاز لفتح صفحة إدارته الكاملة، أو حدد عدة أجهزة لتطبيق إجراءات جماعية على التطبيقات ومشاركة الإنترنت.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowCreateModal(!showCreateModal);
            setCreateError(null);
            setCreateSuccess(null);
          }}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-blue-600 text-white hover:bg-blue-700 transition-colors shadow-xs self-start sm:self-auto cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>إضافة جهاز جديد</span>
        </button>
      </div>

      {/* Create Metadata Form Panel */}
      {showCreateModal && (
        <form
          onSubmit={handleCreateSubmit}
          className="bg-white p-5 rounded-xl border border-blue-200 shadow-sm space-y-4"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">تسجيل تعريف مسبق لجهاز مندوب</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                أدخل معرف الجهاز الظاهر في شاشة تطبيق الحماية على الهاتف لتعيين اسمه والمندوب المسؤول عنه.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowCreateModal(false)}
              className="text-xs text-slate-500 hover:text-slate-700 font-semibold cursor-pointer"
            >
              إلغاء
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                معرف الجهاز (UID) <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                dir="ltr"
                required
                value={newUid}
                onChange={(e) => setNewUid(e.target.value)}
                placeholder="أدخل المعرف من الهاتف"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 focus:border-blue-600 focus:ring-2 focus:ring-blue-500/20 outline-hidden"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                اسم الجهاز الإداري <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                required
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                placeholder="مثال: هاتف مندوب جدة 2"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:ring-2 focus:ring-blue-500/20 outline-hidden"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                اسم المندوب
              </label>
              <input
                type="text"
                value={newRepName}
                onChange={(e) => setNewRepName(e.target.value)}
                placeholder="مثال: خالد القحطاني"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-600 focus:ring-2 focus:ring-blue-500/20 outline-hidden"
              />
            </div>
          </div>

          {createError && (
            <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{createError}</span>
            </div>
          )}

          {createSuccess && (
            <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-700 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{createSuccess}</span>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
            >
              {creating ? 'جارٍ الحفظ...' : 'حفظ وفتح صفحة الجهاز'}
            </button>
          </div>
        </form>
      )}

      {/* Search & Filter Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث باسم الجهاز، اسم المندوب، أو طراز الهاتف..."
            className="w-full pr-10 pl-4 py-2.5 text-sm rounded-xl border border-slate-200 bg-slate-50/50 focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-500/20 outline-hidden"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {filterButtons.map((btn) => (
            <button
              key={btn.id}
              type="button"
              onClick={() => setActiveFilter(btn.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                activeFilter === btn.id
                  ? 'bg-slate-900 text-white shadow-2xs'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {btn.label} ({btn.count})
            </button>
          ))}
        </div>
      </div>

      {/* Bulk Action Bar (Shown when devices are checked) */}
      {selectedUids.size > 0 && (
        <div className="bg-slate-900 text-white px-5 py-3.5 rounded-xl shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="px-2.5 py-1 rounded-lg bg-blue-600 text-xs font-bold">
              {selectedUids.size} جهاز محدد
            </span>
            <span className="text-xs text-slate-300">
              اختر الإجراء الجماعي لتطبيقه على الأجهزة المحددة:
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setPickedPackages(new Set());
                setCustomBulkPkg('');
                setCustomBulkError(null);
                setAppPickerMode('block_apps');
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer"
            >
              <AppWindow className="w-3.5 h-3.5" />
              <span>حظر تطبيق...</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setPickedPackages(new Set());
                setCustomBulkPkg('');
                setCustomBulkError(null);
                setAppPickerMode('allow_apps');
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors cursor-pointer"
            >
              <AppWindow className="w-3.5 h-3.5" />
              <span>السماح بتطبيق...</span>
            </button>
            <button
              type="button"
              onClick={() =>
                setBulkModalConfig({
                  actionType: 'set_tethering',
                  actionParams: { allowTethering: false },
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white transition-colors cursor-pointer"
            >
              <WifiOff className="w-3.5 h-3.5" />
              <span>منع مشاركة الإنترنت</span>
            </button>
            <button
              type="button"
              onClick={() =>
                setBulkModalConfig({
                  actionType: 'set_tethering',
                  actionParams: { allowTethering: true },
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white transition-colors cursor-pointer"
            >
              <Wifi className="w-3.5 h-3.5" />
              <span>السماح بمشاركة الإنترنت</span>
            </button>
            <button
              type="button"
              onClick={() => setSelectedUids(new Set())}
              className="px-2.5 py-1.5 rounded-lg text-xs text-slate-300 hover:text-white cursor-pointer"
            >
              إلغاء التحديد
            </button>
          </div>
        </div>
      )}

      {/* Devices Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        {filteredDevices.length === 0 ? (
          <div className="p-12 text-center">
            <Smartphone className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <h3 className="text-sm font-bold text-slate-800">لا توجد أجهزة مطابقة</h3>
            <p className="text-xs text-slate-500 mt-1">
              جرب تغيير كلمات البحث أو اختيار تصنيف آخر.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/90 text-xs font-bold text-slate-600">
                  <th className="py-3.5 px-4 w-10">
                    <input
                      type="checkbox"
                      checked={
                        filteredDevices.length > 0 &&
                        filteredDevices.every((d) => selectedUids.has(d.uid))
                      }
                      onChange={toggleSelectAllFiltered}
                      aria-label="تحديد جميع الأجهزة المعروضة"
                      className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                  </th>
                  <th className="py-3.5 px-4">الجهاز والمندوب</th>
                  <th className="py-3.5 px-4">الاعتماد</th>
                  <th className="py-3.5 px-4">آخر تواصل</th>
                  <th className="py-3.5 px-4">البطارية</th>
                  <th className="py-3.5 px-4">حالة السياسة</th>
                  <th className="py-3.5 px-4 text-left">إدارة الجهاز</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {filteredDevices.map((d) => {
                  const isChecked = selectedUids.has(d.uid);
                  const friendlyName = getDeviceFriendlyName(d);
                  const tsInfo = formatTimestampAr(d.lastSeenMs);

                  return (
                    <tr
                      key={d.uid}
                      onClick={() => onSelectDeviceUid(d.uid)}
                      className={`hover:bg-blue-50/40 transition-colors cursor-pointer ${
                        isChecked ? 'bg-blue-50/60' : ''
                      }`}
                    >
                      <td
                        className="py-4 px-4"
                        onClick={(e) => toggleSelectOne(d.uid, e)}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          aria-label={`تحديد ${friendlyName}`}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        />
                      </td>

                      {/* Device Name & Sales Rep */}
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 text-sm">
                            {friendlyName}
                          </span>
                          {d.isArchived && (
                            <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-300">
                              مؤرشف
                            </span>
                          )}
                        </div>
                        <div className="text-slate-600 mt-1 flex flex-wrap items-center gap-2">
                          <span>المندوب: {d.metadata?.rep_name || 'غير محدد'}</span>
                          {d.status?.model && (
                            <>
                              <span className="text-slate-300">•</span>
                              <span className="text-slate-500" dir="ltr">
                                {d.status.model}
                              </span>
                            </>
                          )}
                        </div>
                      </td>

                      {/* Approval Status */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <ApprovalBadge state={d.approvalState} />
                      </td>

                      {/* Last Seen */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <div className="font-bold text-slate-800">{tsInfo.relative}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{tsInfo.formatted}</div>
                      </td>

                      {/* Battery */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        {d.status?.battery_percent !== undefined && d.status?.battery_percent >= 0 ? (
                          <span className="inline-flex items-center gap-1.5 font-bold text-slate-800">
                            <Battery className="w-4 h-4 text-slate-400" />
                            {d.status.battery_percent}%
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      {/* Enforcement Status */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <EnforcementBadge state={d.enforcementState} />
                      </td>

                      {/* Action */}
                      <td className="py-4 px-4 text-left whitespace-nowrap">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectDeviceUid(d.uid);
                          }}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold bg-blue-50 text-blue-700 hover:bg-blue-600 hover:text-white border border-blue-200 transition-colors cursor-pointer"
                        >
                          <span>إدارة الجهاز</span>
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* App Picker Modal before Bulk App Action */}
      {appPickerMode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs"
          dir="rtl"
        >
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">
                {appPickerMode === 'block_apps'
                  ? 'اختر التطبيقات المراد حظرها على الأجهزة المحددة'
                  : 'اختر التطبيقات المراد رفع الحظر عنها'}
              </h3>
              <button
                type="button"
                onClick={() => setAppPickerMode(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto">
                {CURATED_APP_CATALOG.filter(
                  (a) => !HARDCODED_PROTECTED_PACKAGES[a.packageName] && !a.isProtected
                ).map((item) => {
                  const checked = pickedPackages.has(item.packageName);
                  return (
                    <label
                      key={item.packageName}
                      className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer ${
                        checked
                          ? 'bg-blue-50 border-blue-300 font-bold text-blue-950'
                          : 'bg-white border-slate-200 text-slate-800 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(pickedPackages);
                          if (next.has(item.packageName)) next.delete(item.packageName);
                          else next.add(item.packageName);
                          setPickedPackages(next);
                        }}
                        className="w-4 h-4 rounded border-slate-300 text-blue-600"
                      />
                      <span className="truncate">{item.nameAr}</span>
                    </label>
                  );
                })}
              </div>

              <div className="pt-2 border-t border-slate-100 space-y-2">
                <label className="block text-xs font-bold text-slate-700">
                  أو أضف معرف حزمة مخصص:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    dir="ltr"
                    value={customBulkPkg}
                    onChange={(e) => setCustomBulkPkg(e.target.value)}
                    placeholder="com.example.app"
                    className="flex-1 px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomBulkPkg}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-900 text-white cursor-pointer"
                  >
                    إضافة
                  </button>
                </div>
                {customBulkError && (
                  <p className="text-xs text-red-600">{customBulkError}</p>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setAppPickerMode(null)}
                className="px-4 py-2 rounded-lg text-xs font-bold border border-slate-300 text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={pickedPackages.size === 0}
                onClick={() => {
                  const mode = appPickerMode;
                  const pkgs = Array.from(pickedPackages);
                  setAppPickerMode(null);
                  setBulkModalConfig({
                    actionType: mode,
                    actionParams: { packages: pkgs },
                  });
                }}
                className="px-5 py-2 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
              >
                متابعة المعاينة ({pickedPackages.size} تطبيق)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Action Execution Modal */}
      {bulkModalConfig && (
        <BulkActionModal
          isOpen={true}
          onClose={() => setBulkModalConfig(null)}
          devices={activeDevices}
          selectedUids={Array.from(selectedUids).filter(uid => activeDevices.some(d => d.uid === uid))}
          actionType={bulkModalConfig.actionType}
          actionParams={bulkModalConfig.actionParams}
          db={db}
          actor={actor}
          onFinished={() => {
            setSelectedUids(new Set());
          }}
        />
      )}
    </div>
  );
};
