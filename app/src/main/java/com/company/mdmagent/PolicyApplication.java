package com.company.mdmagent;

/** Independent enforcement of valid policy components; validation happens before this boundary. */
final class PolicyApplication {
    interface Tethering { void applyAndVerify() throws Exception; }
    interface Apps { AppRestrictions.Result apply() throws Exception; }
    static final class Result {
        String tetheringError = "";
        String appsError = "";
        boolean complete() { return tetheringError.isEmpty() && appsError.isEmpty(); }
        String error() {
            return (tetheringError.isEmpty() ? "" : "مشاركة الإنترنت: " + tetheringError)
                    + (tetheringError.isEmpty() || appsError.isEmpty() ? "" : "; ")
                    + (appsError.isEmpty() ? "" : "التطبيقات: " + appsError);
        }
    }
    static Result apply(Tethering tethering, Apps apps) {
        Result result = new Result();
        try { tethering.applyAndVerify(); }
        catch (Exception ex) { result.tetheringError = ex.getClass().getSimpleName() + ": " + ex.getMessage(); }
        try { result.appsError = apps.apply().summary(); }
        catch (Exception ex) { result.appsError = ex.getClass().getSimpleName() + ": " + ex.getMessage(); }
        return result;
    }
}
