package com.company.mdmagent;

import org.junit.Test;
import java.util.HashMap;
import java.util.Map;
import java.util.List;
import static org.junit.Assert.*;

public class PolicyTest {
    private Map<String, Object> policy(long revision, boolean block) {
        Map<String, Object> p = new HashMap<>();
        p.put("schema_version", 1L); p.put("revision", revision); p.put("block_tethering", block);
        p.put("blocked_apps", List.of());
        return p;
    }
    @Test public void canBlockAndExplicitlyUnblockWithNewRevision() {
        assertTrue(Policy.parse(policy(1, true), 0).blockTethering);
        assertFalse(Policy.parse(policy(2, false), 1).blockTethering);
    }
    @Test public void missingAndMistypedValuesNeverSilentlyUnlock() {
        Map<String, Object> p = policy(1, true);
        p.remove("block_tethering");
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
        p.put("block_tethering", "false");
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(null, 0));
    }
    @Test public void rejectsStalePolicyButAllowsIdempotentReplay() {
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(policy(1, false), 2));
        assertTrue(Policy.parse(policy(2, true), 2).blockTethering);
    }
    @Test public void rejectsInvalidSchemaAndNonIntegerRevision() {
        Map<String, Object> p = policy(1, true);
        p.put("schema_version", 2L);
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
        p.put("schema_version", 1L); p.put("revision", 1.5);
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
    }
    @Test public void appListMustBeExplicitAndWellFormed() {
        Map<String, Object> p = policy(1, true);
        p.remove("blocked_apps");
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
        p.put("blocked_apps", List.of("com.example.game"));
        assertTrue(Policy.parse(p, 0).blockedApps.contains("com.example.game"));
        p.put("blocked_apps", List.of("not a package"));
        assertThrows(IllegalArgumentException.class, () -> Policy.parse(p, 0));
    }
}
