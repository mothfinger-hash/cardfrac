package gg.pathbinder.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;

/**
 * Cold-launch intro (once per process):
 *   promise manifesto (held until the neon video is buffered) -> neon video -> app.
 *
 * The promise image is shown ON TOP of the (already buffering) video, so there
 * is no dead navy gap: the instant the video is ready we start it and fade the
 * promise away to reveal it. A MIN keeps the promise readable; a MAX + failsafes
 * guarantee a slow/dead network can never wedge the launch. Streams from
 * pathbinder.gg (remote-URL wrap) and plays WITH sound.
 *
 * The promise shows on EVERY cold launch — it replaces the old static splash as
 * the brand moment. (Android's OS SplashScreen API only supports a background
 * colour + centred icon, not a full image, so a brief monogram still precedes
 * this; on iOS the launch storyboard IS this image.)
 */
final class NeonSplash {
    private static final String VIDEO_URL = "https://pathbinder.gg/pathbinder-neon-splash.mp4";
    private static boolean didRun = false;

    private static final long PROMISE_MIN_MS  = 1800;   // keep it readable
    private static final long PROMISE_MAX_MS  = 6000;   // drop it even if video still buffering
    private static final long VIDEO_GIVEUP_MS = 9000;   // if video never started, skip to app
    private static final long HARD_CAP_MS     = 15000;  // absolute backstop

    static void present(final Activity activity) {
        if (didRun) return;
        didRun = true;

        final ViewGroup root = activity.findViewById(android.R.id.content);
        final Handler main = new Handler(Looper.getMainLooper());

        // ---- Video layer (behind) ----
        final FrameLayout overlay = new FrameLayout(activity);
        overlay.setBackgroundColor(Color.BLACK);
        overlay.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        final TextureView texture = new TextureView(activity);
        texture.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        overlay.addView(texture);
        root.addView(overlay);

        // ---- Promise layer (on top of the video) ----
        ImageView promiseTmp = null;
        try {
            promiseTmp = new ImageView(activity);
            promiseTmp.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            promiseTmp.setBackgroundColor(Color.BLACK);
            promiseTmp.setScaleType(ImageView.ScaleType.FIT_CENTER);
            promiseTmp.setImageResource(R.drawable.promise_splash);
            root.addView(promiseTmp);
        } catch (Throwable t) {
            promiseTmp = null;
        }
        final ImageView promise = promiseTmp;
        final boolean hasPromise = promise != null;
        final long startedAt = SystemClock.uptimeMillis();

        final MediaPlayer mp = new MediaPlayer();
        final boolean[] videoReady   = { false };
        final boolean[] videoStarted = { false };
        final boolean[] promiseGone  = { !hasPromise };
        final boolean[] dismissed    = { false };

        final Runnable dismissVideo = () -> {
            if (dismissed[0]) return; dismissed[0] = true;
            try { mp.release(); } catch (Exception ignored) {}
            overlay.animate().alpha(0f).setDuration(400).withEndAction(() -> {
                try { root.removeView(overlay); } catch (Exception ignored) {}
            }).start();
        };

        final Runnable startVideo = () -> {
            if (videoStarted[0] || dismissed[0]) return; videoStarted[0] = true;
            try { mp.start(); } catch (Exception ignored) {}
            main.postDelayed(dismissVideo, 15000);   // post-start cap; onCompletion normally beats it
        };

        final Runnable removePromise = () -> {
            if (promiseGone[0]) return; promiseGone[0] = true;
            if (videoReady[0]) startVideo.run();      // reveal the video that's now playing
            if (promise != null) {
                promise.animate().alpha(0f).setDuration(350).withEndAction(() -> {
                    try { root.removeView(promise); } catch (Exception ignored) {}
                }).start();
            }
        };

        texture.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) {
                try {
                    mp.setDataSource(activity, Uri.parse(VIDEO_URL));
                    mp.setSurface(new Surface(st));
                    mp.setOnPreparedListener(p -> {
                        applyCenterCrop(texture, p.getVideoWidth(), p.getVideoHeight());
                        try { p.seekTo(0); } catch (Exception ignored) {}
                        videoReady[0] = true;
                        if (!hasPromise || promiseGone[0]) {
                            startVideo.run();          // no promise (or already gone) -> play now
                        } else {
                            long wait = Math.max(0, PROMISE_MIN_MS - (SystemClock.uptimeMillis() - startedAt));
                            main.postDelayed(removePromise, wait);
                        }
                    });
                    mp.setOnCompletionListener(p -> main.post(dismissVideo));
                    mp.setOnErrorListener((p, a, b) -> { main.post(dismissVideo); return true; });
                    mp.prepareAsync();
                } catch (Exception e) { main.post(dismissVideo); }
            }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) {
                try { applyCenterCrop(texture, mp.getVideoWidth(), mp.getVideoHeight()); } catch (Exception ignored) {}
            }
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture st) { return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture st) {}
        });

        // Tap to skip: promise -> reveal/advance to the video; video -> straight to app.
        if (hasPromise) promise.setOnClickListener(v -> main.post(removePromise));
        overlay.setOnClickListener(v -> main.post(dismissVideo));

        // Drop the promise even if the video is still buffering past MAX.
        if (hasPromise) main.postDelayed(removePromise, PROMISE_MAX_MS);
        // If the video never actually started, skip to the app.
        main.postDelayed(() -> { if (!videoStarted[0]) main.post(dismissVideo); }, VIDEO_GIVEUP_MS);
        // Absolute backstop so the overlay can never linger.
        main.postDelayed(dismissVideo, HARD_CAP_MS);
    }

    /** Scale the TextureView's matrix so the video center-crops to fill (no bars). */
    private static void applyCenterCrop(TextureView tv, int videoW, int videoH) {
        int w = tv.getWidth(), h = tv.getHeight();
        if (videoW == 0 || videoH == 0 || w == 0 || h == 0) return;
        float viewAspect = (float) w / h;
        float videoAspect = (float) videoW / videoH;
        float sx = 1f, sy = 1f;
        if (videoAspect > viewAspect) { sx = videoAspect / viewAspect; }
        else { sy = viewAspect / videoAspect; }
        Matrix m = new Matrix();
        m.setScale(sx, sy, w / 2f, h / 2f);
        tv.setTransform(m);
    }
}
