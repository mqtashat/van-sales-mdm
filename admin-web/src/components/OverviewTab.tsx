import React from 'react';
import { MergedDeviceRecord } from '../types/mdm';
import {
  ApprovalBadge,
  EnforcementBadge,
  StaleConnectionBadge,
} from './StatusBadges';
import { formatTimestampAr } from '../utils/validation';
import {
  getDeviceFriendlyName,
  formatEnforcementSummaryAr,
} from '../utils/presentation';
import {
  Smartphone,
  Clock,
  AlertTriangle,
  RefreshCw,
  ArrowLeft,
  ChevronLeft,
  Info,
} from 'lucide-react';

interface OverviewTabProps {
  devices: MergedDeviceRecord[];
  onNavigateDevices: () => void;
  onSelectDevice: (uid: string) => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  devices,
  onNavigateDevices,
  onSelectDevice,
}) => {
  const activeDevices = devices.filter((d) => !d.isArchived);
  const totalDevices = activeDevices.length;
  const pendingCount = activeDevices.filter((d) => d.enforcementState === 'pending').length;
  const errorCount = activeDevices.filter((d) => d.enforcementState === 'error').length;

  let latestSeenMillis: number | null = null;
  for (const d of activeDevices) {
    if (d.lastSeenMs && (latestSeenMillis === null || d.lastSeenMs > latestSeenMillis)) {
      latestSeenMillis = d.lastSeenMs;
    }
  }

  const latestSeenFormatted = formatTimestampAr(latestSeenMillis);

  const attentionDevices = activeDevices.filter(
    (d) =>
      d.approvalState !== 'approved' ||
      d.enforcementState === 'error' ||
      d.enforcementState === 'pending'
  );

  const cards = [
    {
      title: 'إجمالي الأجهزة',
      value: totalDevices,
      subtitle: 'جميع الأجهزة المسجلة',
      icon: <Smartphone className="w-5 h-5 text-slate-700" />,
      border: 'border-slate-200',
    },
    {
      title: 'أجهزة تحتاج متابعة',
      value: attentionDevices.length,
      subtitle: 'اعتماد أو انتظار تأكيد أو خطأ',
      icon: <Clock className="w-5 h-5 text-amber-600" />,
      border: attentionDevices.length > 0 ? 'border-amber-300' : 'border-slate-200',
    },
    {
      title: 'تغييرات بانتظار تأكيد الهاتف',
      value: pendingCount,
      subtitle: 'حُفظت بالخادم وبانتظار الهاتف',
      icon: <RefreshCw className="w-5 h-5 text-blue-600" />,
      border: pendingCount > 0 ? 'border-blue-200' : 'border-slate-200',
    },
    {
      title: 'مشاكل تطبيق السياسة',
      value: errorCount,
      subtitle: 'أجهزة أبلغت عن تعذر التطبيق',
      icon: <AlertTriangle className="w-5 h-5 text-red-600" />,
      border: errorCount > 0 ? 'border-red-300' : 'border-slate-200',
    },
  ];

  return (
    <div className="space-y-6" dir="rtl">
      {/* Concise Sync Explanation Banner */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="p-2.5 rounded-xl bg-blue-50 text-blue-700 border border-blue-200 shrink-0 mt-0.5">
            <Info className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              آلية تطبيق السياسات على هواتف المندوبين
            </h3>
            <p className="text-xs text-slate-600 mt-1 leading-relaxed max-w-3xl">
              عند تعديل أي سياسة أو تطبيق، <strong className="text-slate-900">يُحفظ التغيير في الخادم أولاً</strong> ثم يطبقه الهاتف ويرسل تأكيد التنفيذ عند اتصاله بالشبكة.
            </p>
          </div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 shrink-0 md:text-left">
          <div className="text-xs text-slate-500">آخر تواصل مسجل من أي هاتف</div>
          <div className="text-sm font-bold text-slate-900 mt-0.5">
            {latestSeenMillis ? latestSeenFormatted.relative : 'لا يوجد بعد'}
          </div>
          {latestSeenMillis && (
            <div className="text-[11px] text-slate-500 mt-0.5">
              {latestSeenFormatted.formatted}
            </div>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c, idx) => (
          <div
            key={idx}
            onClick={onNavigateDevices}
            className={`p-5 rounded-xl border bg-white ${c.border} shadow-xs hover:shadow-md transition-all cursor-pointer flex flex-col justify-between`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-600">{c.title}</span>
              {c.icon}
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-bold text-slate-900">{c.value}</span>
              <span className="text-xs text-slate-500">{c.subtitle}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Attention Required List */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/60">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              الأجهزة التي تحتاج إلى متابعة ({attentionDevices.length})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              أجهزة بانتظار اعتماد المدير، أو لديها تعديلات بانتظار تأكيد الهاتف، أو أبلغت عن مشكلة في تطبيق القيود.
            </p>
          </div>
          <button
            type="button"
            onClick={onNavigateDevices}
            className="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 cursor-pointer"
          >
            <span>عرض كافة الأجهزة</span>
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
        </div>

        {attentionDevices.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            جميع الأجهزة المعتمدة مطبقة لأحدث السياسات ولا توجد مشاكل معلقة حالياً.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {attentionDevices.slice(0, 8).map((d) => {
              const friendlyName = getDeviceFriendlyName(d);
              const tsInfo = formatTimestampAr(d.lastSeenMs);
              const enforcementInfo = formatEnforcementSummaryAr(d);
              return (
                <div
                  key={d.uid}
                  onClick={() => onSelectDevice(d.uid)}
                  className="px-5 py-4 hover:bg-slate-50 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4 cursor-pointer"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-slate-900">
                        {friendlyName}
                      </span>
                      <ApprovalBadge state={d.approvalState} />
                      <EnforcementBadge state={d.enforcementState} />
                      <StaleConnectionBadge isStale={d.isStaleConnection} />
                    </div>
                    <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>المندوب: {d.metadata?.rep_name || 'غير محدد'}</span>
                      {d.status?.model && (
                        <>
                          <span>•</span>
                          <span dir="ltr">{d.status.model}</span>
                        </>
                      )}
                      <span>•</span>
                      <span>آخر تواصل: {tsInfo.relative}</span>
                    </div>
                    <p className="text-xs text-slate-700">
                      {enforcementInfo.summary}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectDevice(d.uid);
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold bg-blue-50 text-blue-700 hover:bg-blue-600 hover:text-white border border-blue-200 transition-colors cursor-pointer"
                    >
                      <span>إدارة الجهاز</span>
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
