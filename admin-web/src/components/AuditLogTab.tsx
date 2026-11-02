import React, { useMemo, useState } from 'react';
import { AuditLogDoc, MergedDeviceRecord } from '../types/mdm';
import { formatTimestampAr } from '../utils/validation';
import {
  getDeviceFriendlyName,
  formatAuditLogSummaryAr,
} from '../utils/presentation';
import { FileText, ShieldCheck, Search, Code2, Smartphone } from 'lucide-react';

interface AuditLogTabProps {
  logs: AuditLogDoc[];
  devices?: MergedDeviceRecord[];
  onSelectDevice?: (uid: string) => void;
}

const ACTION_LABELS: Record<string, string> = {
  approve_device: 'اعتماد جهاز',
  revoke_approval: 'سحب اعتماد جهاز',
  create_policy: 'إنشاء سياسة جهاز',
  update_policy: 'تحديث سياسة جهاز',
  update_metadata: 'تعديل بيانات التعريف',
};

export const AuditLogTab: React.FC<AuditLogTabProps> = ({
  logs,
  devices = [],
  onSelectDevice,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  const deviceMap = useMemo(() => {
    const map = new Map<string, MergedDeviceRecord>();
    for (const d of devices) {
      map.set(d.uid, d);
    }
    return map;
  }, [devices]);

  const resolveDeviceName = (targetUid: string): string => {
    if (!targetUid || targetUid === 'ALL' || targetUid === 'FLEET') {
      return 'إجراء عام على الأجهزة';
    }
    const found = deviceMap.get(targetUid);
    if (found) return getDeviceFriendlyName(found);
    return 'جهاز مسجل بالنظام';
  };

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((log) => {
      const devName = resolveDeviceName(log.target_uid).toLowerCase();
      const actionLabel = (ACTION_LABELS[log.action] || log.action).toLowerCase();
      const summary = formatAuditLogSummaryAr(log, deviceMap).toLowerCase();
      const actor = (log.actor_email || '').toLowerCase();
      return (
        devName.includes(q) ||
        actionLabel.includes(q) ||
        summary.includes(q) ||
        actor.includes(q)
      );
    });
  }, [logs, searchQuery, deviceMap]);

  return (
    <div className="space-y-5" dir="rtl">
      {/* Header & Search */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">سجل العمليات الإدارية</h2>
            <p className="text-xs text-slate-600 mt-0.5">
              سجل زمني لجميع الإجراءات والتعديلات التي نفذها المديرون على الأجهزة والسياسات.
            </p>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              محمي من التعديل والحذف
            </span>
          </div>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث باسم الجهاز، نوع الإجراء، البريد الإلكتروني للمدير، أو ملخص العملية..."
            className="w-full pr-10 pl-4 py-2.5 text-sm rounded-xl border border-slate-200 bg-slate-50/50 focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-500/20 outline-hidden"
          />
        </div>
      </div>

      {/* Audit Logs Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-slate-600" />
            <h3 className="text-xs font-bold text-slate-900">
              أحدث العمليات المسجلة ({filteredLogs.length})
            </h3>
          </div>
        </div>

        {filteredLogs.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            لا توجد سجلات عمليات مطابقة حالياً.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-bold text-slate-600">
                  <th className="py-3.5 px-4">الوقت</th>
                  <th className="py-3.5 px-4">المدير</th>
                  <th className="py-3.5 px-4">اسم الجهاز</th>
                  <th className="py-3.5 px-4">الإجراء</th>
                  <th className="py-3.5 px-4">ملخص التغيير</th>
                  <th className="py-3.5 px-4">التفاصيل التقنية</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {filteredLogs.map((log) => {
                  const deviceFriendlyName = resolveDeviceName(log.target_uid);
                  const canOpenDevice =
                    onSelectDevice && deviceMap.has(log.target_uid);
                  const tsInfo = formatTimestampAr(log.created_at?.toMillis?.() ?? null);

                  return (
                    <tr
                      key={log.id}
                      className="hover:bg-slate-50/80 transition-colors align-top"
                    >
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="font-bold text-slate-900">
                          {tsInfo.relative}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {tsInfo.formatted}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900" dir="ltr">
                          {log.actor_email}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {canOpenDevice ? (
                          <button
                            type="button"
                            onClick={() => onSelectDevice(log.target_uid)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-blue-50 text-slate-900 hover:text-blue-700 font-bold transition-colors cursor-pointer"
                          >
                            <Smartphone className="w-3.5 h-3.5 text-slate-500" />
                            <span>{deviceFriendlyName}</span>
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 text-slate-800 font-bold">
                            {deviceFriendlyName}
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className="inline-flex px-2.5 py-1 rounded-md text-xs font-bold bg-blue-50 text-blue-800 border border-blue-200">
                          {ACTION_LABELS[log.action] || log.action}
                        </span>
                      </td>

                      <td className="py-3.5 px-4 text-slate-800 max-w-md leading-relaxed">
                        {formatAuditLogSummaryAr(log, deviceMap)}
                      </td>

                      <td className="py-3.5 px-4">
                        <details className="text-xs">
                          <summary className="cursor-pointer text-blue-600 hover:text-blue-800 font-bold select-none">
                            عرض الفروقات التقنية
                          </summary>
                          <div
                            className="mt-2 p-2.5 rounded-lg bg-slate-900 text-slate-100 font-mono text-[11px] space-y-2 max-w-xs overflow-x-auto"
                            dir="ltr"
                          >
                            <div className="text-slate-400">
                              Target UID: <span className="text-slate-200">{log.target_uid}</span>
                            </div>
                            <div className="text-slate-400">
                              Actor UID: <span className="text-slate-200">{log.actor_uid}</span>
                            </div>
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

      {/* Collapsible Technical Note on Audit Log Guarantee */}
      <details className="bg-white rounded-xl border border-slate-200 shadow-2xs group">
        <summary className="px-5 py-3.5 flex items-center justify-between cursor-pointer list-none select-none">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-700">
            <Code2 className="w-4 h-4 text-slate-500" />
            <span>تفاصيل تقنية حول آلية حماية سجل العمليات</span>
          </div>
          <span className="text-xs font-bold text-blue-600 group-open:rotate-180 transition-transform">
            ▼
          </span>
        </summary>
        <div className="px-5 pb-4 pt-2 border-t border-slate-100 text-xs text-slate-600 space-y-1.5 leading-relaxed">
          <p>
            تُسجل كل عملية إدارية تلقائياً ضمن معاملة قاعدة البيانات الموحدة عند الحفظ من داخل اللوحة.
          </p>
          <p>
            تمنع قواعد الأمان على الخادم أي تعديل أو حذف للسجلات المكتوبة سابقاً، كما تمنع هواتف المندوبين من قراءة هذا السجل.
          </p>
        </div>
      </details>
    </div>
  );
};
