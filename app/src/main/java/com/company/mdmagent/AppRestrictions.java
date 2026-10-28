package com.company.mdmagent;

import android.app.admin.DevicePolicyManager;
import android.content.*;
import android.content.pm.*;
import android.provider.Settings;
import android.telecom.TelecomManager;
import android.view.inputmethod.InputMethodInfo;
import android.view.inputmethod.InputMethodManager;
import java.util.*;

final class AppRestrictions {
    static void apply(Context context, DevicePolicyManager dpm, ComponentName admin,
                      Set<String> desired, SharedPreferences prefs) throws Exception {
        PackageManager pm = context.getPackageManager();
        Set<String> protectedApps = new HashSet<>(Arrays.asList(
                context.getPackageName(), "com.android.settings", "com.android.systemui",
                "com.google.android.gms", "com.google.android.gsf", "com.android.vending"));
        InputMethodManager ime = (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
        for (InputMethodInfo input : ime.getInputMethodList()) protectedApps.add(input.getPackageName());
        TelecomManager telecom = (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
        if (telecom.getDefaultDialerPackage() != null) protectedApps.add(telecom.getDefaultDialerPackage());
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        ResolveInfo launcher = pm.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY);
        if (launcher != null && launcher.activityInfo != null) protectedApps.add(launcher.activityInfo.packageName);

        // Validate entire desired list before hiding anything. Only downloaded launcher apps in the pilot.
        for (String pkg : desired) {
            if (protectedApps.contains(pkg)) throw new IllegalArgumentException("Protected application: " + pkg);
            ApplicationInfo app;
            try { app = pm.getApplicationInfo(pkg, PackageManager.MATCH_UNINSTALLED_PACKAGES); }
            catch (PackageManager.NameNotFoundException e) { throw new IllegalArgumentException("Application not found/visible: " + pkg); }
            if ((app.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0)
                throw new IllegalArgumentException("Pilot does not hide system apps: " + pkg);
        }
        Set<String> previous = new HashSet<>(prefs.getStringSet("hidden_by_agent", Collections.emptySet()));
        // Journal the full union BEFORE mutations so a later sync can recover after interruption.
        Set<String> journal = new HashSet<>(previous); journal.addAll(desired);
        if (!prefs.edit().putStringSet("hidden_by_agent", journal).commit())
            throw new IllegalStateException("Cannot persist application recovery state");
        for (String pkg : previous) {
            if (!desired.contains(pkg)) {
                boolean changed = dpm.setApplicationHidden(admin, pkg, false);
                if (!changed && dpm.isApplicationHidden(admin, pkg))
                    throw new IllegalStateException("Cannot restore application: " + pkg);
            }
        }
        for (String pkg : desired) {
            dpm.setApplicationHidden(admin, pkg, true);
            if (!dpm.isApplicationHidden(admin, pkg)) throw new IllegalStateException("Cannot hide application: " + pkg);
        }
        if (!prefs.edit().putStringSet("hidden_by_agent", new HashSet<>(desired)).commit())
            throw new IllegalStateException("Cannot persist applied application list");
    }
}
