import React, { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  Sliders,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Layers,
  Wifi,
  WifiOff,
  Battery,
  ChevronLeft,
  X,
  Smartphone,
  Save,
  Check,
} from 'lucide-react';
import type { Firestore } from 'firebase/firestore';
import type {
  AdminIdentity,
  AuditLogDoc,
  BulkActionType,
  MergedDeviceRecord,
} from '../types/mdm';
import {
  formatLastSeenAr,
  sanitizeManualUid,
} from '../utils/validation';
import {
  ApprovalBadge,
  DeviceOwnerBadge,
  EnforcementBadge,
  StaleConnectionBadge,
} from './StatusBadges';
import { DeviceDetailDrawer } from './DeviceDetailDrawer';
import { BulkActionModal } from './BulkActionModal';

export type DeviceFilterKey =
  | 'all'
  | 'approved'
  | 'pending_approval'
  | 'applied'
  | 'pending'
  | 'error'
  | 'stale';

interface DevicesTabProps {
  devices: MergedDeviceRecord[];
  initialFilter?: DeviceFilterKey;
  auditLogs: AuditLogDoc[];
  db: Firestore;
  actor: AdminIdentity;
  selectedDeviceUid?: string | null;
  onSelectDeviceUid?: (uid: string | null) => void;
  externalBulkAction?: {
    type: BulkActionType;
    params?: { packages?: string[]; allowTethering?: boolean };
  } | null;
  onClearExternalBulkAction?: () => void;
  onSaveMetadata: (uid: string, deviceName: string, repName: string) => Promise<void>;
  onToggleApproval: (uid: string, approved: boolean, optionalMeta?: { device_name: string; rep_name: string }) => Promise<void>;
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

export const DevicesTab: React.FC<DevicesTabProps> = ({
  devices,
  initialFilter = 'all',
  auditLogs,
  db,
  actor,
  selectedDeviceUid: externalSelectedDeviceUid,
  onSelectDeviceUid,
  externalBulkAction,
  onClearExternalBulkAction,
  onSaveMetadata,
  onToggleApproval,
  onSavePolicy,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<DeviceFilterKey>(initialFilter);
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());

  // Active Device for Detail Drawer (controlled or uncontrolled)
  const [internalSelectedUid, setInternalSelectedUid] = useState<string | null>(null);
  const selectedDeviceUid =
    externalSelectedDeviceUid !== undefined ? externalSelectedDeviceUid : internalSelectedUid;
  const setSelectedDeviceUid = (uid: string | null) => {
    if (onSelectDeviceUid) {
      onSelectDeviceUid(uid);
    } else {
      setInternalSelectedUid(uid);
    }
  };

  // Add / Enroll New Device Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [manualUid, setManualUid] = useState('');
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newRepName, setNewRepName] = useState('');
  const [submittingAdd, setSubmittingAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Bulk Action Modal State
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkActionType, setBulkActionType] = useState<BulkActionType>('block_apps');
  const [bulkActionParams, setBulkActionParams] = useState<{
    packages?: string[];
    allowTethering?: boolean;
  }>({});

  // Trigger bulk action if external action is requested (e.g., from FleetAppsTab)
  React.useEffect(() => {
    if (externalBulkAction) {
      setBulkActionType(externalBulkAction.type);
      setBulkActionParams(externalBulkAction.params || {});
      // If no devices were selected, select all devices by default
      if (selectedUids.size === 0 && devices.length > 0) {
        setSelectedUids(new Set(devices.map((d) => d.uid)));
      }
      setBulkModalOpen(true);
      onClearExternalBulkAction?.();
    }
  }, [externalBulkAction, devices, onClearExternalBulkAction, selectedUids.size]);

  // Filtered devices based on search and status chips
  const filteredDevices = useMemo(() => {
    return devices.filter((d) => {
      // Filter key
      if (activeFilter === 'approved' && d.approvalState !== 'approved') return false;
      if (activeFilter === 'pending_approval' && d.approvalState === 'approved') return false;
      if (activeFilter === 'applied' && d.enforcementState !== 'applied') return false;
      if (activeFilter === 'pending' && d.enforcementState !== 'pending') return false;
      if (activeFilter === 'error' && d.enforcementState !== 'error') return false;
      if (activeFilter === 'stale' && !d.isStaleConnection) return false;

      // Search query
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      const uidMatch = d.uid.toLowerCase().includes(q);
      const nameMatch = (d.metadata?.device_name || '').toLowerCase().includes(q);
      const repMatch = (d.metadata?.rep_name || '').toLowerCase().includes(q);
      const modelMatch = (d.status?.model || '').toLowerCase().includes(q);
      return uidMatch || nameMatch || repMatch || modelMatch;
    });
  }, [devices, activeFilter, searchQuery]);

  // Handle Select All
  const handleToggleSelectAll = () => {
    if (selectedUids.size === filteredDevices.length && filteredDevices.length > 0) {
      setSelectedUids(new Set());
    } else {
      setSelectedUids(new Set(filteredDevices.map((d) => d.uid)));
    }
  };

  const handleToggleDevice = (uid: string) => {
    const next = new Set(selectedUids);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    setSelectedUids(next);
  };

  // Trigger Bulk Action
  const openBulkAction = (
    type: BulkActionType,
    params: { packages?: string[]; allowTethering?: boolean }
  ) => {
    setBulkActionType(type);
    setBulkActionParams(params);
    setBulkModalOpen(true);
  };

  // Submit Add Device form
  const handleAddDeviceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    const sanitized = sanitizeManualUid(manualUid);
    if (!sanitized.valid) {
      setAddError(sanitized.error || 'معرّف UID غير صالح.');
      return;
    }

    setSubmittingAdd(true);
    try {
      await onToggleApproval(sanitized.uid, true, {
        device_name: newDeviceName.trim(),
        rep_name: newRepName.trim(),
      });
      setShowAddModal(false);
      setManualUid('');
      setNewDeviceName('');
      setNewRepName('');
      // Open the newly added device in the drawer directly
      setSelectedDeviceUid(sanitized.uid);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingAdd(false);
    }
  };

  const activeDrawerDevice = devices.find((d) => d.uid === selectedDeviceUid) || null;

  return (
    <div className="space-y-6 text-right">
      {/* Top Action Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">أجهزة المندوبين</h2>
          <p className="text-xs text-slate-500 mt-1">
            اختر جهازًا لإدارته، أو حدد عدة أجهزة لتطبيق قيود التطبيقات ومشاركة الإنترنت دفعة واحدة.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded-xl text-xs font-bold transition-colors shadow-xs"
          >
            <Plus className="w-4 h-4" />
            <span>إضافة جهاز جديد</span>
          </button>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-3" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث بالاسم الإداري، اسم المندوب، طراز الجهاز، أو معرّف UID…"
            className="w-full pr-10 pl-4 py-2.5 bg-white border border-slate-300 rounded-xl text-xs focus:outline-hidden focus:ring-1 focus:ring-blue-600 shadow-2xs"
          />
        </div>

        {/* Filter Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-xs font-semibold pb-1">
          <button
            type="button"
            onClick={() => setActiveFilter('all')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              activeFilter === 'all'
                ? 'bg-slate-900 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            جميع الأجهزة ({devices.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('approved')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              activeFilter === 'approved'
                ? 'bg-emerald-700 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            معتمد ({devices.filter((d) => d.approvalState === 'approved').length})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('pending_approval')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              activeFilter === 'pending_approval'
                ? 'bg-amber-700 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            ينتظر الاعتماد ({devices.filter((d) => d.approvalState !== 'approved').length})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('applied')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              activeFilter === 'applied'
                ? 'bg-blue-700 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            مطبق بالهاتف ({devices.filter((d) => d.enforcementState === 'applied').length})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('pending')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              activeFilter === 'pending'
                ? 'bg-indigo-700 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            بانتظار المزامنة ({devices.filter((d) => d.enforcementState === 'pending').length})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('error')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              activeFilter === 'error'
                ? 'bg-red-700 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            أخطاء ({devices.filter((d) => d.enforcementState === 'error').length})
          </button>
        </div>
      </div>

      {/* Main Concise Devices Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
              <tr>
                <th className="py-3.5 px-4 w-12 text-center">
                  <input
                    type="checkbox"
                    checked={
                      selectedUids.size > 0 &&
                      selectedUids.size === filteredDevices.length &&
                      filteredDevices.length > 0
                    }
                    onChange={handleToggleSelectAll}
                    className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                    title="تحديد الكل"
                  />
                </th>
                <th className="py-3.5 px-4 min-w-[220px]">الجهاز والمندوب</th>
                <th className="py-3.5 px-4 min-w-[140px]">آخر تواصل</th>
                <th className="py-3.5 px-4 min-w-[90px]">البطارية</th>
                <th className="py-3.5 px-4 min-w-[150px]">حالة التغييرات</th>
                <th className="py-3.5 px-4 w-28 text-center">إدارة الجهاز</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredDevices.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    لا توجد أجهزة مطابقة لمعايير البحث أو الفلترة.
                  </td>
                </tr>
              ) : (
                filteredDevices.map((device) => {
                  const isSelected = selectedUids.has(device.uid);
                  const lastSeen = formatLastSeenAr(device.lastSeenMs);
                  const deviceName = device.metadata?.device_name || 'جهاز بدون اسم';
                  const repName = device.metadata?.rep_name || 'غير محدد';
                  const model = device.status?.model || 'طراز غير معروف';

                  return (
                    <tr
                      key={device.uid}
                      className={`transition-colors ${
                        isSelected ? 'bg-blue-50/40' : 'hover:bg-slate-50/80'
                      }`}
                    >
                      <td className="py-3 px-4 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleDevice(device.uid)}
                          className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                        />
                      </td>

                      <td className="py-3 px-4">
                        <div
                          className="cursor-pointer"
                          onClick={() => setSelectedDeviceUid(device.uid)}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900 text-xs hover:text-blue-700 transition-colors">
                              {deviceName}
                            </span>
                            {device.approvalState !== 'approved' && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-900 font-semibold">
                                غير معتمد
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 mt-0.5">
                            <span>المندوب: {repName}</span>
                            <span>·</span>
                            <span>{model}</span>
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <div title={lastSeen.explanation}>
                          <span className="font-semibold text-slate-800 block">
                            {lastSeen.relative}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono block mt-0.5">
                            {lastSeen.formatted}
                          </span>
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5 font-mono text-slate-800 font-bold">
                          <Battery className="w-4 h-4 text-slate-400" />
                          <span>{device.status ? `${device.status.battery_percent}%` : '—'}</span>
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <EnforcementBadge state={device.enforcementState} />
                      </td>

                      <td className="py-3 px-4 text-center">
                        <button
                          type="button"
                          onClick={() => setSelectedDeviceUid(device.uid)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-lg text-xs transition-colors"
                        >
                          <span>إدارة</span>
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sticky Bulk Actions Toolbar appearing when devices are selected */}
      {selectedUids.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 max-w-xl w-full px-4">
          <div className="bg-slate-900 text-white rounded-2xl p-3.5 shadow-2xl flex flex-wrap items-center justify-between gap-3 text-xs border border-slate-700">
            <div className="flex items-center gap-2 pr-2">
              <span className="font-bold">محدد: {selectedUids.size} جهاز</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => openBulkAction('block_apps', { packages: [] })}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold transition-colors"
              >
                <Layers className="w-3.5 h-3.5" />
                <span>منع تطبيقات…</span>
              </button>

              <button
                type="button"
                onClick={() => openBulkAction('set_tethering', { allowTethering: false })}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white border border-slate-600 rounded-xl font-bold transition-colors"
              >
                <WifiOff className="w-3.5 h-3.5" />
                <span>حظر الهوتسبوت</span>
              </button>

              <button
                type="button"
                onClick={() => openBulkAction('set_tethering', { allowTethering: true })}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white border border-slate-600 rounded-xl font-bold transition-colors"
              >
                <Wifi className="w-3.5 h-3.5" />
                <span>السماح بالهوتسبوت</span>
              </button>

              <button
                type="button"
                onClick={() => setSelectedUids(new Set())}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg transition-colors"
                title="إلغاء التحديد"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Enroll Device Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-200 overflow-hidden text-right">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <h3 className="font-bold text-slate-900 text-sm">إضافة واعتماد جهاز جديد</h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddDeviceSubmit} className="p-6 space-y-4 text-xs">
              <p className="text-slate-600 leading-relaxed text-[11px]">
                أدخل معرّف الجهاز (<code className="font-mono font-bold">UID</code>) المنسوخ من شاشة هاتف المندوب بعد فتحه وتسجيله في Firebase.
              </p>

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  معرّف الجهاز (UID) <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={manualUid}
                  onChange={(e) => setManualUid(e.target.value)}
                  placeholder="مثال: AbCdEf123_XyZ"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg font-mono text-xs focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">اسم الجهاز الإداري</label>
                <input
                  type="text"
                  value={newDeviceName}
                  onChange={(e) => setNewDeviceName(e.target.value)}
                  placeholder="مثال: سيارة مبيعات القصيم 02"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">اسم المندوب المسؤول</label>
                <input
                  type="text"
                  value={newRepName}
                  onChange={(e) => setNewRepName(e.target.value)}
                  placeholder="مثال: خالد الحربي"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-blue-600"
                />
              </div>

              {addError && <p className="text-red-600 text-xs font-semibold">{addError}</p>}

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg font-semibold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={submittingAdd}
                  className="px-5 py-2 bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white rounded-lg font-bold"
                >
                  اعتماد وحفظ
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Device Detail Drawer */}
      {activeDrawerDevice && (
        <DeviceDetailDrawer
          device={activeDrawerDevice}
          onClose={() => setSelectedDeviceUid(null)}
          auditLogs={auditLogs}
          db={db}
          actor={actor}
          onSavePolicy={onSavePolicy}
          onSaveMetadata={onSaveMetadata}
          onToggleApproval={(uid, approved) => onToggleApproval(uid, approved)}
        />
      )}

      {/* Bulk Action Modal */}
      {bulkModalOpen && (
        <BulkActionModal
          isOpen={bulkModalOpen}
          onClose={() => setBulkModalOpen(false)}
          devices={devices}
          selectedUids={Array.from(selectedUids)}
          actionType={bulkActionType}
          actionParams={bulkActionParams}
          db={db}
          actor={actor}
          onFinished={() => setSelectedUids(new Set())}
        />
      )}
    </div>
  );
};
