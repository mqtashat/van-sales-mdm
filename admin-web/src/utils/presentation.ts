import type { AuditLogDoc, MergedDeviceRecord } from '../types/mdm';

/**
 * Resolves a human-friendly display name for a device without exposing raw UIDs in normal views.
 */
export function getDeviceFriendlyName(device: MergedDeviceRecord | undefined | null): string {
  if (!device) return 'جهاز غير مسجل بالاسم';
  const adminName = device.metadata?.device_name?.trim();
  if (adminName) return adminName;
  const repName = device.metadata?.rep_name?.trim();
  const model = device.status?.model?.trim();
  if (repName && model && model !== 'غير معروف') {
    return `هاتف ${repName} (${model})`;
  }
  if (model && model !== 'غير معروف') {
    return `جهاز ${model}`;
  }
  return 'جهاز بدون اسم إداري';
}

/**
 * Converts a technical enforcement detail string into a clear Arabic summary for everyday views,
 * while preserving raw diagnostic text for optional technical details.
 */
export function formatEnforcementSummaryAr(device: MergedDeviceRecord): {
  summary: string;
  technicalDetail: string | null;
} {
  const raw = device.enforcementDetail || '';

  if (device.enforcementState === 'applied') {
    return {
      summary: 'جميع الإعدادات والقيود الحالية مطبقة ومؤكدة من الهاتف.',
      technicalDetail: raw || null,
    };
  }

  if (device.enforcementState === 'no_policy') {
    return {
      summary: 'لم يتم تحديد قيود مخصصة لهذا الجهاز بعد.',
      technicalDetail: raw || null,
    };
  }

  if (device.enforcementState === 'pending') {
    if (!device.status) {
      return {
        summary: 'تم حفظ الإعدادات في النظام، وبانتظار أول اتصال من الهاتف لتطبيقها.',
        technicalDetail: raw || null,
      };
    }
    return {
      summary: 'تم حفظ التعديلات الجديدة، وبانتظار تواصل الهاتف لتأكيد التطبيق.',
      technicalDetail: raw || null,
    };
  }

  if (device.enforcementState === 'corrupted_policy') {
    return {
      summary: 'توجد حقول غير متوافقة في إعدادات السياسة المحفوظة وتحتاج مراجعة.',
      technicalDetail: raw || null,
    };
  }

  // Error states: simplify Java exceptions and technical messages
  if (raw.includes('Device Owner') || !device.status?.device_owner) {
    return {
      summary: 'صلاحية إدارة الجهاز غير مفعّلة على الهاتف؛ يلزم تفعيل وضع إدارة الشركة على الجهاز لتطبيق القيود.',
      technicalDetail: raw || null,
    };
  }

  if (raw.includes('stale revision') || raw.includes('تعارض إصدارات')) {
    return {
      summary: 'رقم إصدار الإعدادات على الهاتف أحدث من المحفوظ حاليًا؛ احفظ الإعدادات مجددًا لمزامنتها.',
      technicalDetail: raw || null,
    };
  }

  if (raw.includes('حالة منع المشاركة الفعلية')) {
    return {
      summary: 'إعداد مشاركة الإنترنت على الهاتف لا يطابق الإعداد المطلوب بعد.',
      technicalDetail: raw || null,
    };
  }

  // Generic error from phone
  const hasJavaException = /[A-Za-z]+Exception|Error:/.test(raw);
  if (hasJavaException) {
    return {
      summary: 'أبلغ الهاتف عن تعذر تطبيق بعض القيود. راجع التفاصيل التقنية لمعرفة السبب.',
      technicalDetail: raw,
    };
  }

  return {
    summary: raw || 'توجد ملاحظة في تطبيق الإعدادات على الجهاز.',
    technicalDetail: raw || null,
  };
}

/**
 * Formats an audit log summary for normal display by replacing raw UIDs and technical terms
 * with the friendly device name, without mutating the underlying audit log record.
 */
export function formatAuditLogSummaryAr(
  log: AuditLogDoc,
  deviceMap: Map<string, MergedDeviceRecord>
): string {
  const device = deviceMap.get(log.target_uid);
  const friendlyName = getDeviceFriendlyName(device);
  let text = log.summary || '';

  if (log.target_uid) {
    // Replace "(UID)" with friendly device name or remove redundant raw UID
    text = text.replace(`(${log.target_uid})`, `«${friendlyName}»`);
    text = text.replace(log.target_uid, friendlyName);
  }

  text = text
    .replace(/البيانات الوصفية/g, 'بيانات التعريف')
    .replace(/منع المشاركة=مفعّل/g, 'مشاركة الإنترنت: ممنوعة')
    .replace(/منع المشاركة=ملغى/g, 'مشاركة الإنترنت: مسموحة')
    .replace(/تطبيقات محظورة=/g, 'عدد التطبيقات المحظورة: ');

  return text;
}
