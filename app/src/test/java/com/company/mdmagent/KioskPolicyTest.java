package com.company.mdmagent;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
public class KioskPolicyTest {
 Map<String,Object> doc(){Map<String,Object> p=new HashMap<>();p.put("schema_version",1L);p.put("revision",2L);p.put("enabled",true);p.put("allowed_apps",List.of("com.whatsapp"));p.put("exit_salt","a".repeat(32));p.put("exit_hash","b".repeat(64));return p;}
 @Test public void rejectsIncompleteStaleAndCoercedPolicies(){
  assertThrows(IllegalArgumentException.class,()->KioskPolicy.parse(null,0));
  assertThrows(IllegalArgumentException.class,()->KioskPolicy.parse(doc(),3));
  for(String field:List.of("enabled","allowed_apps","exit_salt","exit_hash","revision")){
   Map<String,Object> p=doc();p.remove(field);assertThrows(IllegalArgumentException.class,()->KioskPolicy.parse(p,0));
  }
  Map<String,Object> p=doc();p.put("enabled","false");assertThrows(IllegalArgumentException.class,()->KioskPolicy.parse(p,0));
 }
 @Test public void disabledRequiresExplicitValidatedRevision(){Map<String,Object> p=doc();p.put("enabled",false);p.put("allowed_apps",List.of());assertFalse(KioskPolicy.parse(p,2).enabled);}
 @Test public void emptyEnabledAndOversizedListsAreRejected(){Map<String,Object> p=doc();p.put("allowed_apps",List.of());assertThrows(IllegalArgumentException.class,()->KioskPolicy.parse(p,0));p.put("allowed_apps",Collections.nCopies(51,"com.whatsapp"));assertThrows(IllegalArgumentException.class,()->KioskPolicy.parse(p,0));}
 @Test public void offlineMaintenanceCannotBeOverriddenBySameRevision(){assertFalse(KioskPolicy.shouldApply(2,2));assertFalse(KioskPolicy.shouldApply(1,2));assertTrue(KioskPolicy.shouldApply(3,2));}
}
