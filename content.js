(function() {
    'use strict';

    console.log('[Quick Block] Extension loaded!');

    const PROCESSED_ATTR = 'data-quick-block-added';

    function addBlockButton(videoElement) {
        if (videoElement.hasAttribute(PROCESSED_ATTR)) return;
        videoElement.setAttribute(PROCESSED_ATTR, 'true');

        const thumbnail = videoElement.querySelector('yt-thumbnail-view-model');
        if (!thumbnail) {
            console.log('[Quick Block] No thumbnail found');
            return;
        }

        const btn = document.createElement('button');
        btn.className = 'quick-block-btn';
        btn.textContent = '✕';
        btn.title = 'Not interested';

        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[Quick Block] Button clicked!');
            await markNotInterested(videoElement);
        });

        thumbnail.appendChild(btn);
        console.log('[Quick Block] Button added to video');
    }

    async function markNotInterested(videoElement) {
        const menuBtn = videoElement.querySelector('button[aria-label="More actions"]');
        if (!menuBtn) {
            console.log('[Quick Block] Menu button not found');
            return;
        }

        menuBtn.click();

        await new Promise(resolve => setTimeout(resolve, 300));

        const menuItems = document.querySelectorAll('yt-list-item-view-model');
        for (const item of menuItems) {
            const title = item.querySelector('.yt-list-item-view-model__title');
            if (title && title.textContent.trim() === 'Not interested') {
                item.click();
                console.log('[Quick Block] Clicked Not interested');
                return;
            }
        }

        // Close menu if "Not interested" not found
        document.body.click();
        console.log('[Quick Block] Not interested option not found');
    }

    function processVideos() {
        const cards = document.querySelectorAll('ytd-rich-item-renderer:not([' + PROCESSED_ATTR + '])');
        if (cards.length > 0) {
            console.log('[Quick Block] Processing', cards.length, 'new videos');
            cards.forEach(addBlockButton);
        }
    }

    function init() {
        console.log('[Quick Block] Initializing...');

        // Process existing videos
        processVideos();

        // Watch for new videos (infinite scroll)
        const observer = new MutationObserver(() => {
            processVideos();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        console.log('[Quick Block] Observer started');
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
