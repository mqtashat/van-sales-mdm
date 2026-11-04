package com.company.mdmagent;

import android.text.InputFilter;
import android.text.InputType;
import android.text.method.DigitsKeyListener;
import android.text.method.PasswordTransformationMethod;
import android.widget.EditText;

/** Keypad entry by default, with explicit access to existing legacy credentials. */
final class MaintenanceInput {
    private MaintenanceInput() {}

    static void configure(EditText field, boolean legacy) {
        field.setText("");
        if (legacy) {
            field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            field.setFilters(new InputFilter[]{new InputFilter.LengthFilter(128)});
        } else {
            field.setKeyListener(DigitsKeyListener.getInstance("0123456789*#"));
            field.setRawInputType(InputType.TYPE_CLASS_PHONE);
            field.setFilters(new InputFilter[]{new InputFilter.LengthFilter(6)});
        }
        field.setTransformationMethod(PasswordTransformationMethod.getInstance());
        field.setSingleLine(true);
        field.setTextDirection(android.view.View.TEXT_DIRECTION_LTR);
    }
}
