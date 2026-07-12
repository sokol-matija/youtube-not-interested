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

    function register() {
        const v = video();
        if (!v) return;
        try { v.autoPictureInPicture = true; } catch { /* older Chrome */ }
        try {
            navigator.mediaSession.setActionHandler('enterpictureinpicture', () => {
                const vv = video();
                if (vv && !document.pictureInPictureElement) {
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
