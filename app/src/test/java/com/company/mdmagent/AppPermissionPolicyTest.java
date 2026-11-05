package com.company.mdmagent;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class AppPermissionPolicyTest {
    private AppPermissionPolicy policy(Map<String,String> permissions) {
        Map<String,Object> raw = new HashMap<>();
        raw.put("schema_version",1L); raw.put("revision",1L); raw.put("permissions",permissions);
        return AppPermissionPolicy.parse(raw);
    }
    @Test public void rejectsSpecialAccessAndUnknownStatesBeforeMutation() {
        assertThrows(IllegalArgumentException.class, () -> policy(Collections.singletonMap("android.permission.SYSTEM_ALERT_WINDOW","granted")));
        assertThrows(IllegalArgumentException.class, () -> policy(Collections.singletonMap("android.permission.CAMERA","yes")));
    }
    @Test public void rejectedOrUnverifiedGrantsAreNotReportedApplied() {
        AppPermissionPolicy.Backend backend = new AppPermissionPolicy.Backend() {
            public boolean requestedRuntimePermission(String p) { return true; }
            public boolean set(String p,String state) { return true; }
            public String actual(String p) { return "denied"; }
        };
        Map<String,String> result=AppPermissionPolicy.apply(policy(Collections.singletonMap("android.permission.CAMERA","granted")),backend).get("android.permission.CAMERA");
        assertEquals("manual_required",result.get("status"));
        assertEquals("denied",result.get("actual"));
    }
    @Test public void undeclaredPermissionNeverInvokesSetterAndFailureIsIsolated() {
        Map<String,String> requests=new HashMap<>();
        requests.put("android.permission.CAMERA","granted");
        requests.put("android.permission.READ_CONTACTS","denied");
        List<String> calls=new ArrayList<>();
        Map<String,Map<String,String>> result=AppPermissionPolicy.apply(policy(requests),new AppPermissionPolicy.Backend() {
            public boolean requestedRuntimePermission(String p) { return !p.endsWith("CAMERA"); }
            public boolean set(String p,String state) { calls.add(p); return true; }
            public String actual(String p) { return "denied"; }
        });
        assertEquals(Collections.singletonList("android.permission.READ_CONTACTS"),calls);
        assertEquals("manual_required",result.get("android.permission.CAMERA").get("status"));
        assertEquals("applied",result.get("android.permission.READ_CONTACTS").get("status"));
    }
    @Test public void foregroundLocationPrecedesBackgroundAndExceptionsRemainFailures() {
        Map<String,String> requests=new HashMap<>();
        requests.put("android.permission.ACCESS_FINE_LOCATION","granted");
        requests.put("android.permission.ACCESS_BACKGROUND_LOCATION","granted");
        List<String> calls=new ArrayList<>();
        Map<String,Map<String,String>> result=AppPermissionPolicy.apply(policy(requests),new AppPermissionPolicy.Backend() {
            public boolean requestedRuntimePermission(String p) { return true; }
            public boolean set(String p,String state) { calls.add(p); if(p.contains("BACKGROUND")) throw new SecurityException("blocked"); return true; }
            public String actual(String p) { return "granted"; }
        });
        assertEquals("android.permission.ACCESS_FINE_LOCATION",calls.get(0));
        assertEquals("failed",result.get("android.permission.ACCESS_BACKGROUND_LOCATION").get("status"));
    }
}
