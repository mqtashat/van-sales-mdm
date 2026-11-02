import React, { useState, useMemo } from 'react';
import {
  Search,
  Layers,
  Shield,
  Ban,
  Check,
  Smartphone,
  Sliders,
  Plus,
  Info,
} from 'lucide-react';
import type { MergedDeviceRecord } from '../types/mdm';
import {
  CURATED_APP_CATALOG,
  lookupAppInfo,
  type CatalogAppEntry,
} from '../utils/appCatalog';
import { HARDCODED_PROTECTED_PACKAGES } from '../utils/validation';

interface FleetAppsTabProps {
  devices: MergedDeviceRecord[];
  onTriggerBulkActionForApp: (pkg: string, action: 'block_apps' | 'allow_apps') => void;
}

export const FleetAppsTab: React.FC<FleetAppsTabProps> = ({
  devices,
  onTriggerBulkActionForApp,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [customPackage, setCustomPackage] = useState('');

  // Aggregate application usage across all devices by packageName
  const aggregatedApps = useMemo(() => {
    const pkgMap = new Map<
      string,
      {
        packageName: string;
        nameAr: string;
        nameEn: string;
        category: string;
        isProtected: boolean;
        protectionReason?: string;
        badgeBg: string;
        badgeTextColor: string;
        descriptionAr: string;
        blockedDeviceUids: string[];
        allowedDeviceUids: string[];
      }
    >();

    // 1. Seed with curated catalog
    for (const item of CURATED_APP_CATALOG) {
      pkgMap.set(item.packageName, {
        packageName: item.packageName,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        category: item.category,
        isProtected: Boolean(item.isProtected),
        protectionReason: item.protectionReason,
        badgeBg: item.badgeBg,
        badgeTextColor: item.badgeTextColor,
        descriptionAr: item.descriptionAr,
        blockedDeviceUids: [],
        allowedDeviceUids: [],
      });
    }

    // 2. Discover any additional packages from device policies
    for (const d of devices) {
      if (d.policy?.blocked_apps) {
        for (const pkg of d.policy.blocked_apps) {
          if (!pkgMap.has(pkg)) {
            const info = lookupAppInfo(pkg);
            pkgMap.set(pkg, {
              packageName: pkg,
              nameAr: info.nameAr,
              nameEn: info.nameEn,
              category: info.category,
              isProtected: info.isProtected,
              protectionReason: info.protectionReason,
              badgeBg: info.badgeBg,
              badgeTextColor: info.badgeTextColor,
              descriptionAr: info.descriptionAr,
              blockedDeviceUids: [],
              allowedDeviceUids: [],
            });
          }
        }
      }
    }

    // 3. Calculate blocked and allowed device counts per package
    for (const app of pkgMap.values()) {
      for (const d of devices) {
        if (d.approvalState === 'approved') {
          const isBlockedOnDevice = d.policy?.blocked_apps?.includes(app.packageName) ?? false;
          if (isBlockedOnDevice) {
            app.blockedDeviceUids.push(d.uid);
          } else if (!app.isProtected) {
            app.allowedDeviceUids.push(d.uid);
          }
        }
      }
    }

    return Array.from(pkgMap.values());
  }, [devices]);

  // Filtered applications
  const filteredApps = useMemo(() => {
    return aggregatedApps.filter((app) => {
      // Category filter
      if (categoryFilter !== 'all') {
        if (categoryFilter === 'blocked_anywhere' && app.blockedDeviceUids.length === 0) return false;
        if (categoryFilter === 'protected' && !app.isProtected) return false;
        if (categoryFilter !== 'blocked_anywhere' && categoryFilter !== 'protected' && app.category !== categoryFilter) {
          return false;
        }
      }

      // Search
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      return (
        app.nameAr.toLowerCase().includes(q) ||
        app.nameEn.toLowerCase().includes(q) ||
        app.packageName.toLowerCase().includes(q) ||
        app.descriptionAr.toLowerCase().includes(q)
      );
    });
  }, [aggregatedApps, categoryFilter, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Header & Explanation */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">دليل التطبيقات والإجراءات العامة</h2>
          <p className="text-xs text-slate-600 mt-1 leading-relaxed">
            استعرض التطبيقات الشائعة أو المحظورة على مستوى الأجهزة، واطّلع على عدد الأجهزة الممنوع أو المسموح عليها التطبيق، وطبّق إجراءات جماعية بنقرة واحدة.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-semibold">
            إجمالي التطبيقات المدرجة: {aggregatedApps.length}
          </span>
        </div>
      </div>

      {/* Search and Category Filters */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث باسم التطبيق (تيك توك، يوتيوب، ببجي...) أو اسم الحزمة…"
            className="w-full pr-9 pl-3 py-2 bg-white border border-slate-300 rounded-xl text-xs focus:outline-hidden focus:ring-1 focus:ring-blue-600 shadow-2xs"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto text-xs font-semibold">
          <button
            type="button"
            onClick={() => setCategoryFilter('all')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              categoryFilter === 'all'
                ? 'bg-slate-900 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            الكل
          </button>
          <button
            type="button"
            onClick={() => setCategoryFilter('blocked_anywhere')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              categoryFilter === 'blocked_anywhere'
                ? 'bg-red-700 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            المحظورة على أجهزة
          </button>
          <button
            type="button"
            onClick={() => setCategoryFilter('social')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              categoryFilter === 'social'
                ? 'bg-blue-700 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            تواصل اجتماعي
          </button>
          <button
            type="button"
            onClick={() => setCategoryFilter('games')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              categoryFilter === 'games'
                ? 'bg-amber-700 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            ألعاب
          </button>
          <button
            type="button"
            onClick={() => setCategoryFilter('protected')}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              categoryFilter === 'protected'
                ? 'bg-slate-700 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            محمي برمجياً
          </button>
        </div>
      </div>

      {/* Applications Directory Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredApps.map((app) => {
          const hasDevicesBlocked = app.blockedDeviceUids.length > 0;
          return (
            <div
              key={app.packageName}
              className={`bg-white border rounded-xl p-4 flex flex-col justify-between transition-colors shadow-2xs ${
                hasDevicesBlocked ? 'border-red-200' : 'border-slate-200'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 ${app.badgeBg} ${app.badgeTextColor}`}
                    >
                      {app.nameAr.slice(0, 1)}
                    </div>
                    <div>
                      <h4 className="font-bold text-slate-900 text-xs">{app.nameAr}</h4>
                      <span className="font-mono text-[10px] text-slate-400 block truncate max-w-[180px]">
                        {app.packageName}
                      </span>
                    </div>
                  </div>

                  {app.isProtected ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-800 shrink-0">
                      <Shield className="w-3 h-3" />
                      <span>محمي</span>
                    </span>
                  ) : hasDevicesBlocked ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800 shrink-0">
                      <Ban className="w-3 h-3" />
                      <span>ممنوع ({app.blockedDeviceUids.length})</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800 shrink-0">
                      <Check className="w-3 h-3" />
                      <span>مسموح للكل</span>
                    </span>
                  )}
                </div>

                <p className="text-slate-600 text-[11px] mt-2.5 leading-relaxed line-clamp-2">
                  {app.protectionReason || app.descriptionAr}
                </p>
              </div>

              {/* Stats & Bulk Trigger Bar */}
              <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                <div className="text-[11px] text-slate-500 space-x-2 space-x-reverse">
                  <span>ممنوع: <strong className="font-mono text-slate-800">{app.blockedDeviceUids.length}</strong></span>
                  <span>·</span>
                  <span>مسموح: <strong className="font-mono text-slate-800">{app.allowedDeviceUids.length}</strong></span>
                </div>

                {!app.isProtected && (
                  <div className="flex items-center gap-1.5">
                    {app.blockedDeviceUids.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onTriggerBulkActionForApp(app.packageName, 'allow_apps')}
                        className="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-800 font-bold rounded-lg text-[11px] transition-colors"
                      >
                        السماح
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onTriggerBulkActionForApp(app.packageName, 'block_apps')}
                      className="px-2.5 py-1 bg-red-50 hover:bg-red-100 border border-red-300 text-red-800 font-bold rounded-lg text-[11px] transition-colors"
                    >
                      منع بالأجهزة…
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
