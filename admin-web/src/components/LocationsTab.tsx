import React, { useState, useEffect, useMemo, useRef } from 'react';
import type { Firestore } from 'firebase/firestore';
import { doc, setDoc, serverTimestamp, collection } from 'firebase/firestore';
import type * as LeafletModule from 'leaflet';
import type { AdminIdentity, DeviceLocationPoint, MergedDeviceRecord } from '../types/mdm.ts';
import { subscribeToDeviceLocations, cleanOldLocations } from '../services/mdmService.ts';
import {
  MapPin,
  RefreshCw,
  Trash2,
  Navigation,
  Compass,
  AlertTriangle,
  Info,
  Calendar,
  Battery,
  Gauge,
  Clock,
  Shield,
  Search,
} from 'lucide-react';

interface LocationsTabProps {
  db: Firestore;
  adminIdentity: AdminIdentity | null;
  devices: MergedDeviceRecord[];
}

export const LocationsTab: React.FC<LocationsTabProps> = ({
  db,
  adminIdentity,
  devices,
}) => {
  const [selectedUid, setSelectedUid] = useState<string>('');
  const [points, setPoints] = useState<DeviceLocationPoint[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTrackingOnly, setFilterTrackingOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [statusNotice, setStatusNotice] = useState('');
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);

  const [L, setL] = useState<typeof LeafletModule | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<any>(null);
  const layerGroupRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      import('leaflet').then((mod) => {
        setL(mod.default || mod);
      });
    }
  }, []);

  // Default to first active device with location enabled or first device
  useEffect(() => {
    if (!selectedUid && devices.length > 0) {
      const firstActive =
        devices.find((d) => !d.isArchived && d.status?.location_policy_enabled) ||
        devices.find((d) => !d.isArchived) ||
        devices[0];
      if (firstActive) setSelectedUid(firstActive.uid);
    }
  }, [devices, selectedUid]);

  // Subscribe to device location breadcrumbs
  useEffect(() => {
    if (!selectedUid) {
      setPoints([]);
      setPermissionNotice(null);
      return;
    }
    setPermissionNotice(null);
    const unsub = subscribeToDeviceLocations(
      db,
      selectedUid,
      100,
      (list) => {
        setPoints(list);
      },
      {
        onError: (err) => {
          const msg = err.message || '';
          if (
            (err as { code?: string })?.code === 'permission-denied' ||
            msg.includes('Missing or insufficient permissions') ||
            msg.includes('permission-denied')
          ) {
            setPermissionNotice(
              'بيانات المسار الميداني للنقاط بانتظار اعتماد قواعد أمان Firestore للنقاط الميدانية أو تسجيل أول نقطة من الجهاز المعتمد.'
            );
          } else {
            setPermissionNotice('تعذر قراءة نقاط الموقع حالياً: ' + msg);
          }
        },
      }
    );
    return () => unsub();
  }, [db, selectedUid]);

  const selectedDevice = useMemo(
    () => devices.find((d) => d.uid === selectedUid),
    [devices, selectedUid]
  );

  const filteredDevices = useMemo(() => {
    return devices.filter((d) => {
      if (d.isArchived) return false;
      if (filterTrackingOnly && !d.status?.location_policy_enabled) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const devName = (d.metadata?.device_name || '').toLowerCase();
      const repName = (d.metadata?.rep_name || '').toLowerCase();
      const model = (d.status?.model || '').toLowerCase();
      return (
        devName.includes(q) ||
        repName.includes(q) ||
        model.includes(q) ||
        d.uid.toLowerCase().includes(q)
      );
    });
  }, [devices, searchQuery, filterTrackingOnly]);

  const latestPoint = points[0] || null;

  // Initialize Leaflet Map once
  useEffect(() => {
    if (!L || !mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      const map = L.map(mapContainerRef.current, {
        center: [31.95, 35.91], // Amman / Jordan default center
        zoom: 12,
        zoomControl: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      const layers = L.layerGroup().addTo(map);
      layerGroupRef.current = layers;
      mapInstanceRef.current = map;
    }

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        layerGroupRef.current = null;
      }
    };
  }, [L]);

  // Update map markers, polyline and bounds whenever points change
  useEffect(() => {
    if (!L) return;
    const map = mapInstanceRef.current;
    const layerGroup = layerGroupRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();

    if (points.length === 0) {
      return;
    }

    // Points come newest-first from Firestore; reverse for chronological polyline
    const chronological = [...points].reverse();
    const latLngs = chronological.map(
      (p) => [p.latitude, p.longitude] as [number, number]
    );

    // 1. Draw route polyline
    if (latLngs.length > 1) {
      L.polyline(latLngs, {
        color: '#4f46e5',
        weight: 4,
        opacity: 0.85,
        dashArray: '5, 8',
      }).addTo(layerGroup);
    }

    // 2. Draw historical breadcrumbs
    chronological.slice(0, chronological.length - 1).forEach((p, index) => {
      const timeStr = p.recorded_at?.toDate
        ? p.recorded_at.toDate().toLocaleTimeString('ar-SA')
        : typeof p.recorded_at === 'number'
        ? new Date(p.recorded_at).toLocaleTimeString('ar-SA')
        : 'نقطة سابقة';

      const circle = L.circleMarker([p.latitude, p.longitude], {
        radius: 6,
        color: '#ffffff',
        fillColor: '#6366f1',
        fillOpacity: 0.9,
        weight: 1.5,
      });

      circle.bindPopup(`
        <div style="font-family: 'IBM Plex Sans Arabic', sans-serif; direction: rtl; text-align: right; min-width: 180px;">
          <div style="font-weight: bold; color: #1e1b4b; margin-bottom: 4px;">نقطة مسار #${index + 1}</div>
          <div style="font-size: 11px; color: #475569; margin-bottom: 2px;">الوقت: <strong>${timeStr}</strong></div>
          <div style="font-size: 11px; color: #475569; margin-bottom: 2px;">الإحداثيات: <span dir="ltr">${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}</span></div>
          <div style="font-size: 11px; color: #475569; margin-bottom: 2px;">الدقة: <strong>${p.accuracy_meters.toFixed(0)} متر</strong></div>
          <div style="font-size: 11px; color: #475569;">السرعة: <strong>${(p.speed_mps * 3.6).toFixed(0)} كم/س</strong></div>
        </div>
      `);

      circle.addTo(layerGroup);
    });

    // 3. Draw latest location with accuracy circle
    if (latestPoint) {
      // Accuracy Circle
      L.circle([latestPoint.latitude, latestPoint.longitude], {
        radius: latestPoint.accuracy_meters || 20,
        color: '#10b981',
        fillColor: '#10b981',
        fillOpacity: 0.18,
        weight: 1.5,
      }).addTo(layerGroup);

      // Latest Pin
      const latestTimeStr = latestPoint.recorded_at?.toDate
        ? latestPoint.recorded_at.toDate().toLocaleString('ar-SA')
        : typeof latestPoint.recorded_at === 'number'
        ? new Date(latestPoint.recorded_at).toLocaleString('ar-SA')
        : 'الآن';

      const latestIcon = L.divIcon({
        className: 'custom-live-marker',
        html: `
          <div style="position: relative; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;">
            <div style="position: absolute; width: 28px; height: 28px; border-radius: 50%; background: rgba(16, 185, 129, 0.4); animation: ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite;"></div>
            <div style="width: 20px; height: 20px; border-radius: 50%; background: #059669; border: 3px solid #ffffff; box-shadow: 0 2px 6px rgba(0,0,0,0.3); z-index: 10;"></div>
          </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });

      const marker = L.marker([latestPoint.latitude, latestPoint.longitude], {
        icon: latestIcon,
        zIndexOffset: 1000,
      });

      const devName = selectedDevice?.metadata?.device_name || 'جهاز المندوب';
      const repName = selectedDevice?.metadata?.rep_name || 'غير محدد';

      marker.bindPopup(`
        <div style="font-family: 'IBM Plex Sans Arabic', sans-serif; direction: rtl; text-align: right; min-width: 220px;">
          <div style="font-weight: bold; color: #064e3b; font-size: 14px; margin-bottom: 4px;">📍 الموقع المباشر: ${devName}</div>
          <div style="font-size: 12px; color: #047857; margin-bottom: 6px;">المندوب: ${repName}</div>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 6px 0;" />
          <div style="font-size: 11px; color: #334155; margin-bottom: 3px;">الوقت المسجل: <strong>${latestTimeStr}</strong></div>
          <div style="font-size: 11px; color: #334155; margin-bottom: 3px;">الإحداثيات: <span dir="ltr">${latestPoint.latitude.toFixed(6)}, ${latestPoint.longitude.toFixed(6)}</span></div>
          <div style="font-size: 11px; color: #334155; margin-bottom: 3px;">دقة تحديد الموقع: <strong>±${latestPoint.accuracy_meters.toFixed(0)} متر</strong></div>
          <div style="font-size: 11px; color: #334155; margin-bottom: 3px;">السرعة الحالية: <strong>${(latestPoint.speed_mps * 3.6).toFixed(0)} كم/ساعة</strong></div>
          <div style="font-size: 11px; color: #334155;">شحن البطارية: <strong>${latestPoint.battery_percent}%</strong></div>
          ${latestPoint.is_delayed_sync ? '<div style="margin-top: 6px; padding: 2px 6px; background: #fef3c7; color: #92400e; font-size: 10px; border-radius: 4px;">⚠️ تزامنت بعد استعادة اتصال الشبكة</div>' : ''}
        </div>
      `);

      marker.addTo(layerGroup);
      marker.openPopup();
    }

    // Adjust view
    if (latLngs.length === 1) {
      map.setView(latLngs[0], 15);
    } else if (latLngs.length > 1) {
      const bounds = L.latLngBounds(latLngs);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
    }
  }, [points, selectedDevice, latestPoint]);

  const handleRefreshLocation = async () => {
    if (!selectedUid || !adminIdentity?.isAuthorizedAdmin) return;
    setRefreshing(true);
    setStatusNotice('');
    try {
      const cmdRef = doc(collection(db, 'deviceCommands', selectedUid, 'commands'));
      await setDoc(cmdRef, {
        type: 'refresh_location',
        status: 'pending',
        created_at: serverTimestamp(),
        created_by_uid: adminIdentity.uid,
        created_by_email: adminIdentity.email,
      });
      setStatusNotice('تم إرسال أمر تحديث الإحداثيات المباشر إلى الجهاز بنجاح');
    } catch (err) {
      alert('فشل إرسال أمر التحديث: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRefreshing(false);
    }
  };

  const handleCleanRetention = async () => {
    if (!selectedUid || !adminIdentity?.isAuthorizedAdmin) return;
    if (
      !confirm(
        'هل أنت متأكد من رغبتك في حذف نقاط المسار القديمة الأقدم من 30 يوماً لهذا الجهاز؟\nسيتم تسجيل العملية في سجل التدقيق الرسمي.'
      )
    ) {
      return;
    }

    setCleaning(true);
    setStatusNotice('');
    try {
      const result = await cleanOldLocations(db, selectedUid, 30, {
        uid: adminIdentity.uid,
        email: adminIdentity.email,
      });
      setStatusNotice(
        `تم بنجاح تنظيف سجل المواقع وحذف ${result.deletedCount} نقطة أقدم من 30 يوماً وتسجيل الإجراء في auditLogs.`
      );
    } catch (err) {
      alert('فشل تنظيف النقاط القديمة: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Navigation className="w-5 h-5 text-indigo-600" />
            <span>مواقع أجهزة الشركة والمسارات الميدانية (Leaflet / OSM)</span>
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            متابعة إحداثيات أسطول المبيعات على خريطة تفاعلية حقيقية، مع دوائر الدقة ومسار الحركة، مع دعم المزامنة غير المتصلة وسياسة الاستبقاء
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleCleanRetention}
            disabled={!selectedUid || cleaning || !adminIdentity?.isAuthorizedAdmin}
            title="تنظيف يدوي فوري لنقاط الجهاز الأقدم من 30 يوماً (يتوفر أيضاً تنظيف خادمي مجدول دورياً)"
            className="px-3.5 py-2 bg-slate-100 hover:bg-rose-50 text-slate-700 hover:text-rose-700 border border-slate-200 hover:border-rose-200 rounded-lg text-xs font-bold transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4 text-slate-500 hover:text-rose-600" />
            <span>{cleaning ? 'جارٍ التنظيف اليدوي...' : 'تنظيف يدوي (الأقدم من 30 يوماً)'}</span>
          </button>
          <button
            onClick={handleRefreshLocation}
            disabled={!selectedUid || refreshing}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition shadow-sm flex items-center gap-2 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            <span>{refreshing ? 'جاري الإرسال...' : 'تحديث الموقع الآن'}</span>
          </button>
        </div>
      </div>

      {statusNotice && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-sm flex items-center justify-between">
          <span>{statusNotice}</span>
          <button
            onClick={() => setStatusNotice('')}
            className="text-emerald-600 hover:text-emerald-900 font-bold"
          >
            ×
          </button>
        </div>
      )}

      {permissionNotice && (
        <div className="p-4 bg-amber-50 border border-amber-200 text-amber-900 rounded-lg text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>{permissionNotice}</span>
          </div>
          <button
            onClick={() => setPermissionNotice(null)}
            className="text-amber-700 hover:text-amber-950 font-bold"
          >
            ×
          </button>
        </div>
      )}

      {/* Main Grid: Devices List + Real Leaflet Map & Timeline */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Device Selector */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex flex-col h-[740px]">
          <div className="space-y-3 mb-4">
            <div className="relative">
              <Search className="w-4 h-4 absolute right-3 top-2.5 text-slate-400" />
              <input
                type="text"
                placeholder="بحث باسم الجهاز أو المندوب..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full text-xs pr-9 pl-3 py-2 border border-slate-300 rounded-lg focus:outline-indigo-500"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={filterTrackingOnly}
                onChange={(e) => setFilterTrackingOnly(e.target.checked)}
                className="rounded text-indigo-600"
              />
              <span>إظهار الأجهزة المفعّل لها التتبع فقط</span>
            </label>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 divide-y divide-slate-100">
            {filteredDevices.length === 0 ? (
              <div className="py-12 text-center text-xs text-slate-400">
                لا توجد أجهزة مطابقة للبحث
              </div>
            ) : (
              filteredDevices.map((dev) => {
                const isSelected = dev.uid === selectedUid;
                const isTracking = dev.status?.location_policy_enabled;
                const isGpsOn = dev.status?.location_switch_on;
                return (
                  <div
                    key={dev.uid}
                    onClick={() => setSelectedUid(dev.uid)}
                    className={`pt-2 cursor-pointer p-3 rounded-lg transition ${
                      isSelected
                        ? 'bg-indigo-50 border border-indigo-200 text-indigo-900 font-semibold'
                        : 'hover:bg-slate-50 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-sm truncate">
                        {dev.metadata?.device_name || 'جهاز بدون اسم'}
                      </div>
                      <span className="text-xs font-mono text-slate-600">
                        🔋 {dev.status?.battery_percent !== undefined ? `${dev.status.battery_percent}%` : '—'}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 truncate">
                      المندوب: {dev.metadata?.rep_name || 'غير محدد'}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                          isTracking
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {isTracking ? 'التتبع مفعل' : 'التتبع معطل'}
                      </span>
                      {isTracking && (
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                            isGpsOn
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {isGpsOn ? 'GPS مشغّل' : 'GPS مغلق بالجهاز'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right 2 Columns: Map Canvas and Breadcrumbs Details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Real Leaflet Map Container */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                  <span>خريطة المسار الميداني</span>
                  {selectedDevice && (
                    <span className="text-xs font-normal text-slate-500">
                      ({selectedDevice.metadata?.device_name || 'جهاز'} - {selectedDevice.metadata?.rep_name || 'مندوب'})
                    </span>
                  )}
                </h3>
              </div>
              {latestPoint && (
                <span className="text-xs font-mono text-slate-600 bg-slate-100 px-2 py-1 rounded" dir="ltr">
                  {latestPoint.latitude.toFixed(6)}, {latestPoint.longitude.toFixed(6)}
                </span>
              )}
            </div>

            {/* Map Canvas */}
            <div className="relative w-full h-[440px] rounded-lg overflow-hidden border border-slate-200 z-0">
              <div ref={mapContainerRef} className="w-full h-full" />

              {points.length === 0 && (
                <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center text-center p-6 z-10">
                  <div className="bg-white/95 p-6 rounded-xl border border-slate-200 max-w-sm text-slate-700 shadow-lg">
                    <Compass className="w-10 h-10 text-indigo-500 mx-auto mb-2" />
                    <p className="text-sm font-bold text-slate-800">لا توجد إحداثيات مسجلة لهذا الجهاز حاليًا</p>
                    <p className="text-xs text-slate-500 mt-1">
                      تأكد من تفعيل سياسة التتبع وساعات العمل للجهاز وتوافر اتصال بالإنترنت أو انتظر مزامنة النقاط المحفوظة محليًا.
                    </p>
                  </div>
                </div>
              )}

              {/* Map Footer HUD */}
              {latestPoint && (
                <div className="absolute bottom-2 right-2 left-2 bg-slate-900/85 backdrop-blur-sm border border-slate-700/60 p-2.5 rounded-lg text-slate-200 text-xs flex flex-wrap items-center justify-between gap-2 z-10 shadow-md">
                  <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1">
                      <Gauge className="w-3.5 h-3.5 text-indigo-400" />
                      <span>الدقة: <strong className="text-white">±{latestPoint.accuracy_meters.toFixed(0)}م</strong></span>
                    </span>
                    <span>السرعة: <strong className="text-white">{(latestPoint.speed_mps * 3.6).toFixed(0)} كم/س</strong></span>
                    <span className="flex items-center gap-1">
                      <Battery className="w-3.5 h-3.5 text-emerald-400" />
                      <span>البطارية: <strong className="text-white">{latestPoint.battery_percent}%</strong></span>
                    </span>
                  </div>
                  {latestPoint.is_delayed_sync && (
                    <span className="bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded text-[11px] font-medium">
                      ⚠️ تزامنت بعد استعادة الاتصال
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Breadcrumbs History Timeline */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-600" />
                <span>سجل المسار والنقاط المسجلة ({points.length})</span>
              </h4>
              <span className="text-xs text-slate-400">مرتبة من الأحدث إلى الأقدم</span>
            </div>

            <div className="space-y-2.5 max-h-[220px] overflow-y-auto">
              {points.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-6">لا توجد نقاط مسار سابقة مسجلة</p>
              ) : (
                points.map((p, idx) => {
                  const timeStr = p.recorded_at?.toDate
                    ? p.recorded_at.toDate().toLocaleTimeString('ar-SA')
                    : typeof p.recorded_at === 'number'
                    ? new Date(p.recorded_at).toLocaleTimeString('ar-SA')
                    : 'الآن';

                  return (
                    <div
                      key={p.point_id || idx}
                      className="flex items-center justify-between text-xs p-2.5 bg-slate-50 hover:bg-slate-100 rounded-lg border border-slate-100 transition"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full ${idx === 0 ? 'bg-emerald-500' : 'bg-indigo-400'}`}></span>
                        <div>
                          <span className="font-mono font-medium text-slate-800" dir="ltr">
                            {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)}
                          </span>
                          <span className="text-[11px] text-slate-500 block mt-0.5">
                            دقة: ±{p.accuracy_meters.toFixed(0)}م • سرعة: {(p.speed_mps * 3.6).toFixed(0)} كم/س • بطارية: {p.battery_percent}%
                          </span>
                        </div>
                      </div>
                      <div className="text-left">
                        <span className="text-slate-600 font-mono text-[11px] font-semibold">{timeStr}</span>
                        {p.is_delayed_sync && (
                          <span className="block text-[10px] text-amber-700 font-medium bg-amber-50 px-1 rounded">أوفلاين سابقاً</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
