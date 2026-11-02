/**
 * Curated catalog of common applications on sales representatives' Android devices.
 * Allows non-technical managers to search, recognize, and manage apps by Arabic name
 * rather than typing raw package strings.
 */

export interface CatalogAppEntry {
  packageName: string;
  nameAr: string;
  nameEn: string;
  category: 'social' | 'games' | 'video' | 'browsers' | 'tools' | 'system';
  isProtected?: boolean;
  protectionReason?: string;
  badgeBg: string;
  badgeTextColor: string;
  descriptionAr: string;
}

export const CURATED_APP_CATALOG: CatalogAppEntry[] = [
  // --- Social & Entertainment ---
  {
    packageName: 'com.zhiliaoapp.musically',
    nameAr: 'تيك توك (TikTok)',
    nameEn: 'TikTok',
    category: 'social',
    badgeBg: 'bg-black',
    badgeTextColor: 'text-white',
    descriptionAr: 'منصة مقاطع الفيديو القصيرة والترفيه.',
  },
  {
    packageName: 'com.ss.android.ugc.trill',
    nameAr: 'تيك توك لايت (TikTok Lite)',
    nameEn: 'TikTok Lite',
    category: 'social',
    badgeBg: 'bg-black',
    badgeTextColor: 'text-white',
    descriptionAr: 'نسخة مخففة من تطبيق تيك توك.',
  },
  {
    packageName: 'com.snapchat.android',
    nameAr: 'سناب شات (Snapchat)',
    nameEn: 'Snapchat',
    category: 'social',
    badgeBg: 'bg-yellow-400',
    badgeTextColor: 'text-black',
    descriptionAr: 'تطبيق التراسل المصور والقصص اليومية.',
  },
  {
    packageName: 'com.instagram.android',
    nameAr: 'إنستغرام (Instagram)',
    nameEn: 'Instagram',
    category: 'social',
    badgeBg: 'bg-pink-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'مشاركة الصور ومقاطع الفيديو والريلز.',
  },
  {
    packageName: 'com.facebook.katana',
    nameAr: 'فيسبوك (Facebook)',
    nameEn: 'Facebook',
    category: 'social',
    badgeBg: 'bg-blue-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'شبكة التواصل الاجتماعي فيسبوك.',
  },
  {
    packageName: 'com.facebook.orca',
    nameAr: 'ماسنجر فيسبوك (Messenger)',
    nameEn: 'Facebook Messenger',
    category: 'social',
    badgeBg: 'bg-blue-500',
    badgeTextColor: 'text-white',
    descriptionAr: 'تطبيق التراسل الفوري من فيسبوك.',
  },
  {
    packageName: 'com.whatsapp',
    nameAr: 'واتساب (WhatsApp)',
    nameEn: 'WhatsApp',
    category: 'social',
    badgeBg: 'bg-emerald-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'تطبيق المراسلة الفورية والمكالمات الأكثر انتشارًا.',
  },
  {
    packageName: 'com.whatsapp.w4b',
    nameAr: 'واتساب للأعمال (WhatsApp Business)',
    nameEn: 'WhatsApp Business',
    category: 'social',
    badgeBg: 'bg-emerald-700',
    badgeTextColor: 'text-white',
    descriptionAr: 'حسابات واتساب للأعمال وخدمة العملاء.',
  },
  {
    packageName: 'org.telegram.messenger',
    nameAr: 'تيليجرام (Telegram)',
    nameEn: 'Telegram',
    category: 'social',
    badgeBg: 'bg-sky-500',
    badgeTextColor: 'text-white',
    descriptionAr: 'تطبيق التراسل والقنوات والمجموعات.',
  },
  {
    packageName: 'com.twitter.android',
    nameAr: 'إكس / تويتر (X / Twitter)',
    nameEn: 'X / Twitter',
    category: 'social',
    badgeBg: 'bg-slate-900',
    badgeTextColor: 'text-white',
    descriptionAr: 'منصة التدوين المصغر والأخبار.',
  },

  // --- Video & Streaming ---
  {
    packageName: 'com.netflix.mediaclient',
    nameAr: 'نتفلكس (Netflix)',
    nameEn: 'Netflix',
    category: 'video',
    badgeBg: 'bg-red-700',
    badgeTextColor: 'text-white',
    descriptionAr: 'خدمة بث الأفلام والمسلسلات.',
  },
  {
    packageName: 'com.mbc.shahid',
    nameAr: 'شاهد (Shahid)',
    nameEn: 'Shahid',
    category: 'video',
    badgeBg: 'bg-amber-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'منصة البث والمسلسلات العربية.',
  },
  {
    packageName: 'com.google.android.youtube',
    nameAr: 'يوتيوب (YouTube)',
    nameEn: 'YouTube',
    category: 'video',
    badgeBg: 'bg-red-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'منصة مشاركة مقاطع الفيديو (قد يكون تطبيق نظام مدمج).',
  },

  // --- Games ---
  {
    packageName: 'com.tencent.ig',
    nameAr: 'ببجي موبايل (PUBG Mobile)',
    nameEn: 'PUBG Mobile',
    category: 'games',
    badgeBg: 'bg-amber-700',
    badgeTextColor: 'text-white',
    descriptionAr: 'لعبة المعارك التنافسية متعددة اللاعبين.',
  },
  {
    packageName: 'com.dts.freefireth',
    nameAr: 'فري فاير (Free Fire)',
    nameEn: 'Free Fire',
    category: 'games',
    badgeBg: 'bg-orange-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'لعبة البقاء والمعارك عبر الإنترنت.',
  },
  {
    packageName: 'com.roblox.client',
    nameAr: 'روبلوكس (Roblox)',
    nameEn: 'Roblox',
    category: 'games',
    badgeBg: 'bg-slate-800',
    badgeTextColor: 'text-white',
    descriptionAr: 'منصة الألعاب والمجتمعات التفاعلية.',
  },
  {
    packageName: 'com.bipfun.ludo',
    nameAr: 'لودو ستار (Ludo Star)',
    nameEn: 'Ludo Star',
    category: 'games',
    badgeBg: 'bg-indigo-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'لعبة النرد اللوحية التنافسية.',
  },
  {
    packageName: 'com.kiloo.subwaysurf',
    nameAr: 'صب واي سيرفرز (Subway Surfers)',
    nameEn: 'Subway Surfers',
    category: 'games',
    badgeBg: 'bg-amber-500',
    badgeTextColor: 'text-black',
    descriptionAr: 'لعبة الركض اللانهائي الشهيرة.',
  },

  // --- Alternative Browsers & Downloaders ---
  {
    packageName: 'com.opera.browser',
    nameAr: 'متصفح أوبرا (Opera)',
    nameEn: 'Opera Browser',
    category: 'browsers',
    badgeBg: 'bg-red-500',
    badgeTextColor: 'text-white',
    descriptionAr: 'متصفح إنترنت مع مانع إعلانات وVPN مدمج.',
  },
  {
    packageName: 'org.mozilla.firefox',
    nameAr: 'فايرفوكس (Firefox)',
    nameEn: 'Firefox',
    category: 'browsers',
    badgeBg: 'bg-orange-500',
    badgeTextColor: 'text-white',
    descriptionAr: 'متصفح الإنترنت موزيلا فايرفوكس.',
  },
  {
    packageName: 'com.UCMobile.intl',
    nameAr: 'يو سي براوزر (UC Browser)',
    nameEn: 'UC Browser',
    category: 'browsers',
    badgeBg: 'bg-amber-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'متصفح ومدير تحميلات مستقل.',
  },

  // --- Protected System & Agent Core Applications ---
  {
    packageName: 'com.company.mdmagent',
    nameAr: 'إنجاز | وكيل إدارة الأجهزة (INJAZ MDM)',
    nameEn: 'INJAZ MDM Agent',
    category: 'system',
    isProtected: true,
    protectionReason: 'وكيل الإدارة نفسه (Device Owner) — محمي برمجياً لمنع قفل الإدارة عن الهاتف.',
    badgeBg: 'bg-blue-800',
    badgeTextColor: 'text-white',
    descriptionAr: 'تطبيق الوكيل المسؤول عن استلام وتطبيق سياسات الشركة.',
  },
  {
    packageName: 'com.android.settings',
    nameAr: 'إعدادات أندرويد (Settings)',
    nameEn: 'Android Settings',
    category: 'system',
    isProtected: true,
    protectionReason: 'إعدادات النظام الأساسية — محمي لمنع تعطل واجهة الهاتف.',
    badgeBg: 'bg-slate-700',
    badgeTextColor: 'text-white',
    descriptionAr: 'لوحة التحكم والضبط الأساسية لنظام أندرويد.',
  },
  {
    packageName: 'com.android.systemui',
    nameAr: 'واجهة النظام (System UI)',
    nameEn: 'System UI',
    category: 'system',
    isProtected: true,
    protectionReason: 'شريط الحالة وأزرار التنقل وقفل الشاشة — محمي في كود الوكيل.',
    badgeBg: 'bg-slate-700',
    badgeTextColor: 'text-white',
    descriptionAr: 'الواجهة المرئية لنظام أندرويد.',
  },
  {
    packageName: 'com.google.android.gms',
    nameAr: 'خدمات Google Play (GMS)',
    nameEn: 'Google Play Services',
    category: 'system',
    isProtected: true,
    protectionReason: 'خدمات Google Play ضرورية لاتصال Firebase ومزامنة السياسات.',
    badgeBg: 'bg-blue-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'إطار خدمات Google للاتصال السحابي والمصادقة.',
  },
  {
    packageName: 'com.google.android.gsf',
    nameAr: 'إطار خدمات Google (GSF)',
    nameEn: 'Google Services Framework',
    category: 'system',
    isProtected: true,
    protectionReason: 'إطار نظام Google الأساسي.',
    badgeBg: 'bg-blue-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'خدمات إطار عمل Google المدمجة.',
  },
  {
    packageName: 'com.android.vending',
    nameAr: 'متجر Google Play (Play Store)',
    nameEn: 'Google Play Store',
    category: 'system',
    isProtected: true,
    protectionReason: 'متجر التطبيقات الرسمي — محمي في كود الوكيل.',
    badgeBg: 'bg-emerald-600',
    badgeTextColor: 'text-white',
    descriptionAr: 'المتجر الرسمي لتحديث وتثبيت التطبيقات.',
  },
];

const CATALOG_BY_PACKAGE = new Map<string, CatalogAppEntry>(
  CURATED_APP_CATALOG.map((item) => [item.packageName, item])
);

/**
 * Looks up friendly metadata for a package name from the curated catalog or produces a friendly fallback.
 */
export function lookupAppInfo(packageName: string): {
  nameAr: string;
  nameEn: string;
  category: CatalogAppEntry['category'] | 'other';
  isProtected: boolean;
  protectionReason?: string;
  badgeBg: string;
  badgeTextColor: string;
  descriptionAr: string;
} {
  const match = CATALOG_BY_PACKAGE.get(packageName);
  if (match) {
    return {
      nameAr: match.nameAr,
      nameEn: match.nameEn,
      category: match.category,
      isProtected: Boolean(match.isProtected),
      protectionReason: match.protectionReason,
      badgeBg: match.badgeBg,
      badgeTextColor: match.badgeTextColor,
      descriptionAr: match.descriptionAr,
    };
  }

  // Derive readable name from package name segments
  const parts = packageName.split('.');
  const lastPart = parts[parts.length - 1] || packageName;
  const humanized = lastPart
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    nameAr: humanized,
    nameEn: humanized,
    category: 'other',
    isProtected: false,
    badgeBg: 'bg-slate-600',
    badgeTextColor: 'text-white',
    descriptionAr: `تطبيق يحمل اسم الحزمة (${packageName}).`,
  };
}

/**
 * Searches the curated catalog by query string matching Arabic name, English name, or package.
 */
export function searchCuratedCatalog(query: string): CatalogAppEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return CURATED_APP_CATALOG;
  return CURATED_APP_CATALOG.filter(
    (item) =>
      item.nameAr.toLowerCase().includes(q) ||
      item.nameEn.toLowerCase().includes(q) ||
      item.packageName.toLowerCase().includes(q) ||
      item.descriptionAr.toLowerCase().includes(q)
  );
}
