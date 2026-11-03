package com.company.mdmagent;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.UserManager;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Unified, multi-feature device restrictions manager.
 * Reconciles user restrictions from:
 * 1. Company Kiosk Policy (DISALLOW_INSTALL_APPS, DISALLOW_UNINSTALL_APPS, DISALLOW_INSTALL_UNKNOWN_SOURCES,
 *    DISALLOW_SAFE_BOOT, DISALLOW_ADD_USER, DISALLOW_CREATE_WINDOWS)
 * 2. Independent App Install Policy (DISALLOW_INSTALL_APPS, DISALLOW_INSTALL_UNKNOWN_SOURCES)
 * 3. Tethering Policy (DISALLOW_CONFIG_TETHERING)
 * 4. Location Policy (DISALLOW_CONFIG_LOCATION)
 *
 * Guarantees:
 * - Persistent ownership journal ("owned_restrictions").
 * - Pre-existing restrictions (not applied by Injaz) are NEVER removed.
 * - Lifting restrictions for one feature (e.g. Kiosk maintenance or disable) NEVER lifts restrictions
 *   still demanded by another active feature (e.g. independent install policy).
 */
public final class RestrictionManager {
    public static final String PREFS_NAME = "injaz-restrictions";
    public static final String KEY_OWNED_RESTRICTIONS = "owned_restrictions";

    interface RestrictionClearHook {
        void beforeClear(String restriction);
    }
    static RestrictionClearHook clearHookForTest;

    private RestrictionManager() {}

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static Set<String> getOwnedRestrictions(Context context) {
        return prefs(context).getStringSet(KEY_OWNED_RESTRICTIONS, Collections.emptySet());
    }

    /**
     * Safely migrates legacy Kiosk-owned restrictions from injaz-kiosk into the unified manager
     * without treating existing Injaz restrictions as external pre-existing ones.
     */
    public static synchronized void migrateLegacyKioskRestrictions(Context context) {
        SharedPreferences legacyPrefs = context.getSharedPreferences(KioskController.PREFS, Context.MODE_PRIVATE);
        if (legacyPrefs.contains("owned_restrictions")) {
            Set<String> legacyOwned = legacyPrefs.getStringSet("owned_restrictions", Collections.emptySet());
            if (legacyOwned != null && !legacyOwned.isEmpty()) {
                SharedPreferences unifiedPrefs = prefs(context);
                Set<String> currentUnified = new HashSet<>(unifiedPrefs.getStringSet(KEY_OWNED_RESTRICTIONS, Collections.emptySet()));
                currentUnified.addAll(legacyOwned);
                unifiedPrefs.edit().putStringSet(KEY_OWNED_RESTRICTIONS, currentUnified).apply();
            }
        }
    }

    private static void requireSave(boolean ok) {
        if (!ok) throw new IllegalStateException("تعذر حفظ سجل ملكية قيود النظام");
    }

    /**
     * Calculates the union of all restrictions required by active features on the device.
     */
    public static Set<String> computeRequiredRestrictions(Context context,
                                                           boolean kioskActiveAndEnabled,
                                                           boolean blockAppInstalls,
                                                           boolean blockTethering,
                                                           boolean blockLocationConfig) {
        Set<String> required = new HashSet<>();

        if (blockTethering) {
            required.add(UserManager.DISALLOW_CONFIG_TETHERING);
        }

        if (blockLocationConfig) {
            required.add(UserManager.DISALLOW_CONFIG_LOCATION);
        }

        if (kioskActiveAndEnabled) {
            required.add(UserManager.DISALLOW_INSTALL_APPS);
            required.add(UserManager.DISALLOW_UNINSTALL_APPS);
            required.add(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES);
            required.add(UserManager.DISALLOW_SAFE_BOOT);
            required.add(UserManager.DISALLOW_ADD_USER);
            required.add(UserManager.DISALLOW_CREATE_WINDOWS);
        }

        if (blockAppInstalls) {
            required.add(UserManager.DISALLOW_INSTALL_APPS);
            required.add(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES);
        }

        return required;
    }

    /**
     * Atomically reconciles current system restrictions with the set of required restrictions.
     */
    public static synchronized void reconcile(Context context,
                                               Set<String> requiredRestrictions) throws Exception {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(context, AdminReceiver.class);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) {
            throw new IllegalStateException("صلاحية Device Owner غير متوفرة لإدارة قيود النظام");
        }

        SharedPreferences p = prefs(context);
        Set<String> previouslyOwned = new HashSet<>(p.getStringSet(KEY_OWNED_RESTRICTIONS, Collections.emptySet()));
        Bundle currentSystem = dpm.getUserRestrictions(admin);

        // 1. Identify new restrictions to apply and own
        Set<String> newlyOwned = new HashSet<>(previouslyOwned);
        for (String req : requiredRestrictions) {
            if (!currentSystem.getBoolean(req, false)) {
                newlyOwned.add(req);
            }
        }
        requireSave(p.edit().putStringSet(KEY_OWNED_RESTRICTIONS, newlyOwned).commit());

        // 2. Apply all required restrictions
        List<String> applyErrors = new ArrayList<>();
        for (String req : requiredRestrictions) {
            try {
                dpm.addUserRestriction(admin, req);
                if (!dpm.getUserRestrictions(admin).getBoolean(req, false)) {
                    applyErrors.add("applyFailed:" + req);
                }
            } catch (Exception ex) {
                applyErrors.add(req + ": " + ex.getMessage());
            }
        }
        if (!applyErrors.isEmpty()) {
            throw new IllegalStateException("فشل تطبيق بعض قيود النظام: " + String.join(", ", applyErrors));
        }

        // 3. Clear restrictions that are owned by Injaz but NO LONGER required by ANY active feature
        Set<String> toRemove = new HashSet<>(newlyOwned);
        toRemove.removeAll(requiredRestrictions);

        List<String> clearErrors = new ArrayList<>();
        Set<String> remainingOwned = new HashSet<>(newlyOwned);

        for (String rem : toRemove) {
            try {
                if (clearHookForTest != null) {
                    clearHookForTest.beforeClear(rem);
                }
                dpm.clearUserRestriction(admin, rem);
                if (dpm.getUserRestrictions(admin).getBoolean(rem, false)) {
                    clearErrors.add("clearFailed:" + rem);
                } else {
                    remainingOwned.remove(rem);
                }
            } catch (Exception ex) {
                clearErrors.add(rem + ": " + ex.getClass().getSimpleName() + (ex.getMessage() == null ? "" : ": " + ex.getMessage()));
            }
        }
        requireSave(p.edit().putStringSet(KEY_OWNED_RESTRICTIONS, remainingOwned).commit());

        if (!clearErrors.isEmpty()) {
            throw new IllegalStateException("فشل إزالة بعض قيود النظام: " + String.join(", ", clearErrors));
        }
    }

    /**
     * Clears ALL Injaz-owned restrictions during authorized deprovisioning.
     * Pre-existing restrictions are untouched.
     */
    public static synchronized void clearAllOwned(Context context) throws Exception {
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(context, AdminReceiver.class);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) {
            return;
        }

        SharedPreferences p = prefs(context);
        Set<String> owned = new HashSet<>(p.getStringSet(KEY_OWNED_RESTRICTIONS, Collections.emptySet()));
        List<String> errors = new ArrayList<>();
        Set<String> remaining = new HashSet<>(owned);

        for (String r : owned) {
            try {
                dpm.clearUserRestriction(admin, r);
                if (dpm.getUserRestrictions(admin).getBoolean(r, false)) {
                    errors.add("clearFailed:" + r);
                } else {
                    remaining.remove(r);
                }
            } catch (Exception ex) {
                errors.add(r + ": " + ex.getMessage());
            }
        }
        requireSave(p.edit().putStringSet(KEY_OWNED_RESTRICTIONS, remaining).commit());
        if (!errors.isEmpty()) {
            throw new IllegalStateException("فشل إزالة بعض القيود المملوكة: " + String.join(", ", errors));
        }
    }
}
