(function() {
    'use strict';

    console.log('[Quick Block] Extension loaded!');

    const PROCESSED_ATTR = 'data-quick-block-added';

    function addBlockButton(videoElement) {
        try {
            if (videoElement.hasAttribute(PROCESSED_ATTR)) {
                console.log('[Quick Block] Video already processed, skipping');
                return;
            }
            videoElement.setAttribute(PROCESSED_ATTR, 'true');

            const thumbnail = videoElement.querySelector('yt-thumbnail-view-model');
            if (!thumbnail) {
                console.log('[Quick Block] No thumbnail found for video:', videoElement);
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

        // DIAGNOSTIC: Add JS-based hover as fallback test
        videoElement.addEventListener('mouseenter', () => {
            const allVideos = Array.from(document.querySelectorAll('ytd-rich-item-renderer'));
            const videoIndex = allVideos.indexOf(videoElement);
            console.log(`[Quick Block] JS mouseenter fired on video index ${videoIndex}`, {
                buttonExists: !!btn,
                buttonParent: btn.parentElement?.tagName,
                currentOpacity: btn.style.opacity || window.getComputedStyle(btn).opacity,
                currentVisibility: btn.style.visibility || window.getComputedStyle(btn).visibility,
                buttonRect: btn.getBoundingClientRect()
            });
            btn.style.setProperty('opacity', '1', 'important');
            btn.style.setProperty('visibility', 'visible', 'important');
        });

        videoElement.addEventListener('mouseleave', () => {
            console.log('[Quick Block] JS mouseleave fired');
            btn.style.setProperty('opacity', '0', 'important');
            btn.style.setProperty('visibility', 'hidden', 'important');
        });

        thumbnail.appendChild(btn);

        // DIAGNOSTIC: Check position and parent structure
        const rect = videoElement.getBoundingClientRect();
        const isFirstRow = rect.top < 500; // Rough check for first row

        // Check if button is actually a descendant of ytd-rich-item-renderer
        const isDescendant = videoElement.contains(btn);

        // Get the path from button to videoElement
        let pathElements = [];
        let current = btn.parentElement;
        while (current && current !== videoElement) {
            pathElements.push(current.tagName.toLowerCase());
            current = current.parentElement;
        }

        console.log('[Quick Block] Button added to video', {
            isFirstRow,
            top: rect.top,
            hasParent: !!videoElement.parentElement,
            buttonInDOM: document.contains(btn),
            isDescendantOfRenderer: isDescendant,
            domPath: pathElements.join(' > '),
            thumbnailPosition: window.getComputedStyle(thumbnail).position,
            buttonStyles: {
                opacity: window.getComputedStyle(btn).opacity,
                visibility: window.getComputedStyle(btn).visibility,
                zIndex: window.getComputedStyle(btn).zIndex
            }
        });
        } catch (error) {
            console.error('[Quick Block] Error adding button:', error, videoElement);
        }
    }

    async function markNotInterested(videoElement) {
        const menuBtn = videoElement.querySelector('button[aria-label="More actions"]');
        if (!menuBtn) {
            console.log('[Quick Block] Menu button not found');
            return;
        }

        document.body.classList.add('quick-block-suppress-menu');
        menuBtn.click();

        await new Promise(resolve => setTimeout(resolve, 300));

        const titles = document.querySelectorAll('.ytListItemViewModelTitle, .yt-list-item-view-model__title');
        for (const title of titles) {
            if (title.textContent.trim() === 'Not interested') {
                const item = title.closest('yt-list-item-view-model, [role="menuitem"]') || title;
                item.click();
                console.log('[Quick Block] Clicked Not interested');
                setTimeout(() => document.body.classList.remove('quick-block-suppress-menu'), 100);
                return;
            }
        }

        // Close menu if "Not interested" not found
        document.body.click();
        document.body.classList.remove('quick-block-suppress-menu');
        console.log('[Quick Block] Not interested option not found');
    }

    function processVideos() {
        const cards = document.querySelectorAll('ytd-rich-item-renderer:not([' + PROCESSED_ATTR + '])');
        if (cards.length > 0) {
            console.log('[Quick Block] Processing', cards.length, 'new videos');
            cards.forEach((card, index) => {
                console.log(`[Quick Block] Processing video ${index}`, {
                    tagName: card.tagName,
                    className: card.className,
                    hasThumbnail: !!card.querySelector('yt-thumbnail-view-model'),
                    rect: card.getBoundingClientRect()
                });
                addBlockButton(card);
            });
        }
    }

    function init() {
        console.log('[Quick Block] Initializing...');

        // DIAGNOSTIC: Check ALL video-related elements
        const richItems = document.querySelectorAll('ytd-rich-item-renderer');
        const videoRenderers = document.querySelectorAll('ytd-video-renderer');
        const compactRenderers = document.querySelectorAll('ytd-compact-video-renderer');

        console.log(`[Quick Block] Found video elements:`, {
            richItems: richItems.length,
            videoRenderers: videoRenderers.length,
            compactRenderers: compactRenderers.length
        });

        richItems.forEach((video, idx) => {
            if (idx < 5) { // Log first 5 videos
                console.log(`[Quick Block] ytd-rich-item-renderer ${idx}:`, {
                    alreadyProcessed: video.hasAttribute(PROCESSED_ATTR),
                    hasButton: !!video.querySelector('.quick-block-btn'),
                    classes: video.className,
                    isHidden: video.style.display === 'none' || video.hidden,
                    offsetTop: video.offsetTop
                });
            }
        });

        // FIX: Process videos multiple times with delays to catch early-loaded videos
        // This handles the race condition where first videos load before extension is ready
        processVideos(); // Immediate
        setTimeout(() => {
            console.log('[Quick Block] Retry 1: Processing after 100ms...');
            processVideos();
        }, 100);
        setTimeout(() => {
            console.log('[Quick Block] Retry 2: Processing after 500ms...');
            processVideos();
        }, 500);
        setTimeout(() => {
            console.log('[Quick Block] Retry 3: Processing after 1000ms...');
            processVideos();
        }, 1000);

        // Watch for new videos (infinite scroll)
        const observer = new MutationObserver(() => {
            processVideos();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // DIAGNOSTIC: Add hover detection on first row
        document.addEventListener('mouseover', (e) => {
            const video = e.target.closest('ytd-rich-item-renderer');
            if (video) {
                const btn = video.querySelector('.quick-block-btn');
                const rect = video.getBoundingClientRect();
                if (rect.top < 500 && btn) {
                    console.log('[Quick Block] Hover on first-row video', {
                        hasButton: !!btn,
                        buttonStyles: {
                            opacity: window.getComputedStyle(btn).opacity,
                            visibility: window.getComputedStyle(btn).visibility,
                            display: window.getComputedStyle(btn).display
                        },
                        videoHasHoverClass: video.matches(':hover')
                    });
                }
            }
        }, { passive: true });

        console.log('[Quick Block] Observer started');
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
