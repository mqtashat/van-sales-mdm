package com.company.mdmagent;

import org.junit.Test;
import java.util.HashMap;
import java.util.Map;
import static org.junit.Assert.*;

public class AppInstallPolicyTest {

    private Map<String, Object> validDoc(long rev, boolean block) {
        Map<String, Object> map = new HashMap<>();
        map.put("schema_version", 1L);
        map.put("revision", rev);
        map.put("block_app_installs", block);
        return map;
    }

    @Test
    public void testValidPolicyParsing() {
        AppInstallPolicy policy = AppInstallPolicy.parse(validDoc(2L, true), 1L);
        assertEquals(2L, policy.revision);
        assertTrue(policy.blockAppInstalls);

        AppInstallPolicy unblocked = AppInstallPolicy.parse(validDoc(5L, false), 2L);
        assertEquals(5L, unblocked.revision);
        assertFalse(unblocked.blockAppInstalls);
    }

    @Test
    public void testRejectsNullOrMissingFields() {
        assertThrows(IllegalArgumentException.class, () -> AppInstallPolicy.parse(null, 0L));

        final Map<String, Object> doc1 = validDoc(2L, true);
        doc1.remove("schema_version");
        assertThrows(IllegalArgumentException.class, () -> AppInstallPolicy.parse(doc1, 0L));

        final Map<String, Object> doc2 = validDoc(2L, true);
        doc2.remove("revision");
        assertThrows(IllegalArgumentException.class, () -> AppInstallPolicy.parse(doc2, 0L));

        final Map<String, Object> doc3 = validDoc(2L, true);
        doc3.remove("block_app_installs");
        assertThrows(IllegalArgumentException.class, () -> AppInstallPolicy.parse(doc3, 0L));
    }

    @Test
    public void testRejectsStaleRevision() {
        assertThrows(IllegalArgumentException.class, () -> AppInstallPolicy.parse(validDoc(1L, true), 2L));
    }

    @Test
    public void testRejectsInvalidTypes() {
        final Map<String, Object> doc4 = validDoc(2L, true);
        doc4.put("schema_version", 2L);
        assertThrows(IllegalArgumentException.class, () -> AppInstallPolicy.parse(doc4, 0L));

        final Map<String, Object> doc5 = validDoc(2L, true);
        doc5.put("block_app_installs", "true");
        assertThrows(IllegalArgumentException.class, () -> AppInstallPolicy.parse(doc5, 0L));
    }
}
