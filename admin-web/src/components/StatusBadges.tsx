import React from 'react';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
  FileQuestion,
  WifiOff,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import type { ApprovalState, EnforcementState } from '../types/mdm';

export const ApprovalBadge: React.FC<{ state: ApprovalState }> = ({ state }) => {
  if (state === 'approved') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
        <span>معتمد</span>
      </span>
    );
  }
  if (state === 'pending_approval') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
        <Clock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
        <span>ينتظر الاعتماد</span>
      </span>
    );
  }
  if (state === 'corrupted_enrollment') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-800 bg-red-50 border border-red-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
        <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />
        <span>بيانات اعتماد غير صالحة</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
      <Clock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
      <span>ينتظر الاعتماد</span>
    </span>
  );
};

export const EnforcementBadge: React.FC<{ state: EnforcementState }> = ({ state }) => {
  if (state === 'applied') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
        <span>مطبق بالهاتف</span>
      </span>
    );
  }
  if (state === 'pending') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-800 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
        <Clock className="w-3.5 h-3.5 text-blue-600 shrink-0" />
        <span>بانتظار تأكيد الهاتف</span>
      </span>
    );
  }
  if (state === 'corrupted_policy') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-900 bg-red-100 border border-red-300 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
        <AlertTriangle className="w-3.5 h-3.5 text-red-700 shrink-0" />
        <span>تحتاج مراجعة الإعدادات</span>
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-800 bg-red-50 border border-red-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
        <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />
        <span>تنبيه في التنفيذ</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
      <FileQuestion className="w-3.5 h-3.5 text-slate-500 shrink-0" />
      <span>بدون سياسة مخصصة</span>
    </span>
  );
};

export const StaleConnectionBadge: React.FC<{ isStale: boolean }> = ({ isStale }) => {
  if (!isStale) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
      <WifiOff className="w-3.5 h-3.5 text-amber-600 shrink-0" />
      <span>اتصال قديم</span>
    </span>
  );
};

export const DeviceOwnerBadge: React.FC<{ isOwner: boolean | null | undefined }> = ({
  isOwner,
}) => {
  if (isOwner === true) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
        <span>صلاحية الإدارة مفعّلة</span>
      </span>
    );
  }
  if (isOwner === false) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-800 bg-red-50 border border-red-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
        <ShieldAlert className="w-3.5 h-3.5 text-red-600 shrink-0" />
        <span>صلاحية الإدارة غير مفعّلة</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0">
      <AlertTriangle className="w-3.5 h-3.5 text-slate-400 shrink-0" />
      <span>بانتظار أول اتصال من الهاتف</span>
    </span>
  );
};
