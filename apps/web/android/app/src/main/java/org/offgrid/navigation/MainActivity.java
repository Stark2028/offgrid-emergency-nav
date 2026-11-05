package org.offgrid.navigation;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(OfflineStoragePlugin.class);
        super.onCreate(savedInstanceState);
        android.webkit.WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        android.view.View content = findViewById(android.R.id.content);
        content.setBackgroundColor(android.graphics.Color.rgb(245,244,237));
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(content, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars() |
                androidx.core.view.WindowInsetsCompat.Type.displayCutout());
            int keyboard = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime()).bottom;
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom,keyboard));
            return insets;
        });
        androidx.core.view.WindowInsetsControllerCompat controller =
            androidx.core.view.WindowCompat.getInsetsController(getWindow(),content);
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);
        if (getBridge()!=null) getBridge().getWebView().getSettings().setTextZoom(
            Math.round(getResources().getConfiguration().fontScale*100));
    }
}
