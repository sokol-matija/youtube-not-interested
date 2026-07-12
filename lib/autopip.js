// Auto picture-in-picture (Chrome 134+). Runs in MAIN world.
// Registers the mediaSession "enterpictureinpicture" action so Chrome
// auto-enters PiP when the tab goes hidden while playing (tab switch,
// minimize, window fully covered by another app). Chrome auto-closes
// that PiP window when the tab becomes visible again.
// Requires the user to allow "Automatic picture-in-picture" for
// youtube.com — Chrome prompts on first trigger.
(() => {
    const video = () =>
        document.querySelector('video.html5-main-video') ||
        document.querySelector('video');

    // Options toggle, bridged from the isolated-world content script.
    const enabled = () => document.documentElement.dataset.qbAutoPipOff !== '1';

    function register() {
        const v = video();
        if (!v) return;
        try { v.autoPictureInPicture = enabled(); } catch { /* older Chrome */ }
        try {
            navigator.mediaSession.setActionHandler('enterpictureinpicture', () => {
                const vv = video();
                if (enabled() && vv && !document.pictureInPictureElement) {
                    vv.requestPictureInPicture().catch(() => {});
                }
            });
        } catch { /* action not supported on this Chrome */ }
    }

    register();
    // YouTube is a SPA and re-registers its own media session handlers on
    // navigation / player init — re-assert ours so it stays the active one.
    document.addEventListener('yt-navigate-finish', register);
    document.addEventListener('play', register, true);
    // After returning from PiP the video keeps playing (no new 'play' event),
    // and YouTube may have re-taken the handler — re-assert so the NEXT
    // tab-hide triggers us again, not a stale/foreign handler.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') register();
    });
    // Re-apply live when the options toggle flips.
    new MutationObserver(register).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-qb-auto-pip-off'],
    });

    // PiP entered via the global shortcut is marked with data-qb-pip;
    // close it when the user comes back to this tab (exit needs no gesture).
    window.addEventListener('focus', () => {
        const el = document.pictureInPictureElement;
        if (el?.dataset?.qbPip) {
            delete el.dataset.qbPip;
            document.exitPictureInPicture().catch(() => {});
        }
    });
})();
