import React from 'react';
import {
  CheckCircle2,
  Clock,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  ArrowLeft,
  Info,
  Smartphone,
  ChevronLeft,
} from 'lucide-react';
import type { MergedDeviceRecord } from '../types/mdm';
import { formatLastSeenAr } from '../utils/validation';
import {
  ApprovalBadge,
  EnforcementBadge,
  StaleConnectionBadge,
} from './StatusBadges';

interface OverviewTabProps {
  devices: MergedDeviceRecord[];
  loading: boolean;
  onSelectDeviceForPolicy: (uid: string) => void;
  onNavigateDevices: (filter?: string) => void;
  onNavigateEnrollments: () => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  devices,
  loading,
  onSelectDeviceForPolicy,
  onNavigateDevices,
  onNavigateEnrollments,
}) => {
  // Compute real metrics strictly from actual Firestore data
  const totalCount = devices.length;
  const pendingApprovalCount = devices.filter((d) => d.approvalState !== 'approved').length;
  const pendingSyncCount = devices.filter((d) => d.enforcementState === 'pending').length;
  const policyErrorsCount = devices.filter((d) => d.enforcementState === 'error').length;
  const attentionDevices = devices.filter(
    (d) =>
      d.enforcementState === 'error' ||
      d.approvalState !== 'approved' ||
      d.enforcementState === 'pending'
  );

  // Latest sync timestamp across all reporting devices
  const latestSeenMs = devices.reduce<number | null>((acc, d) => {
    if (!d.lastSeenMs) return acc;
    if (acc === null || d.lastSeenMs > acc) return d.lastSeenMs;
    return acc;
  }, null);

  const latestSyncDetails = formatLastSeenAr(latestSeenMs);

  return (
    <div className="space-y-6 text-right">
      {/* Honest Operational Notice Banner */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-2xs">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-blue-50 text-blue-800 rounded-xl shrink-0 mt-0.5">
            <Info className="w-5 h-5" />
          </div>
          <div className="text-xs text-slate-700 space-y-1 leading-relaxed">
            <h3 className="font-bold text-slate-900 text-sm">
              طبيعة متابعة أجهزة المندوبين وتنفيذ السياسات
            </h3>
            <p>
              عند تعديل السياسة، <strong className="text-slate-900">يُحفظ التغيير بالخادم أولاً وبانتظار تأكيد الهاتف</strong>.{' '}
              المزامنة في الخلفية دورية (أو فورية عبر FCM والخدمة الأمامية بالوكيل 0.3.1+ عند توفر الشبكة)، وتخضع لقيود نظام أندرويد لتوفير الطاقة.{' '}
              لا يُعد قِدَم آخر تواصل دليلاً قاطعاً على انقطاع الهاتف، كما أن اعتماد الجهاز لا يثبت تطبيق السياسة حتى يرد تقرير هاتف يطابق الإصدار.
            </p>
          </div>
        </div>

        <div className="shrink-0 border-t md:border-t-0 md:border-r border-slate-200 pt-3 md:pt-0 md:pr-4">
          <span className="block text-[11px] text-slate-500">آخر تواصل مسجل من أي هاتف</span>
          <span className="block text-sm font-bold font-mono text-slate-900 mt-0.5">
            {latestSyncDetails.relative}
          </span>
          <span className="block text-[11px] font-mono text-slate-400 mt-0.5">
            {latestSyncDetails.formatted}
          </span>
        </div>
      </div>

      {/* 4 Primary Clear KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 1. Total Devices */}
        <button
          type="button"
          onClick={() => onNavigateDevices('all')}
          className="text-right bg-white border border-slate-200 hover:border-slate-300 rounded-xl p-5 transition-colors flex flex-col justify-between shadow-2xs group"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-bold text-slate-600">إجمالي الأجهزة</span>
            <Smartphone className="w-4 h-4 text-slate-500 group-hover:text-blue-700 transition-colors" />
          </div>
          <div className="mt-4 flex items-baseline justify-between">
            <span className="text-3xl font-bold font-mono text-slate-900 tabular-nums">
              {loading ? '...' : totalCount}
            </span>
            <span className="text-xs text-slate-500 font-medium">
              جميع المسجلين
            </span>
          </div>
        </button>

        {/* 2. Attention Needed */}
        <button
          type="button"
          onClick={() => onNavigateDevices('all')}
          className="text-right bg-white border border-slate-200 hover:border-amber-300 rounded-xl p-5 transition-colors flex flex-col justify-between shadow-2xs group"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-bold text-slate-600">أجهزة تحتاج متابعة</span>
            <Clock className="w-4 h-4 text-amber-600" />
          </div>
          <div className="mt-4 flex items-baseline justify-between">
            <span className="text-3xl font-bold font-mono text-amber-700 tabular-nums">
              {loading ? '...' : attentionDevices.length}
            </span>
            <span className="text-xs text-amber-800 font-semibold">
              اعتماد أو مزامنة أو خطأ
            </span>
          </div>
        </button>

        {/* 3. Pending Phone Confirmation */}
        <button
          type="button"
          onClick={() => onNavigateDevices('pending')}
          className="text-right bg-white border border-slate-200 hover:border-blue-300 rounded-xl p-5 transition-colors flex flex-col justify-between shadow-2xs group"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-bold text-slate-600">تغييرات بانتظار التطبيق</span>
            <RefreshCw className="w-4 h-4 text-blue-700" />
          </div>
          <div className="mt-4 flex items-baseline justify-between">
            <span className="text-3xl font-bold font-mono text-blue-800 tabular-nums">
              {loading ? '...' : pendingSyncCount}
            </span>
            <span className="text-xs text-blue-800 font-semibold">
              حُفظت وبانتظار تأكيد الهاتف
            </span>
          </div>
        </button>

        {/* 4. Execution Errors */}
        <button
          type="button"
          onClick={() => onNavigateDevices('error')}
          className="text-right bg-white border border-slate-200 hover:border-red-300 rounded-xl p-5 transition-colors flex flex-col justify-between shadow-2xs group"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-bold text-slate-600">أخطاء التنفيذ</span>
            <AlertTriangle className="w-4 h-4 text-red-600" />
          </div>
          <div className="mt-4 flex items-baseline justify-between">
            <span
              className={`text-3xl font-bold font-mono tabular-nums ${
                policyErrorsCount > 0 ? 'text-red-700' : 'text-slate-900'
              }`}
            >
              {loading ? '...' : policyErrorsCount}
            </span>
            <span className="text-xs text-red-800 font-semibold">
              أبلغ الهاتف عن فشل
            </span>
          </div>
        </button>
      </div>

      {/* Actionable List of Devices Needing Intervention */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              قائمة مختصرة بالأجهزة المحتاجة لتدخل ({attentionDevices.length})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              أجهزة تنتظر اعتماد المسؤول، أو لديها سياسة جديدة بانتظار المزامنة، أو أبلغت عن خطأ في فرض القيود.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateDevices('all')}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900 whitespace-nowrap shrink-0"
          >
            <span>عرض كافة الأجهزة</span>
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500">
            جارٍ تحميل البيانات من الخادم…
          </div>
        ) : attentionDevices.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-sm font-bold text-slate-800">
              {devices.length === 0
                ? 'لا توجد أجهزة مسجلة في النظام حتى الآن.'
                : 'جميع الأجهزة تعمل بصورة مستقرة ومطابقة للسياسات المطلوبة.'}
            </p>
            <p className="text-xs text-slate-500">
              {devices.length === 0
                ? 'يمكنك إضافة جهاز جديد من صفحة «الأجهزة» باستخدام معرّف UID المنسوخ من هاتف المندوب.'
                : 'لا توجد أجهزة تتطلب تدخلاً عاجلاً حالياً.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {attentionDevices.slice(0, 8).map((item) => {
              const lastSeen = formatLastSeenAr(item.lastSeenMs);
              const deviceName = item.metadata?.device_name || 'جهاز بدون اسم إداري';
              const repName = item.metadata?.rep_name || 'غير محدد';
              const model = item.status?.model || 'طراز غير معروف';

              return (
                <div
                  key={item.uid}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/80 transition-colors text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 text-sm">{deviceName}</span>
                      <ApprovalBadge state={item.approvalState} />
                      <EnforcementBadge state={item.enforcementState} />
                      <StaleConnectionBadge isStale={item.isStaleConnection} />
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-slate-500 text-[11px]">
                      <span>المندوب: {repName}</span>
                      <span>·</span>
                      <span>{model}</span>
                      <span>·</span>
                      <span>آخر تواصل: {lastSeen.relative}</span>
                    </div>

                    <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                      {item.enforcementDetail}
                    </p>
                  </div>

                  <div className="shrink-0 pt-2 sm:pt-0">
                    <button
                      type="button"
                      onClick={() => onSelectDeviceForPolicy(item.uid)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-50 hover:bg-blue-100 text-blue-800 font-bold rounded-xl text-xs transition-colors whitespace-nowrap"
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
