export type MainTab =
  | 'overview'
  | 'devices'
  | 'apps'
  | 'company_apps'
  | 'locations'
  | 'audit'
  | 'settings';
export type DeviceManagementTabId =
  | 'overview'
  | 'apps'
  | 'kiosk'
  | 'tethering'
  | 'install_policy'
  | 'location'
  | 'actions'
  | 'history';

const VALID_DEVICE_TABS: DeviceManagementTabId[] = [
  'overview',
  'apps',
  'kiosk',
  'tethering',
  'install_policy',
  'location',
  'actions',
  'history',
];

export interface AppRouteState {
  tab: MainTab;
  deviceUid: string | null;
  deviceTab: DeviceManagementTabId;
  settingsSection: 'general' | 'advanced';
  hash: string;
}

export function buildHashForRoute(
  tab: MainTab,
  deviceUid: string | null = null,
  settingsSection: 'general' | 'advanced' = 'general',
  deviceTab: DeviceManagementTabId = 'overview'
): string {
  if (tab === 'devices' && deviceUid) {
    const encodedUid = encodeURIComponent(deviceUid);
    if (deviceTab && deviceTab !== 'overview') {
      return `#/devices/${encodedUid}/${deviceTab}`;
    }
    return `#/devices/${encodedUid}`;
  }
  if (tab === 'settings' && settingsSection === 'advanced') {
    return '#/settings/advanced';
  }
  return `#/${tab}`;
}

export function parseRouteFromHash(hashStr: string): AppRouteState {
  const cleaned = hashStr.replace(/^#\/?/, '').trim();
  if (!cleaned || cleaned === 'overview') {
    return {
      tab: 'overview',
      deviceUid: null,
      deviceTab: 'overview',
      settingsSection: 'general',
      hash: '#/overview',
    };
  }
  if (cleaned.startsWith('devices/')) {
    const rest = cleaned.slice('devices/'.length).trim();
    const segments = rest.split('/').filter(Boolean);
    const uid = segments[0] ? decodeURIComponent(segments[0].trim()) : null;
    const rawSubTab = segments[1]?.trim() as DeviceManagementTabId | undefined;
    const deviceTab: DeviceManagementTabId =
      rawSubTab && VALID_DEVICE_TABS.includes(rawSubTab) ? rawSubTab : 'overview';

    if (!uid) {
      return {
        tab: 'devices',
        deviceUid: null,
        deviceTab: 'overview',
        settingsSection: 'general',
        hash: '#/devices',
      };
    }

    return {
      tab: 'devices',
      deviceUid: uid,
      deviceTab,
      settingsSection: 'general',
      hash: buildHashForRoute('devices', uid, 'general', deviceTab),
    };
  }
  if (cleaned === 'devices') {
    return {
      tab: 'devices',
      deviceUid: null,
      deviceTab: 'overview',
      settingsSection: 'general',
      hash: '#/devices',
    };
  }
  if (cleaned === 'apps') {
    return {
      tab: 'apps',
      deviceUid: null,
      deviceTab: 'overview',
      settingsSection: 'general',
      hash: '#/apps',
    };
  }
  if (cleaned === 'company_apps') {
    return {
      tab: 'company_apps',
      deviceUid: null,
      deviceTab: 'overview',
      settingsSection: 'general',
      hash: '#/company_apps',
    };
  }
  if (cleaned === 'locations') {
    return {
      tab: 'locations',
      deviceUid: null,
      deviceTab: 'overview',
      settingsSection: 'general',
      hash: '#/locations',
    };
  }
  if (cleaned === 'audit') {
    return {
      tab: 'audit',
      deviceUid: null,
      deviceTab: 'overview',
      settingsSection: 'general',
      hash: '#/audit',
    };
  }
  if (cleaned === 'settings/advanced') {
    return {
      tab: 'settings',
      deviceUid: null,
      deviceTab: 'overview',
      settingsSection: 'advanced',
      hash: '#/settings/advanced',
    };
  }
  if (cleaned === 'settings') {
    return {
      tab: 'settings',
      deviceUid: null,
      deviceTab: 'overview',
      settingsSection: 'general',
      hash: '#/settings',
    };
  }
  return {
    tab: 'overview',
    deviceUid: null,
    deviceTab: 'overview',
    settingsSection: 'general',
    hash: '#/overview',
  };
}

export function areRoutesEqual(a: AppRouteState, b: AppRouteState): boolean {
  return (
    a.tab === b.tab &&
    a.deviceUid === b.deviceUid &&
    a.deviceTab === b.deviceTab &&
    a.settingsSection === b.settingsSection
  );
}

