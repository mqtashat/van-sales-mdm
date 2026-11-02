import React, { useState, useMemo, useRef } from 'react';
import {
  X,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ShieldAlert,
  RotateCcw,
  Play,
  StopCircle,
} from 'lucide-react';
import type { Firestore } from 'firebase/firestore';
import type {
  AdminIdentity,
  BulkActionType,
  BulkDeviceExecutionResult,
  MergedDeviceRecord,
} from '../types/mdm';
import { computeBulkActionPlan } from '../utils/validation';
import { executeBulkDeviceAction } from '../services/mdmService';
import { lookupAppInfo } from '../utils/appCatalog';

interface BulkActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  devices: MergedDeviceRecord[];
  selectedUids: string[];
  actionType: BulkActionType;
  actionParams: {
    packages?: string[];
    allowTethering?: boolean;
  };
  db: Firestore;
  actor: AdminIdentity;
  onFinished?: () => void;
}

export const BulkActionModal: React.FC<BulkActionModalProps> = ({
  isOpen,
  onClose,
  devices,
  selectedUids,
  actionType,
  actionParams,
  db,
  actor,
  onFinished,
}) => {
  const [phase, setPhase] = useState<'preview' | 'executing' | 'completed'>('preview');
  const [results, setResults] = useState<Record<string, BulkDeviceExecutionResult>>({});
  const cancelSignalRef = useRef<{ isCancelled: boolean }>({ isCancelled: false });

  // Compute live plan based on current device records and action params
  const planItems = useMemo(() => {
    return computeBulkActionPlan(devices, selectedUids, actionType, actionParams);
  }, [devices, selectedUids, actionType, actionParams]);

  const eligibleItems = planItems.filter((item) => item.eligible && item.hasActualChanges);
  const skippedItems = planItems.filter((item) => !item.eligible || !item.hasActualChanges);

  const getActionTitle = () => {
    switch (actionType) {
      case 'block_apps':
        return `منع ${actionParams.packages?.length || 0} تطبيق على الأجهزة المحددة`;
      case 'allow_apps':
        return `السماح بـ ${actionParams.packages?.length || 0} تطبيق على الأجهزة المحددة`;
      case 'set_tethering':
        return actionParams.allowTethering
          ? 'السماح بمشاركة الإنترنت (Hotspot) على الأجهزة المحددة'
          : 'منع مشاركة الإنترنت (Hotspot) على الأجهزة المحددة';
    }
  };

  const handleStartExecution = async (itemsToRun = eligibleItems) => {
    if (itemsToRun.length === 0) return;
    setPhase('executing');
    cancelSignalRef.current = { isCancelled: false };

    // Initialize initial result map with pending status for items to run
    const initialMap: Record<string, BulkDeviceExecutionResult> = { ...results };
    for (const item of itemsToRun) {
      initialMap[item.uid] = {
        uid: item.uid,
        deviceName: item.deviceName,
        repName: item.repName,
        status: 'in_progress',
        message: 'جارٍ فتح المعاملة والتحقق من الإصدار في الخادم…',
      };
    }
    // Record skipped items
    for (const item of skippedItems) {
      if (!initialMap[item.uid]) {
        initialMap[item.uid] = {
          uid: item.uid,
          deviceName: item.deviceName,
          repName: item.repName,
          status: 'skipped',
          message: item.skipReason || 'تم التخطي لعدم وجود تعديل فعلي.',
        };
      }
    }
    setResults(initialMap);

    await executeBulkDeviceAction(db, itemsToRun, actor, {
      concurrency: 3,
      cancelSignal: cancelSignalRef.current,
      onDeviceCompleted: (res) => {
        setResults((prev) => ({
          ...prev,
          [res.uid]: res,
        }));
      },
    });

    setPhase('completed');
    onFinished?.();
  };

  const handleCancelExecution = () => {
    cancelSignalRef.current.isCancelled = true;
  };

  const handleRetryFailed = () => {
    const failedUids = Object.values(results)
      .filter((r) => r.status === 'error' || r.status === 'conflict')
      .map((r) => r.uid);

    // Recompute plan for failed devices from latest records
    const retryPlan = computeBulkActionPlan(devices, failedUids, actionType, actionParams);
    const retryEligible = retryPlan.filter((p) => p.eligible && p.hasActualChanges);
    void handleStartExecution(retryEligible);
  };

  if (!isOpen) return null;

  const resultsList = Object.values(results);
  const successCount = resultsList.filter((r) => r.status === 'saved_pending_phone').length;
  const conflictCount = resultsList.filter((r) => r.status === 'conflict').length;
  const errorCount = resultsList.filter((r) => r.status === 'error').length;
  const skippedCount = resultsList.filter((r) => r.status === 'skipped').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden text-right">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div>
            <h3 className="text-base font-bold text-slate-900">{getActionTitle()}</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              إجراء جماعي آمن يُنفّذ كمعاملة مستقلة لكل جهاز مع حماية التعارض
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={phase === 'executing'}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-sm">
          {/* Target Apps Summary when applicable */}
          {actionParams.packages && actionParams.packages.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
              <span className="text-xs font-bold text-slate-700 block mb-2">
                التطبيقات المستهدفة ({actionParams.packages.length}):
              </span>
              <div className="flex flex-wrap gap-2">
                {actionParams.packages.map((pkg) => {
                  const info = lookupAppInfo(pkg);
                  return (
                    <span
                      key={pkg}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-white border border-slate-300 text-slate-800"
                    >
                      <span className={`w-2 h-2 rounded-full ${info.badgeBg}`} />
                      <span>{info.nameAr}</span>
                      <span className="text-[10px] text-slate-400 font-mono font-normal">
                        ({pkg})
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Phase 1: Preview */}
          {phase === 'preview' && (
            <div className="space-y-4">
              {/* Honest Notice */}
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-start gap-3 text-xs text-blue-900">
                <AlertTriangle className="w-5 h-5 text-blue-700 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold">معاينة التغييرات قبل الحفظ في الخادم</p>
                  <p className="leading-relaxed">
                    سيتم تعديل كل جهاز بمعاملة منفصلة دون استبدال الحزم الأخرى، ولن يُرفع رقم
                    الإصدار للجهاز الذي يطابق التعديل المطلوب مسبقاً. نجاح الحفظ بالخادم يعني وصول
                    الطلب وبانتظار مزامنة وتأكيد الهاتف.
                  </p>
                </div>
              </div>

              {/* Counts Breakdown */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                  <span className="text-emerald-800 font-semibold block">
                    أجهزة جاهزة للتطبيق ({eligibleItems.length})
                  </span>
                  <span className="text-emerald-950 text-[11px] mt-0.5 block">
                    معتمدة وتتطلب تحديثاً فعلياً في سياستها.
                  </span>
                </div>
                <div className="bg-slate-100 border border-slate-200 rounded-xl p-3">
                  <span className="text-slate-800 font-semibold block">
                    أجهزة ستُتخطى ({skippedItems.length})
                  </span>
                  <span className="text-slate-600 text-[11px] mt-0.5 block">
                    إما غير معتمدة أو مطابقة للتعديل المطلوب مسبقاً.
                  </span>
                </div>
              </div>

              {/* Items List */}
              <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100 max-h-60 overflow-y-auto">
                {planItems.map((item) => (
                  <div
                    key={item.uid}
                    className={`p-3 flex items-center justify-between text-xs ${
                      item.eligible ? 'bg-white' : 'bg-slate-50/70'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900">{item.deviceName}</span>
                        <span className="text-slate-500">({item.repName})</span>
                      </div>
                      <span className="font-mono text-[10px] text-slate-400">{item.uid}</span>
                    </div>

                    <div>
                      {item.eligible ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>سيتم رفع الإصدار والحفظ</span>
                        </span>
                      ) : (
                        <span className="text-slate-500 text-[11px]">{item.skipReason}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Phase 2 & 3: Execution and Results */}
          {(phase === 'executing' || phase === 'completed') && (
            <div className="space-y-4">
              {/* Progress Summary Cards */}
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl">
                  <span className="block text-lg font-bold font-mono text-emerald-800">
                    {successCount}
                  </span>
                  <span className="text-emerald-700 text-[11px]">تم الحفظ</span>
                </div>
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                  <span className="block text-lg font-bold font-mono text-amber-800">
                    {conflictCount}
                  </span>
                  <span className="text-amber-700 text-[11px]">تعارض تعديل</span>
                </div>
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl">
                  <span className="block text-lg font-bold font-mono text-red-800">
                    {errorCount}
                  </span>
                  <span className="text-red-700 text-[11px]">فشل</span>
                </div>
                <div className="p-3 bg-slate-100 border border-slate-200 rounded-xl">
                  <span className="block text-lg font-bold font-mono text-slate-800">
                    {skippedCount}
                  </span>
                  <span className="text-slate-600 text-[11px]">تم التخطي</span>
                </div>
              </div>

              {/* Status explanation */}
              {phase === 'executing' ? (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center justify-between text-xs text-blue-900">
                  <span className="font-semibold flex items-center gap-2">
                    <Clock className="w-4 h-4 animate-spin text-blue-700" />
                    <span>جارٍ معالجة الأجهزة على الخادم (بحد أقصى 3 بالتوازي)…</span>
                  </span>
                  <button
                    type="button"
                    onClick={handleCancelExecution}
                    className="inline-flex items-center gap-1 px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700 text-xs font-semibold"
                  >
                    <StopCircle className="w-3.5 h-3.5" />
                    <span>إلغاء المتبقي</span>
                  </button>
                </div>
              ) : (
                <div
                  className={`p-3 rounded-xl border text-xs font-medium ${
                    errorCount > 0 || conflictCount > 0
                      ? 'bg-amber-50 border-amber-200 text-amber-950'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-950'
                  }`}
                >
                  {errorCount > 0 || conflictCount > 0
                    ? 'اكتملت العملية جزئياً. بعض الأجهزة تعثرت بسبب تعارض أو خطأ بالصلاحيات. يمكنك إعادة محاولة الأجهزة المتعثرة.'
                    : 'اكتمل حفظ السياسات لجميع الأجهزة المستهدفة بنجاح وبانتظار تأكيد كل هاتف عند المزامنة.'}
                </div>
              )}

              {/* Device Progress List */}
              <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100 max-h-64 overflow-y-auto">
                {resultsList.map((res) => (
                  <div key={res.uid} className="p-3 flex items-start justify-between gap-3 text-xs">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900">{res.deviceName}</span>
                        <span className="text-slate-500">({res.repName})</span>
                      </div>
                      <p className="text-[11px] text-slate-600 mt-0.5 leading-relaxed">
                        {res.message}
                      </p>
                    </div>

                    <div className="shrink-0 mt-0.5">
                      {res.status === 'saved_pending_phone' && (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>بانتظار الهاتف</span>
                        </span>
                      )}
                      {res.status === 'in_progress' && (
                        <span className="inline-flex items-center gap-1 text-blue-700 font-semibold">
                          <Clock className="w-3.5 h-3.5 animate-spin" />
                          <span>جارٍ الحفظ…</span>
                        </span>
                      )}
                      {res.status === 'conflict' && (
                        <span className="inline-flex items-center gap-1 text-amber-700 font-semibold">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>تعارض تعديل</span>
                        </span>
                      )}
                      {res.status === 'error' && (
                        <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
                          <ShieldAlert className="w-3.5 h-3.5" />
                          <span>فشل الحفظ</span>
                        </span>
                      )}
                      {res.status === 'skipped' && (
                        <span className="text-slate-400 font-medium">تم التخطي</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          {phase === 'preview' ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold transition-colors"
              >
                إلغاء
              </button>

              <button
                type="button"
                disabled={eligibleItems.length === 0}
                onClick={() => void handleStartExecution()}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-blue-700 hover:bg-blue-800 disabled:bg-slate-300 text-white rounded-xl text-xs font-bold transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                <span>تنفيذ على {eligibleItems.length} جهاز</span>
              </button>
            </>
          ) : (
            <>
              {(errorCount > 0 || conflictCount > 0) && phase === 'completed' ? (
                <button
                  type="button"
                  onClick={handleRetryFailed}
                  className="inline-flex items-center gap-1.5 px-4 py-2 border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 rounded-xl text-xs font-bold transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>إعادة محاولة الأجهزة المتعثرة ({errorCount + conflictCount})</span>
                </button>
              ) : (
                <div />
              )}

              <button
                type="button"
                disabled={phase === 'executing'}
                onClick={onClose}
                className="px-5 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition-colors"
              >
                إغلاق
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
