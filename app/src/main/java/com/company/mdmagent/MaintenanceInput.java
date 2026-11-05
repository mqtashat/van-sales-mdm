package com.company.mdmagent;

import android.text.InputFilter;
import android.text.InputType;
import android.text.method.DigitsKeyListener;
import android.text.method.PasswordTransformationMethod;
import android.widget.EditText;

/** Maintenance PIN keypad; no legacy password UI. */
final class MaintenanceInput {
    private MaintenanceInput() {}
    static boolean valid(char[] pin) {
        if (pin == null || pin.length < 4 || pin.length > 6) return false;
        for (char c : pin) if ((c < '0' || c > '9') && c != '*' && c != '#') return false;
        return true;
    }

    static void configure(EditText field) {
        field.setText("");
        DigitsKeyListener allowed = DigitsKeyListener.getInstance("0123456789*#");
        field.setKeyListener(allowed);
        field.setRawInputType(InputType.TYPE_CLASS_PHONE);
        field.setFilters(new InputFilter[]{allowed, new InputFilter.LengthFilter(6)});
        field.setSingleLine(true);
        // setSingleLine replaces the transformation; apply masking last.
        field.setTransformationMethod(PasswordTransformationMethod.getInstance());
        field.setTextDirection(android.view.View.TEXT_DIRECTION_LTR);
    }
}
