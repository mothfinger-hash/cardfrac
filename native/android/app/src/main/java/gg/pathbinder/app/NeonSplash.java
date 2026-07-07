package gg.pathbinder.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

/**
 * Full-screen neon reveal played once per cold launch, layered over the webview.
 *
 * Streams from pathbinder.gg (this is a remote-URL wrap, so the app needs the
 * network regardless) and plays WITH sound. A TextureView + MediaPlayer gives a
 * proper center-crop fill; failsafes remove the overlay even if the stream
 * stalls, so launch is never blocked.
 */
final class NeonSplash {
    private static final String VIDEO_URL = "https://pathbinder.gg/pathbinder-neon-splash.mp4";
    private static boolean didRun = false;

    static void present(final Activity activity) {
        if (didRun) return;
        didRun = true;

        final FrameLayout overlay = new FrameLayout(activity);
        overlay.setBackgroundColor(Color.parseColor("#0A0E1A"));
        overlay.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        final TextureView texture = new TextureView(activity);
        texture.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        overlay.addView(texture);

        final ViewGroup root = activity.findViewById(android.R.id.content);
        root.addView(overlay);

        final MediaPlayer mp = new MediaPlayer();
        final Handler main = new Handler(Looper.getMainLooper());
        final boolean[] dismissed = { false };

        final Runnable dismiss = new Runnable() {
            @Override public void run() {
                if (dismissed[0]) return;
                dismissed[0] = true;
                try { mp.release(); } catch (Exception ignored) {}
                overlay.animate().alpha(0f).setDuration(400).withEndAction(new Runnable() {
                    @Override public void run() {
                        try { root.removeView(overlay); } catch (Exception ignored) {}
                    }
                }).start();
            }
        };

        texture.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture st, int width, int height) {
                try {
                    mp.setDataSource(activity, Uri.parse(VIDEO_URL));
                    mp.setSurface(new Surface(st));
                    mp.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                        @Override public void onPrepared(MediaPlayer p) {
                            applyCenterCrop(texture, p.getVideoWidth(), p.getVideoHeight());
                            p.start();
                        }
                    });
                    mp.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                        @Override public void onCompletion(MediaPlayer p) { main.post(dismiss); }
                    });
                    mp.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                        @Override public boolean onError(MediaPlayer p, int a, int b) { main.post(dismiss); return true; }
                    });
                    mp.prepareAsync();
                } catch (Exception e) {
                    main.post(dismiss);
                }
            }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture st, int width, int height) {
                try { applyCenterCrop(texture, mp.getVideoWidth(), mp.getVideoHeight()); } catch (Exception ignored) {}
            }
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture st) { return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture st) {}
        });

        // Tap to skip.
        overlay.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { main.post(dismiss); }
        });
        // Failsafe: if nothing started within 4s, skip to the app.
        main.postDelayed(new Runnable() {
            @Override public void run() {
                try { if (mp.getCurrentPosition() < 100) main.post(dismiss); } catch (Exception e) { main.post(dismiss); }
            }
        }, 4000);
        // Absolute cap.
        main.postDelayed(dismiss, 9000);
    }

    /** Scale the TextureView's matrix so the video center-crops to fill (no bars). */
    private static void applyCenterCrop(TextureView tv, int videoW, int videoH) {
        int w = tv.getWidth(), h = tv.getHeight();
        if (videoW == 0 || videoH == 0 || w == 0 || h == 0) return;
        float viewAspect = (float) w / h;
        float videoAspect = (float) videoW / videoH;
        float sx = 1f, sy = 1f;
        if (videoAspect > viewAspect) {
            sx = videoAspect / viewAspect;   // video relatively wider -> widen + crop sides
        } else {
            sy = viewAspect / videoAspect;   // video relatively taller -> heighten + crop top/bottom
        }
        Matrix m = new Matrix();
        m.setScale(sx, sy, w / 2f, h / 2f);
        tv.setTransform(m);
    }
}
