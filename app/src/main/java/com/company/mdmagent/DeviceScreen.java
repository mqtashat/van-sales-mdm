package com.company.mdmagent;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.*;

/** Shared presentation only; contains no policy or authentication behavior. */
final class DeviceScreen {
    final LinearLayout root, header, content, footer;
    final ScrollView scroll;
    final Activity activity;
    static final int NAVY = Color.rgb(10,24,44);
    static final int BLUE = Color.rgb(56,189,248);
    DeviceScreen(Activity activity) {
        this.activity=activity;
        root=column();root.setBackgroundColor(NAVY);
        header=column();header.setPadding(dp(20),dp(20),dp(20),dp(12));
        root.addView(header,new LinearLayout.LayoutParams(-1,-2));
        scroll=new ScrollView(activity);scroll.setFillViewport(true);
        content=column();content.setPadding(dp(16),0,dp(16),dp(12));scroll.addView(content);
        root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1f));
        footer=column();footer.setPadding(dp(16),dp(10),dp(16),dp(12));
        root.addView(footer,new LinearLayout.LayoutParams(-1,-2));
        root.setOnApplyWindowInsetsListener((v,insets)->{
            if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars());v.setPadding(bars.left,bars.top,bars.right,bars.bottom);}
            return insets;
        });
    }
    int dp(int n){return Math.round(n*activity.getResources().getDisplayMetrics().density);}
    LinearLayout column(){LinearLayout l=new LinearLayout(activity);l.setOrientation(LinearLayout.VERTICAL);l.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);return l;}
    TextView text(String value,int size,int color){TextView t=new TextView(activity);t.setText(value);t.setTextSize(size);t.setTextColor(color);t.setPadding(0,dp(6),0,dp(6));return t;}
    TextView title(String value,int size,int color){TextView t=text(value,size,color);t.setGravity(Gravity.CENTER);t.setMaxLines(2);t.setEllipsize(android.text.TextUtils.TruncateAt.END);t.setTypeface(null,Typeface.BOLD);header.addView(t,new LinearLayout.LayoutParams(-1,-2));return t;}
    LinearLayout card(String title){LinearLayout c=column();c.setPadding(dp(16),dp(10),dp(16),dp(12));GradientDrawable bg=new GradientDrawable();bg.setColor(Color.rgb(23,41,63));bg.setCornerRadius(dp(18));c.setBackground(bg);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.bottomMargin=dp(12);content.addView(c,p);TextView t=text(title,17,BLUE);t.setTypeface(null,Typeface.BOLD);c.addView(t);return c;}
    Button button(String label){Button b=new Button(activity);b.setText(label);b.setAllCaps(false);b.setTextSize(14);b.setTextColor(NAVY);b.setMinWidth(0);b.setMinimumWidth(0);b.setMinHeight(dp(52));b.setPadding(dp(8),dp(8),dp(8),dp(8));GradientDrawable bg=new GradientDrawable();bg.setColor(Color.rgb(239,246,255));bg.setCornerRadius(dp(24));b.setBackground(bg);return b;}
    void show(){activity.setContentView(root);root.requestApplyInsets();}
}
