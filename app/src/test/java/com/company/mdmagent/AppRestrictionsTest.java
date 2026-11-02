package com.company.mdmagent;

import org.junit.Test;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.Assert.*;

public class AppRestrictionsTest {
    static class Fake implements AppRestrictions.Backend, AppRestrictions.Journal {
        Set<String> hidden = new HashSet<>();
        Set<String> persisted = new HashSet<>();
        Map<String, String> protectedApps = new HashMap<>();
        Set<String> failHide = new HashSet<>(), failRestore = new HashSet<>();
        boolean saveAllowed = true;
        final List<String> calls = new ArrayList<>();
        public String protectionReason(String pkg) { return protectedApps.get(pkg); }
        public boolean isHidden(String pkg) { return hidden.contains(pkg); }
        public void setHidden(String pkg, boolean hide) {
            calls.add(pkg + ":" + hide);
            if (hide) {
                assertTrue("Recovery intent must be durable before hide", persisted.contains(pkg));
                if (failHide.contains(pkg)) throw new SecurityException("OS refused");
                hidden.add(pkg);
            } else {
                if (failRestore.contains(pkg)) throw new SecurityException("restore refused");
                hidden.remove(pkg);
            }
        }
        public boolean save(Set<String> packages) {
            if (!saveAllowed) return false;
            persisted = new HashSet<>(packages);
            return true;
        }
    }

    @Test public void protectedAndRejectedAppsDoNotBlockOtherAppsOrTethering() {
        Fake f = new Fake();
        f.protectedApps.put("com.android.settings", "protected");
        f.failHide.add("com.example.refused");
        AtomicBoolean tethering = new AtomicBoolean();
        PolicyApplication.Result result = PolicyApplication.apply(() -> tethering.set(true),
                () -> AppRestrictions.reconcile(Set.of("com.android.settings", "com.example.refused", "com.example.allowed"), Set.of(), f, f));
        assertTrue(tethering.get());
        assertTrue(f.hidden.contains("com.example.allowed"));
        assertFalse(f.hidden.contains("com.android.settings"));
        assertFalse(f.persisted.contains("com.android.settings"));
        assertTrue(result.error().contains("com.android.settings"));
        assertTrue(result.error().contains("com.example.refused"));
        assertFalse(result.complete());
    }

    @Test public void tetheringFailureDoesNotStopAppEnforcement() {
        Fake f = new Fake();
        PolicyApplication.Result r = PolicyApplication.apply(() -> { throw new SecurityException("tethering refused"); },
                () -> AppRestrictions.reconcile(Set.of("com.example.app"), Set.of(), f, f));
        assertTrue(f.hidden.contains("com.example.app"));
        assertFalse(r.complete());
        assertTrue(r.appsError.isEmpty());
    }

    @Test public void failedRestoreIsKeptInJournalAndOtherAppsAreProcessed() {
        Fake f = new Fake();
        f.hidden.addAll(Set.of("com.example.old", "com.example.restore"));
        f.persisted.addAll(f.hidden);
        f.failRestore.add("com.example.old");
        AppRestrictions.Result r = AppRestrictions.reconcile(Set.of("com.example.new"), f.persisted, f, f);
        assertFalse(r.complete());
        assertEquals(Set.of("com.example.old", "com.example.new"), f.persisted);
        f.failRestore.clear();
        r = AppRestrictions.reconcile(Set.of("com.example.new"), f.persisted, f, f);
        assertTrue(r.complete());
        assertEquals(Set.of("com.example.new"), f.hidden);
        assertEquals(Set.of("com.example.new"), f.persisted);
    }

    @Test public void persistenceFailurePreventsHideButNotTethering() {
        Fake f = new Fake(); f.saveAllowed = false;
        AtomicBoolean tethering = new AtomicBoolean();
        PolicyApplication.Result r = PolicyApplication.apply(() -> tethering.set(true),
                () -> AppRestrictions.reconcile(Set.of("com.example.app"), Set.of(), f, f));
        assertTrue(tethering.get());
        assertTrue(f.calls.isEmpty());
        assertFalse(r.complete());
    }

    @Test public void interruptedHideCanBeRestoredAfterRestart() {
        Fake f = new Fake();
        f.persisted.add("com.example.interrupted");
        f.hidden.add("com.example.interrupted");
        assertTrue(AppRestrictions.reconcile(Set.of(), f.persisted, f, f).complete());
        assertTrue(f.hidden.isEmpty());
        assertTrue(f.persisted.isEmpty());
    }

    @Test public void preinstalledUserAppIsAllowedButCoreAppsAndActiveAdminsStayProtected() {
        assertNull(AppRestrictions.classify(false, false, false, false, true, true, false));
        assertNotNull(AppRestrictions.classify(true, false, false, false, false, true, false));
        assertNotNull(AppRestrictions.classify(false, true, false, false, true, true, false));
        assertNotNull(AppRestrictions.classify(false, false, true, false, true, true, false));
        assertNotNull(AppRestrictions.classify(false, false, false, true, true, true, false));
        assertNotNull(AppRestrictions.classify(false, false, false, false, true, false, false));
        // Hidden preinstalled apps remain addressable through the agent's recovery journal.
        assertNull(AppRestrictions.classify(false, false, false, false, true, false, true));
        // Ordinary apps are not blanket-blocked because they lack a launcher activity.
        assertNull(AppRestrictions.classify(false, false, false, false, false, false, false));
    }

    @Test public void missingAppDoesNotPreventOtherAppsAndCanBeRetriedLater() {
        Fake f = new Fake(); f.protectedApps.put("com.example.missing", "not visible");
        AppRestrictions.Result r = AppRestrictions.reconcile(Set.of("com.example.missing", "com.example.ok"), Set.of(), f, f);
        assertFalse(r.complete());
        assertTrue(f.hidden.contains("com.example.ok"));
        f.protectedApps.clear();
        r = AppRestrictions.reconcile(Set.of("com.example.missing", "com.example.ok"), f.persisted, f, f);
        assertTrue(r.complete());
        assertEquals(Set.of("com.example.missing", "com.example.ok"), f.hidden);
    }
}
