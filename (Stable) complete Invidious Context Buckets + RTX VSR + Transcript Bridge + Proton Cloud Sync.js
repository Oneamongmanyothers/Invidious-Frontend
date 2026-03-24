// ==UserScript==
// @name         (Stable) complete Invidious: Context Buckets + RTX VSR + Transcript Bridge + Proton Cloud Sync
// @namespace    http://tampermonkey.net/
// @version      63.0
// @description  Full Dashboard Migration: Race Condition Aborts, Hide-By-Default Injections, SVG Lazy Loaders.
// @author       Oneamongmanyothers
// @match        *://127.0.0.1:3000/*
// @icon         http://127.0.0.1:5001/icon.png
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // =========================================================
    // 0. ADVANCED LOGGING & TOAST SYSTEM
    // =========================================================
    const LOG_DATA =[];
    const ERROR_TRACKER = {};
    const ERROR_THRESHOLD = 5;

    function showToast(message, type = 'info') {
        let container = document.getElementById('bucket-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'bucket-toast-container';
            container.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 10005;
                display: flex;
                flex-direction: column;
                gap: 10px;
                pointer-events: none;
            `;
            document.body.appendChild(container);
        }

        let bgColor = '#2196F3';
        let icon = 'ion-md-information-circle';

        if (type === 'warn') { bgColor = '#ff9800'; icon = 'ion-md-warning'; }
        else if (type === 'error') { bgColor = '#8b0000'; icon = 'ion-md-alert'; }
        else if (type === 'success') { bgColor = '#4CAF50'; icon = 'ion-md-checkmark-circle'; }

        const toast = document.createElement('div');
        toast.style.cssText = `
            background: ${bgColor};
            color: #f1f1f1;
            padding: 12px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            border: 1px solid #444;
            font-weight: bold;
            font-size: 13px;
            font-family: "Roboto", sans-serif;
            display: flex;
            align-items: center;
            gap: 10px;
            pointer-events: auto;
            cursor: pointer;
            opacity: 0;
            transform: translateX(100%);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            max-width: 350px;
            line-height: 1.4;
        `;
        toast.innerHTML = `<i class="icon ${icon}" style="font-size: 18px;"></i> <span>${message}</span>`;

        toast.onclick = () => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%)';
            setTimeout(() => toast.remove(), 300);
        };

        container.appendChild(toast);

        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(0)';
        });

        setTimeout(() => {
            if (toast.parentNode) toast.onclick();
        }, 5000);
    }

    function bLog(level, context, msg, err = null) {
        const time = new Date().toLocaleTimeString();
        const errTrace = err ? `\n    └─ Error: ${err.message}\n${err.stack}` : '';
        const logLine = `[${time}][${level}][${context}] ${msg}${errTrace}`;

        console.log(logLine);
        LOG_DATA.push(logLine);

        if (level === "ERROR" || level === "WARN") {
            let sig = `${level}_${context}`;
            if (msg.includes("No videos returned")) sig = `${level}_API_Empty_Response`;

            if (!ERROR_TRACKER[sig]) {
                ERROR_TRACKER[sig] = { count: 0, alerted: false };
            }

            ERROR_TRACKER[sig].count++;

            if (ERROR_TRACKER[sig].count >= ERROR_THRESHOLD && !ERROR_TRACKER[sig].alerted) {
                showToast(`Frequent system event detected: Multiple [${level}]s in ${context}. Check Logs.`, level.toLowerCase());
                ERROR_TRACKER[sig].alerted = true;
            }
        }
    }

    function downloadLogs() {
        try {
            const blob = new Blob([LOG_DATA.join('\n')], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Bucket_Engine_Logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            bLog("INFO", "System", "Log file downloaded successfully.");
        } catch (e) {
            bLog("ERROR", "System", "Failed to generate log file.", e);
            alert("Failed to download logs. Check browser console.");
        }
    }

    bLog("INFO", "System", "Script Initialized - Version 63.0 (Race Condition Aborts, Hide-By-Default, SVG Placholders)");

    if (window.location.port !== '3000') {
        bLog("WARN", "System", "Wrong port detected. Script standing down.");
        return;
    }

    if (window.location.pathname === '/feed/subscriptions' && window.location.search.includes('page=')) {
        bLog("INFO", "System", "Stripping pagination from URL, forcing root feed.");
        window.location.replace('/feed/subscriptions');
        return;
    }

    // =========================================================
    // STATE & MEMORY VARIABLES (Librewolf Persistent Vault)
    // =========================================================
    const API_URL = 'http://127.0.0.1:5001';
    let CURRENT_FILTER = sessionStorage.getItem('bucket_active_tab') || 'ALL';
    let BUCKETS = {};

    let CURRENT_PAGE = 1;
    let IS_FETCHING = false;
    let TARGET_PAGES = 5;
    let LAST_ACTIVE_FILTER = null;
    let SCRAPE_COUNTER = 0;
    let MISSING_CHANNELS_NAMES =[];
    let NEXT_PAGE_URL_CACHE = null;
    let ACTIVE_FETCHES = new Set();
    let COMPLETED_FETCHES = new Set();

    let DAILY_MIX_CHANNELS =[];
    let DAILY_MIX_GENERATED = false;

    let IS_LOGGED_IN = false;
    let USER_NAME = "Guest";
    let NOTIF_COUNT = "0 unseen notifications";

    // Map critical cache to GM storage to survive Librewolf closures
    let CHANNEL_CACHE = JSON.parse(GM_getValue('bucket_channel_cache_gm', '{}'));

    if (GM_getValue('bucket_tracker_open_gm', 'true') !== 'false') {
        document.body.classList.add('tracker-open');
    }

    function updateCache(name, url) {
        try {
            if (!name || !url) return;
            let cleanName = name.trim();
            if (CHANNEL_CACHE[cleanName] !== url) {
                CHANNEL_CACHE[cleanName] = url;
                GM_setValue('bucket_channel_cache_gm', JSON.stringify(CHANNEL_CACHE));
            }
        } catch (e) {
            bLog("ERROR", "Cache", "Failed to update GM cache.", e);
        }
    }

    // =========================================================
    // BROADCAST TAB SYNC & PROGRESS MEMORY & AUTO-SPEED
    // =========================================================
    const syncChannel = new BroadcastChannel('invid_stealth_sync');

    function setupTabSync(mediaElem) {
        let isSyncPaused = false;
        mediaElem.addEventListener('play', () => {
            if (!isSyncPaused) syncChannel.postMessage({ type: 'PLAY', id: Date.now() });
            isSyncPaused = false;
        });

        syncChannel.onmessage = (e) => {
            if (e.data.type === 'PLAY' && !mediaElem.paused) {
                isSyncPaused = true;
                mediaElem.pause();
                showToast("Tab Sync: Paused to yield bandwidth", "warn");
            }
        };
    }

    function setupProgressMemory(mediaElem, videoId) {
        const savedTime = GM_getValue('bucket_prog_' + videoId, 0);

        const onLoaded = () => {
            if (savedTime > 2 && savedTime < mediaElem.duration - 10) {
                mediaElem.currentTime = savedTime;

                // Format seconds to MM:SS or HH:MM:SS
                let formattedTime = new Date(savedTime * 1000).toISOString().substr(11, 8);
                if (formattedTime.startsWith("00:")) formattedTime = formattedTime.substring(3);
                showToast(`Resumed at ${formattedTime}`, 'success');
            }
        };

        if (mediaElem.readyState >= 1) onLoaded();
        else mediaElem.addEventListener('loadedmetadata', onLoaded, {once: true});

        mediaElem.addEventListener('timeupdate', () => {
            if (Math.floor(mediaElem.currentTime) % 5 === 0) {
                GM_setValue('bucket_prog_' + videoId, mediaElem.currentTime);
            }
        });
    }

    function handleAutoSpeed(mediaElem) {
        if (isNaN(mediaElem.duration) || mediaElem.duration === 0) return;

        let target = 1.0;
        const text = (document.title + " " + (document.querySelector('.channel-name, #channel-name, .video-data')?.textContent || "")).toLowerCase();
        const isMusic =['music', 'song', 'lyrics', 'official', 'mv', 'vevo', 'topic', 'records', 'album', 'mix', 'remix', 'ost', 'soundtrack', 'audio', 'concert', 'live', 'instrumental', 'beat', 'discography'].some(k => text.includes(k));

        if (!isMusic) {
            if (mediaElem.duration > 1500) target = 2.0; // > 25 mins
            else if (mediaElem.duration > 600) target = 1.5; // > 10 mins
        }

        if (mediaElem.playbackRate !== target) {
            mediaElem.playbackRate = target;
            showToast(`Auto-Speed: ${target.toFixed(2)}x`, 'info');
        }
    }

    // =========================================================
    // UNIVERSAL LAZY LOADER (Intersection Observer)
    // =========================================================
    const LAZY_OBSERVER = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                let img = entry.target;
                if (img.dataset.src) {
                    img.src = img.dataset.src;
                    img.removeAttribute('data-src');
                    img.onload = () => { img.classList.add('loaded'); };
                    observer.unobserve(img);
                }
            }
        });
    }, { rootMargin: '300px', threshold: 0.1 });

    function observeLazyImages() {
        document.querySelectorAll('img.bucket-lazy-img[data-src]').forEach(img => {
            LAZY_OBSERVER.observe(img);
        });
    }

    // =========================================================
    // 0.5 DOM CLEANUP & DATA SCRAPER
    // =========================================================
    function extractUserData() {
        try {
            let allNativeLinks = Array.from(document.querySelectorAll('a')).filter(a => !a.closest('#bucket-debug-panel') && !a.closest('#custom-unified-header'));
            let allForms = Array.from(document.querySelectorAll('form'));

            let aLogout = allNativeLinks.find(a => a.href && (a.href.toLowerCase().includes('logout') || a.href.toLowerCase().includes('signout')));
            let formLogout = allForms.find(f => f.action && (f.action.toLowerCase().includes('logout') || f.action.toLowerCase().includes('signout')));

            if (aLogout || formLogout) {
                IS_LOGGED_IN = true;
                let authNode = aLogout || formLogout;
                let li = authNode.closest('li');

                if (li && li.previousElementSibling) {
                    USER_NAME = li.previousElementSibling.textContent.trim();
                } else if (authNode.parentElement) {
                    let text = authNode.parentElement.textContent.replace(/log out/ig, '').replace(/logout/ig, '').replace(/sign out/ig, '').replace(/signout/ig, '').trim();
                    let parts = text.split(/\s+/).filter(w => !['*','🔔','⚙','|','/'].includes(w));
                    if (parts.length > 0) USER_NAME = parts[parts.length - 1];
                }
                if (!USER_NAME || USER_NAME.toLowerCase() === "guest" || USER_NAME.toLowerCase() === "preferences" || USER_NAME === "⚙") {
                    USER_NAME = "User";
                }
            } else {
                let aLogin = allNativeLinks.find(a => a.href && a.href.toLowerCase().includes('login'));
                if (aLogin) {
                    IS_LOGGED_IN = false;
                    USER_NAME = "Guest";
                } else {
                    let htmlStr = document.documentElement.innerHTML.toLowerCase();
                    IS_LOGGED_IN = htmlStr.includes('logout') || htmlStr.includes('signout');
                    USER_NAME = IS_LOGGED_IN ? "User" : "Guest";
                }
            }

            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let node;
            while ((node = walker.nextNode())) {
                if (node.nodeValue.includes('unseen notifications')) {
                    NOTIF_COUNT = node.nodeValue.trim();
                    break;
                }
            }
        } catch (e) {
            bLog("ERROR", "Scraper", "Error extracting user data", e);
        }
    }

    function hideNativeHeaderJunk() {
        try {
            if (!window.location.pathname.includes('/feed/subscriptions')) return;

            const popLink = document.querySelector('a[href="/feed/popular"]:not(.sidebar-nav-link)');
            if (popLink) {
                let c = popLink.closest('.pure-menu') || popLink.closest('.h-box') || popLink.parentElement;
                if (c) c.style.display = 'none';
            }

            const histLink = document.querySelector('a[href="/feed/history"]:not(.sidebar-nav-link)');
            if (histLink) {
                let c = histLink.closest('.pure-g') || histLink.parentElement;
                if (c) c.style.display = 'none';
            }

            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let node;
            while ((node = walker.nextNode())) {
                if (node.nodeValue.includes('unseen notifications')) {
                    let parent = node.parentElement;
                    if (parent && !parent.closest('#bucket-debug-panel') && !parent.closest('#custom-unified-header')) {
                        parent.style.display = 'none';
                    }
                }
            }
        } catch (e) {
            bLog("ERROR", "Scraper", "Error hiding native header junk", e);
        }
    }

    // =========================================================
    // 1. CLOUD STORAGE LOGIC & DAILY MIX GENERATOR
    // =========================================================
    async function loadBuckets() {
        try {
            bLog("INFO", "CloudSync", "Fetching buckets from Python bridge...");
            const response = await fetch(`${API_URL}/get-buckets`);
            const data = await response.json();

            let seenChannels = new Set();

            Object.keys(data).forEach(key => {
                if (Array.isArray(data[key])) {
                    data[key] = { channels: data[key], order: 0, ignoreShortsTimer: false };
                }
                if (!data[key].channels) data[key].channels =[];
                if (typeof data[key].order !== 'number') data[key].order = 0;
                if (typeof data[key].ignoreShortsTimer !== 'boolean') data[key].ignoreShortsTimer = false;

                let uniqueChannels = [];
                data[key].channels.forEach(ch => {
                    let chLower = ch.toLowerCase().trim();
                    if (!seenChannels.has(chLower)) {
                        seenChannels.add(chLower);
                        uniqueChannels.push(ch.trim());
                    }
                });
                data[key].channels = uniqueChannels;
            });

            BUCKETS = data;
            bLog("INFO", "CloudSync", "Buckets loaded successfully.");

            if (window.location.pathname.includes('/feed/subscriptions')) {
                applyChangesLive();
            } else {
                updateStatsPanel([]);
            }
        } catch (e) {
            bLog("ERROR", "CloudSync", "Could not connect to Python Bridge", e);
        }
    }

    async function saveBuckets(data) {
        try {
            bLog("INFO", "CloudSync", "Saving buckets to Python bridge...");
            await fetch(`${API_URL}/save-buckets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            bLog("INFO", "CloudSync", "Buckets saved successfully.");
        } catch (e) {
            bLog("ERROR", "CloudSync", "Failed to save to Python Bridge", e);
        }
    }

    function generateDailyMix() {
        DAILY_MIX_CHANNELS =[];
        for (const key in BUCKETS) {
            const channels = BUCKETS[key].channels;
            if (channels && channels.length > 0) {
                const shuffled = [...channels].sort(() => 0.5 - Math.random());
                DAILY_MIX_CHANNELS.push(...shuffled.slice(0, 2));
            }
        }
        DAILY_MIX_GENERATED = true;
        bLog("INFO", "DailyMix", `Generated Daily Mix with ${DAILY_MIX_CHANNELS.length} curated channels.`);
    }

    // =========================================================
    // 2. DOM HELPERS
    // =========================================================
    function getVideoGrid() {
        const grids = Array.from(document.querySelectorAll('.pure-g')).filter(g =>
            !g.classList.contains('navbar') &&
            !g.classList.contains('h-box') &&
            !g.closest('#custom-unified-header')
        );

        let bestGrid = null;
        let maxDirectVideos = -1;

        grids.forEach(g => {
            let count = Array.from(g.children).filter(child => child.querySelector('a[href^="/watch"]')).length;
            if (count > maxDirectVideos) {
                maxDirectVideos = count;
                bestGrid = g;
            }
        });

        if (!bestGrid) return document.querySelector('#contents .pure-g:not(.navbar)');
        return bestGrid;
    }

    function getSafeCards() {
        const cards = new Set();
        const links = document.querySelectorAll('#contents a[href^="/watch"], #contents a[href^="/shorts"]');
        links.forEach(link => {
            const card = link.closest('[class*="pure-u-1"]');
            if (card && !card.querySelector('.navbar') && !card.closest('#custom-unified-header')) {
                // Removed the rigid img requirement to catch native broken cards so we can hide them properly
                cards.add(card);
            }
        });
        return Array.from(cards);
    }

    function getCleanName(el) {
        return el.textContent.replace(/[\n\r\u00A0]+|Verified/g, ' ').trim();
    }

    function extractNextPageUrl(docNode) {
        let btns = Array.from(docNode.querySelectorAll('a.pure-button'));
        let nextBtn = btns.find(b => b.textContent.includes('Next page'));

        if (nextBtn) {
            let href = nextBtn.getAttribute('href');
            if (href) return new URL(href, window.location.origin).href;
        }
        return null;
    }

    // =========================================================
    // 3. VSR OPTIMIZATION
    // =========================================================
    function optimizePlayback() {
        try {
            const video = document.querySelector('video');
            if (!video) return;

            if (video.style.transform !== 'translateZ(0px)') video.style.transform = 'translateZ(0px)';
            if (video.style.imageRendering !== 'auto') video.style.imageRendering = 'auto';
            if (video.style.filter !== 'none') video.style.filter = 'none';
            if (video.style.mask !== 'none') video.style.mask = 'none';

            const playerContainer = document.querySelector('#player-container');
            if (playerContainer && playerContainer.style.maxWidth !== '100%') {
                playerContainer.style.width = '100%';
                playerContainer.style.maxWidth = '100%';
                playerContainer.style.minHeight = '75vh';
            }
            bLog("INFO", "VSR", "Video optimized for hardware upscaling.");
        } catch (e) {
            bLog("ERROR", "VSR", "Error optimizing playback", e);
        }
    }

    // =========================================================
    // 4. TARGETED API SCRAPING (API Batch Fetching w/ Aborts)
    // =========================================================
    function buildVideoCard(vid, channelName, channelUrl, isShort) {
        try {
            const div = document.createElement('div');
            div.className = 'pure-u-1 pure-u-md-1-4';
            div.setAttribute('data-target-channel', channelName);
            div.setAttribute('data-scrape-index', SCRAPE_COUNTER++);

            if (isShort) {
                div.setAttribute('data-is-short', 'true');
            }

            const mins = Math.floor(vid.lengthSeconds / 60);
            const secs = (vid.lengthSeconds % 60).toString().padStart(2, '0');
            const duration = `${mins}:${secs}`;
            let thumbUrl = vid.videoThumbnails.find(t => t.quality === 'medium')?.url || vid.videoThumbnails[0]?.url || '';

            // Replaced 1x1 GIF with responsive 16:9 SVG to prevent layout collapse
            const placeholderSVG = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg' viewBox='0 0 16 9'%3E%3Crect width='16' height='9' fill='%231a1a1a'/%3E%3C%2Fsvg%3E";

            div.innerHTML = `
                <div class="h-box">
                    <a style="width:100%;" href="/watch?v=${vid.videoId}">
                        <div class="thumbnail">
                            <img class="thumbnail bucket-lazy-img" data-src="${thumbUrl}" src="${placeholderSVG}">
                            <p class="length">${duration}</p>
                        </div>
                    </a>
                    <div class="video-card-row flexible">
                        <a href="/watch?v=${vid.videoId}"><p dir="auto">${vid.title}</p></a>
                    </div>
                    <div class="video-card-row flexible">
                        <div class="flex-left">
                            <p class="video-data" dir="auto"><a href="${channelUrl}">${channelName}</a></p>
                            <p class="video-data" dir="auto">${vid.viewCountText || vid.viewCount + ' views'} • ${vid.publishedText || 'Unknown Date'}</p>
                        </div>
                    </div>
                </div>`;
            return div;
        } catch (e) {
            bLog("ERROR", "API_DOM", `Failed to build DOM node for ${channelName}`, e);
            return null;
        }
    }

    async function targetedFetch(channelName) {
        ACTIVE_FETCHES.add(channelName);
        try {
            let channelUrl = CHANNEL_CACHE[channelName];
            let ucid = null;

            if (channelUrl) {
                let match = channelUrl.match(/\/channel\/(UC[\w-]+)/);
                if (match) ucid = match[1];
            }

            if (!ucid) {
                const searchRes = await fetch(`${window.location.origin}/api/v1/search?q=${encodeURIComponent(channelName)}&type=channel`);
                if (!searchRes.ok) throw new Error(`Search API returned HTTP ${searchRes.status}`);

                const searchData = await searchRes.json();
                let match = searchData.find(c => c.author.toLowerCase() === channelName.toLowerCase()) || searchData[0];

                if (match && match.authorId) {
                    ucid = match.authorId;
                    channelUrl = `/channel/${ucid}`;
                    updateCache(channelName, channelUrl);
                } else {
                    throw new Error(`Could not resolve UCID via Search API for [${channelName}]`);
                }
            }

            const assignedBucket = getBucketForChannel(channelName);
            const ignoreTimer = BUCKETS[assignedBucket]?.ignoreShortsTimer || false;

            const vidRes = await fetch(`${window.location.origin}/api/v1/channels/${ucid}/videos`);
            let bestFull = null;
            let bestStandardFallback = null;
            let bestShort = null;

            if (vidRes.ok) {
                const responseData = await vidRes.json();
                const videos = responseData.videos || responseData ||[];

                for (let v of videos) {
                    if (v.lengthSeconds === 0) {
                        if (!bestFull) bestFull = v;
                    } else if (ignoreTimer) {
                        if (!bestFull) bestFull = v;
                    } else if (v.lengthSeconds >= 300) {
                        if (!bestFull) bestFull = v;
                    } else if (v.lengthSeconds >= 95) {
                        if (!bestStandardFallback) bestStandardFallback = v;
                    } else {
                        if (!bestShort) bestShort = v;
                    }
                }
            }

            const shortRes = await fetch(`${window.location.origin}/api/v1/channels/${ucid}/shorts`);
            if (shortRes.ok) {
                const shortData = await shortRes.json();
                const shorts = shortData.videos || shortData ||[];
                if (shorts.length > 0) {
                    if (!bestShort || shorts[0].published > bestShort.published) {
                        bestShort = shorts[0];
                    }
                }
            }

            let primaryVid = bestFull || bestStandardFallback;

            if (!primaryVid && bestShort) {
                primaryVid = bestShort;
                bestShort = null;
            }

            const mainGrid = getVideoGrid();
            const insertionPoint = document.querySelector('.page-nav-container') || document.querySelector('.h-box:has(.pure-button)');

            // HIDE BY DEFAULT: Any newly built card is born invisible so it doesn't flash on the wrong tab.
            if (primaryVid && !document.querySelector(`a[href*="v=${primaryVid.videoId}"]`)) {
                const card = buildVideoCard(primaryVid, channelName, channelUrl, false);
                if (card) {
                    card.classList.add('bucket-hidden');
                    if (insertionPoint && insertionPoint.parentNode === mainGrid) {
                        mainGrid.insertBefore(card, insertionPoint);
                    } else {
                        mainGrid.appendChild(card);
                    }
                }
            }

            if (bestShort && !document.querySelector(`a[href*="v=${bestShort.videoId}"]`)) {
                const card = buildVideoCard(bestShort, channelName, channelUrl, true);
                if (card) {
                    card.classList.add('bucket-hidden');
                    if (insertionPoint && insertionPoint.parentNode === mainGrid) {
                        mainGrid.insertBefore(card, insertionPoint);
                    } else {
                        mainGrid.appendChild(card);
                    }
                }
            }
        } catch (err) {
            bLog("ERROR", "API_Fetch", `Targeted Fetch failed for [${channelName}]`, err);
        } finally {
            ACTIVE_FETCHES.delete(channelName);
            COMPLETED_FETCHES.add(channelName);
        }
    }

    // Abort-aware batch processor
    async function fetchInBatches(channels, batchSize = 10, expectedFilter) {
        for (let i = 0; i < channels.length; i += batchSize) {
            // RACE CONDITION GUARD: If user switched tabs during background fetch, abort immediately.
            if (CURRENT_FILTER !== expectedFilter) {
                bLog("INFO", "Scraper", `Filter changed from ${expectedFilter} to ${CURRENT_FILTER}. Aborting background batch fetch.`);
                break;
            }
            const batch = channels.slice(i, i + batchSize);
            await Promise.all(batch.map(ch => targetedFetch(ch)));
        }
    }

    async function fillBucket() {
        if (!window.location.pathname.includes('/feed/subscriptions') || IS_FETCHING) return;

        try {
            if (CURRENT_FILTER === 'UNSORTED') {
                if (!NEXT_PAGE_URL_CACHE) NEXT_PAGE_URL_CACHE = extractNextPageUrl(document);

                const scrollDist = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;

                if (scrollDist < 1500 && CURRENT_PAGE < TARGET_PAGES && NEXT_PAGE_URL_CACHE) {
                    IS_FETCHING = true;
                    CURRENT_PAGE++;
                    bLog("INFO", "Scraper", `Infinite scroll triggered. Fetching Page ${CURRENT_PAGE} for UNSORTED triage...`);

                    try {
                        const absoluteNext = new URL(NEXT_PAGE_URL_CACHE, window.location.origin).href;
                        const response = await fetch(absoluteNext, { credentials: 'same-origin' });

                        // RACE CONDITION GUARD: If user left the UNSORTED tab while waiting for HTML, abort.
                        if (CURRENT_FILTER !== 'UNSORTED') {
                            IS_FETCHING = false;
                            return;
                        }

                        const html = await response.text();
                        const doc = new DOMParser().parseFromString(html, 'text/html');

                        NEXT_PAGE_URL_CACHE = extractNextPageUrl(doc);

                        // 16:9 SVG Placeholder (Fixes Layout Collapse)
                        const placeholderSVG = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg' viewBox='0 0 16 9'%3E%3Crect width='16' height='9' fill='%231a1a1a'/%3E%3C%2Fsvg%3E";

                        doc.querySelectorAll('img').forEach(img => {
                            if (img.src && !img.src.includes('data:image')) {
                                img.dataset.src = img.src;
                                img.src = placeholderSVG;
                                img.classList.add('bucket-lazy-img');
                            }
                        });

                        let incomingItems = doc.querySelectorAll('#contents > .pure-g >[class*="pure-u-"]');
                        if (incomingItems.length === 0) incomingItems = doc.querySelectorAll('.pure-g >[class*="pure-u-"]');

                        const mainGrid = getVideoGrid();
                        const insertionPoint = document.querySelector('.page-nav-container') || document.querySelector('.h-box:has(.pure-button)');

                        if (incomingItems.length > 0) {
                            incomingItems.forEach(item => {
                                const watchLink = item.querySelector('a[href^="/watch"]');
                                if (watchLink && !item.querySelector('.navbar') && !item.innerText.includes('Next page')) {
                                    const videoID = watchLink.getAttribute('href').split('v=')[1]?.split('&')[0];
                                    if (!document.querySelector(`a[href*="v=${videoID}"]`)) {
                                        // HIDE BY DEFAULT to prevent ghost flashes on other tabs
                                        item.classList.add('bucket-hidden');
                                        if (insertionPoint && insertionPoint.parentNode === mainGrid) {
                                            mainGrid.insertBefore(item, insertionPoint);
                                        } else {
                                            mainGrid.appendChild(item);
                                        }
                                    }
                                }
                            });
                        }
                        IS_FETCHING = false;
                        applyChangesLive();
                    } catch (err) {
                        IS_FETCHING = false;
                        bLog("ERROR", "Scraper", "Error inside fillBucket UNSORTED fetch", err);
                    }
                }
            } else if (CURRENT_FILTER === 'ALL') {
                let toFetch = MISSING_CHANNELS_NAMES.filter(ch => !ACTIVE_FETCHES.has(ch) && !COMPLETED_FETCHES.has(ch));
                if (toFetch.length > 0) {
                    IS_FETCHING = true;
                    bLog("INFO", "Scraper", `Batch fetching ${toFetch.length} channels for Global ALL Tab...`);
                    await fetchInBatches(toFetch, 10, CURRENT_FILTER);
                    IS_FETCHING = false;
                    applyChangesLive();
                }
            } else {
                let toFetch = MISSING_CHANNELS_NAMES.filter(ch => !ACTIVE_FETCHES.has(ch) && !COMPLETED_FETCHES.has(ch));
                if (toFetch.length > 0) {
                    IS_FETCHING = true;
                    bLog("INFO", "Scraper", `Batch fetching ${toFetch.length} missing channels for Category Tab...`);
                    await fetchInBatches(toFetch, 10, CURRENT_FILTER);
                    IS_FETCHING = false;
                    applyChangesLive();
                }
            }
        } catch (e) {
            bLog("ERROR", "Scraper", "Error in fillBucket main loop", e);
            IS_FETCHING = false;
        }
    }

    // =========================================================
    // 5. GLOBAL YOUTUBE DARK UI STYLING
    // =========================================================
    const cssId = 'bucket-styles-v43-3';
    if (!document.getElementById(cssId)) {
        const style = document.createElement('style');
        style.id = cssId;
        style.innerHTML = `
            body, html, #contents { background-color: #0f0f0f !important; color: #f1f1f1 !important; font-family: "Roboto", "Arial", sans-serif !important; font-size: 14px !important; }
            p[dir="auto"], h5[dir="auto"], p, h5, .video-card-row { font-family: "Roboto", "Arial", sans-serif !important; }
            p[dir="auto"] { font-weight: 500 !important; font-size: 15px !important; color: #f1f1f1 !important; margin-top: 10px !important; margin-bottom: 4px !important; line-height: 1.4 !important; }
            h5[dir="auto"] a, .video-data { font-weight: normal !important; color: #aaa !important; font-size: 13px !important; text-decoration: none !important; }
            .thumbnail, .thumbnail img, .thumbnail video { border-radius: 12px !important; overflow: hidden !important; background: transparent !important; border: none !important; box-shadow: none !important; object-fit: cover !important; }
            .video-card-row { border: none !important; box-shadow: none !important; }

            /* Universal Lazy Load Fade In + Structural Guarantee */
            .bucket-lazy-img {
                opacity: 0; transition: opacity 0.3s ease-in-out;
                aspect-ratio: 16 / 9; width: 100%; object-fit: cover;
            }
            .bucket-lazy-img.loaded { opacity: 1 !important; }

            /* Sandboxed Cleanup: Only eradicate Invidious Junk on the custom Dashboard */
            body.feed-view .navbar { display: none !important; }
            body.feed-view #contents h3, body.feed-view #contents hr { display: none !important; }

            #custom-unified-header { display: flex; flex-direction: column; align-items: center; width: 100%; margin-bottom: 15px; padding-top: 15px; background-color: #0f0f0f; }
            .custom-invidious-logo { font-size: 24px; font-weight: bold; color: #f1f1f1 !important; letter-spacing: 2px; margin-bottom: 10px; text-decoration: none !important; }
            #custom-unified-header form[action="/search"] { width: 100%; max-width: 650px; margin: 0 auto 10px auto !important; display: flex; transform: none !important; left: auto !important; top: auto !important; }
            form[action="/search"] fieldset { display: flex !important; width: 100% !important; border: none !important; padding: 0 !important; margin: 0 !important; }
            form[action="/search"] input[name="q"], form[action="/search"] input[type="search"] { flex-grow: 1 !important; background-color: #121212 !important; border: 1px solid #303030 !important; border-radius: 40px 0 0 40px !important; color: #f1f1f1 !important; padding: 10px 24px !important; font-size: 16px !important; outline: none !important; height: 44px !important; box-sizing: border-box !important; }
            form[action="/search"] input[name="q"]:focus { border-color: #f1f1f1 !important; }
            form[action="/search"] button[type="submit"], form[action="/search"] button { background-color: #222222 !important; border: 1px solid #303030 !important; border-left: none !important; border-radius: 0 40px 40px 0 !important; padding: 0 24px !important; color: #f1f1f1 !important; cursor: pointer !important; margin: 0 !important; height: 44px !important; box-sizing: border-box !important; }
            form[action="/search"] button:hover { background-color: #303030 !important; color: #fff !important; }

            table, .pure-table { background-color: transparent !important; color: #f1f1f1 !important; border: none !important; width: 100% !important; }
            .pure-table th, .pure-table td { background-color: #0f0f0f !important; border-bottom: 1px solid #303030 !important; border-left: none !important; border-right: none !important; color: #f1f1f1 !important; }
            .pure-table thead { background-color: #1a1a1a !important; color: #aaa !important; }
            .pure-table tbody tr:nth-child(even) td { background-color: #1a1a1a !important; }
            .pure-table a { color: #00bfff !important; text-decoration: none !important; }
            .pure-table a:hover { color: #f1f1f1 !important; }

            .bucket-hidden { display: none !important; }
            body.bucket-active-page.feed-view footer, body.bucket-active-page.feed-view .footer { display: none !important; }
            body.bucket-active-page.feed-view .page-nav-container { display: none !important; }
            body.bucket-active-page.feed-view .h-box > .pure-button-group { display: none !important; }
            body { transition: margin-left 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
            body.tracker-open { margin-left: 320px !important; }

            .bucket-ui-wrapper { display: flex; align-items: center; background: #0f0f0f; border-bottom: 1px solid #303030; border-top: 1px solid #303030; padding: 10px 16px; gap: 8px; width: 100%; box-sizing: border-box; }
            .bucket-ui-wrapper.mini-wrapper { justify-content: center !important; border-top: none !important; }
            .bucket-scroll-area { display: flex; flex-grow: 1; overflow: hidden; scroll-behavior: smooth; gap: 8px; white-space: nowrap; padding: 2px 0; }
            .bucket-nav-btn { background: #222; color: #f1f1f1; border: 1px solid #303030; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; user-select: none; flex-shrink: 0; font-weight: bold; }
            .bucket-btn { flex-shrink: 0; background: #222; color: #f1f1f1; border: 1px solid #303030; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: 0.2s; max-width: 300px; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center;}
            .bucket-btn.active { background: #f1f1f1; color: #0f0f0f; border-color: #f1f1f1; font-weight: bold; }
            .bucket-btn.action-btn { background: #272727; color: #f1f1f1; border-color: #303030; }
            .bucket-btn.action-btn:hover { background: #3f3f3f; }

            .bucket-tag { font-size: 11px; background: #272727; color: #f1f1f1; padding: 4px 8px; border-radius: 4px; border: 1px solid #444; display: flex; align-items: center; font-weight: 600; letter-spacing: 0.5px; white-space: nowrap; line-height: 1; }
            .bucket-add-btn { display: flex; align-items: center; color: #aaa; cursor: pointer; font-weight: bold; font-size: 18px; line-height: 1; padding: 0 4px; transition: 0.2s; }
            .bucket-add-btn:hover { color: #f1f1f1; transform: scale(1.2); }

            /* Shorts UI Overlay Styles */
            .bucket-short-indicator {
                position: absolute;
                top: 8px;
                left: 8px;
                background: rgba(255, 152, 0, 0.9);
                color: #fff !important;
                font-size: 11px;
                font-weight: bold;
                padding: 4px 6px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                gap: 4px;
                z-index: 10;
                box-shadow: 0 2px 4px rgba(0,0,0,0.5);
                pointer-events: none;
            }
            .bucket-short-card .thumbnail {
                border-bottom: 3px solid #ff9800 !important;
            }

            /* Sandboxed Hide: Only nuke these icons on the dashboard */
            body.feed-view .video-card-row a[href^="https://youtube.com"],
            body.feed-view .video-card-row a[title*="YouTube" i],
            body.feed-view .video-card-row a[title*="Listen" i],
            body.feed-view .video-card-row a[title*="Audio" i],
            body.feed-view .video-card-row a[title*="Switch" i],
            body.feed-view .video-card-row a[title*="instance" i],
            body.feed-view .video-card-row i[class*="ion-"],
            body.feed-view .video-card-row .icon {
                display: none !important;
            }

            #bucket-debug-panel {
                position: fixed; top: 0; left: -320px; width: 320px; height: 100vh; background: #0f0f0f; border-right: 1px solid #303030; z-index: 9999; padding: 20px; box-sizing: border-box; overflow-y: auto; transition: left 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }
            body.tracker-open #bucket-debug-panel { left: 0; }

            .sidebar-badge { display: flex; justify-content: space-between; align-items: center; background: transparent; border: none; padding: 10px 12px; border-radius: 8px; color: #f1f1f1; font-weight: 500; font-size: 14px; transition: 0.2s; }
            .sidebar-badge.found-badge { cursor: pointer; }
            .sidebar-badge.found-badge:hover, .sidebar-nav-link:hover { background: #272727; transform: translateX(3px); }
            .channel-link-icon { margin-left: 10px; text-decoration: none; color:#f1f1f1; transition: 0.2s; font-size: 16px;}
            .channel-link-icon:hover { transform: scale(1.2); text-shadow: 0 0 4px #fff; }

            @keyframes flashWhite {
                0% { box-shadow: 0 0 0px transparent; outline: 2px solid transparent; }
                20% { box-shadow: 0 0 30px 10px rgba(255,255,255,0.15); outline: 2px solid #fff; transform: scale(1.02); background: #1a1a1a; border-radius: 12px;}
                100% { box-shadow: 0 0 0px transparent; outline: 2px solid transparent; transform: scale(1); background: inherit; border-radius: 0px;}
            }
            .flash-highlight { animation: flashWhite 1.5s ease-out; z-index: 100; position: relative; }
            .missing-alert { font-weight: 500; font-size: 13px; text-align: center; padding: 8px; border-radius: 8px; background: #272727; color: #f1f1f1; border: 1px solid #444;}

            .bucket-modal-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.8); z-index: 10000; display: flex; align-items: center; justify-content: center; }
            .bucket-modal { background: #212121; padding: 25px; border-radius: 12px; border: 1px solid #303030; width: 480px; box-shadow: 0 0 20px black; max-height: 80vh; overflow-y: auto; color: #f1f1f1; }
            .bucket-order-row { display: flex; align-items: center; justify-content: space-between; padding: 8px; background: #0f0f0f; margin-bottom: 4px; border-radius: 4px; }
            .bucket-order-input { width: 60px; background: #272727; color: #f1f1f1; border: 1px solid #303030; padding: 4px; border-radius: 4px; }
            .bucket-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px; }
            .bucket-option { padding: 10px; border-radius: 8px; border: 1px solid #303030; background: #0f0f0f; color: #ccc; cursor: pointer; text-align: center; font-weight: bold; transition: 0.1s; }
            .bucket-option.selected { background: #f1f1f1; color: #0f0f0f; border-color: #f1f1f1; }
            .bucket-option:hover { background: #272727; }
            .bucket-purge-group { margin-top: 20px; padding-top: 15px; border-top: 1px solid #303030; display: flex; flex-direction: column; gap: 10px; }
            .purge-btn { padding: 12px; border-radius: 8px; cursor: pointer; font-weight: bold; text-align: center; border: 1px solid #444; transition: opacity 0.2s; }
            .purge-btn:hover { opacity: 0.85; }
            .purge-tags { background: #272727; color: #f1f1f1; }
            .purge-cats { background: #272727; color: #f1f1f1; }
            .bucket-close { margin-top: 20px; width: 100%; padding: 12px; cursor: pointer; background: #272727; color: #f1f1f1; border: 1px solid #444; border-radius: 8px; font-weight: bold; }
            .bucket-close:hover { background: #3f3f3f; }
        `;
        document.head.appendChild(style);
    }

    // =========================================================
    // 6. REACTIVE ENGINE
    // =========================================================
    function applyChangesLive() {
        try {
            const isSubscriptionFeed = window.location.pathname.includes('/feed/subscriptions');
            if (!isSubscriptionFeed) {
                document.body.classList.remove('feed-view');
                return;
            }

            document.body.classList.add('bucket-active-page');
            document.body.classList.add('feed-view');

            const cards = getSafeCards();
            let groupedChannels = {};

            if (CURRENT_FILTER !== LAST_ACTIVE_FILTER) {
                LAST_ACTIVE_FILTER = CURRENT_FILTER;
                COMPLETED_FETCHES.clear();
            }

            cards.forEach(card => {
                let icons = card.querySelectorAll('a[title*="YouTube"], a[title*="Listen"], a[title*="instance"], a[title*="Audio"], i.icon');
                icons.forEach(icon => {
                    let elToHide = icon;
                    if(icon.tagName === 'I' && icon.parentElement && icon.parentElement.tagName === 'A') {
                        elToHide = icon.parentElement;
                    }
                    elToHide.style.display = 'none';
                });

                if (!card.hasAttribute('data-scrape-index')) {
                    card.setAttribute('data-scrape-index', SCRAPE_COUNTER++);
                }

                // 1. EXTRACT CHANNEL NAME FIRST TO CHECK EXEMPTIONS
                let link = card.querySelector('a[href^="/channel/"]');
                let channelName = card.getAttribute('data-target-channel');

                if (!channelName && link) channelName = getCleanName(link);
                if (!channelName) {
                    const textNodes = Array.from(card.querySelectorAll('p[dir="auto"]'));
                    if (textNodes.length > 1) channelName = textNodes[1].textContent.trim();
                    else channelName = "Unknown";
                    card.setAttribute('data-target-channel', channelName);
                }

                if (link && !card.getAttribute('data-target-channel')) {
                    updateCache(channelName, link.getAttribute('href'));
                }

                const assignedBucket = getBucketForChannel(channelName);
                card.setAttribute('data-bucket-category', assignedBucket || 'Unsorted');

                let tagTargetNode = link;
                if (!tagTargetNode) {
                    const textNodes = Array.from(card.querySelectorAll('p[dir="auto"]'));
                    if (textNodes.length > 1) tagTargetNode = textNodes[1];
                }
                if (tagTargetNode) {
                    updateTagInDOM(tagTargetNode, assignedBucket, channelName);
                }

                const ignoreTimer = BUCKETS[assignedBucket]?.ignoreShortsTimer || false;

                // 2. APPLY EXEMPTION-AWARE SHORTS LOGIC
                let isNativeShort = card.getAttribute('data-is-short') === 'true' || card.getAttribute('data-is-short-fallback') === 'true';
                if (!isNativeShort) {
                    if (card.querySelector('a[href*="/shorts"]')) {
                        isNativeShort = true;
                    } else if (!ignoreTimer) {
                        let lengthNode = card.querySelector('.length') || Array.from(card.querySelectorAll('p')).find(p => p.textContent.includes(':') && p.textContent.length < 8);
                        if (lengthNode) {
                            let parts = lengthNode.textContent.trim().split(':').map(Number);
                            if (parts.length === 2 && ((parts[0] * 60) + parts[1]) < 95) {
                                isNativeShort = true;
                            }
                        } else {
                            let textContent = card.textContent.toLowerCase();
                            let isLiveOrPremiere = card.querySelector('.badge') || textContent.includes('live') || textContent.includes('premiere') || textContent.includes('watching');
                            if (!isLiveOrPremiere) {
                                isNativeShort = true;
                            }
                        }
                    }
                }

                if (isNativeShort) {
                    card.setAttribute('data-is-short', 'true');
                    card.classList.add('bucket-short-card');
                    let thumb = card.querySelector('.thumbnail');
                    if (thumb && !card.querySelector('.bucket-short-indicator')) {
                        thumb.style.position = 'relative';
                        let ind = document.createElement('div');
                        ind.className = 'bucket-short-indicator';
                        ind.innerHTML = '<i class="icon ion-md-phone-portrait"></i> Short';
                        thumb.appendChild(ind);
                    }
                }

                let isAllowed = false;
                if (CURRENT_FILTER === 'ALL') {
                    isAllowed = true;
                } else if (CURRENT_FILTER === 'UNSORTED') {
                    isAllowed = (assignedBucket === null || assignedBucket === 'Unsorted');
                } else {
                    isAllowed = (assignedBucket === CURRENT_FILTER);
                }

                if (isAllowed) {
                    if (!groupedChannels[channelName]) {
                        groupedChannels[channelName] = { full:[], short:[] };
                    }
                    if (isNativeShort) {
                        groupedChannels[channelName].short.push(card);
                    } else {
                        groupedChannels[channelName].full.push(card);
                    }
                }
            });

            let displayList =[];

            if (CURRENT_FILTER === 'ALL') {
                let missing = [];
                let fullCards =[];
                let allExpectedChannels = new Set();

                Object.values(BUCKETS).forEach(b => {
                    b.channels.forEach(c => allExpectedChannels.add(c));
                });

                allExpectedChannels.forEach(ch => {
                    let chKey = Object.keys(groupedChannels).find(gc => gc.toLowerCase().trim() === ch.toLowerCase().trim());
                    let hasFull = chKey && groupedChannels[chKey].full.length > 0;

                    if (hasFull) {
                        groupedChannels[chKey].full.sort((a,b) => parseInt(a.getAttribute('data-scrape-index')) - parseInt(b.getAttribute('data-scrape-index')));
                        fullCards.push({ card: groupedChannels[chKey].full[0], name: chKey });
                    } else {
                        missing.push(ch);
                    }
                });

                MISSING_CHANNELS_NAMES = missing;
                // Sort chronologically based on initial DOM/API scrape index
                fullCards.sort((a,b) => parseInt(a.card.getAttribute('data-scrape-index')) - parseInt(b.card.getAttribute('data-scrape-index')));

                // NO SHORTS ON THE ALL TAB. Period.
                displayList = fullCards.map(item => item.card);

            } else if (CURRENT_FILTER === 'UNSORTED') {
                MISSING_CHANNELS_NAMES =[];
                let allowedFound =[];

                for (const channel in groupedChannels) {
                    let assignedBucket = getBucketForChannel(channel);
                    if (!assignedBucket || assignedBucket === 'Unsorted') {
                        if (groupedChannels[channel].full.length > 0) allowedFound.push(...groupedChannels[channel].full);
                        if (groupedChannels[channel].short.length > 0) allowedFound.push(...groupedChannels[channel].short);
                    }
                }

                allowedFound.sort((a,b) => parseInt(a.getAttribute('data-scrape-index')) - parseInt(b.getAttribute('data-scrape-index')));
                displayList = allowedFound;

            } else {
                const expectedChannels = BUCKETS[CURRENT_FILTER]?.channels || [];
                let missing =[];
                let fullCards =[];
                let shortCards =[];

                expectedChannels.forEach(ch => {
                    let chKey = Object.keys(groupedChannels).find(gc => gc.toLowerCase().trim() === ch.toLowerCase().trim());
                    let hasFull = chKey && groupedChannels[chKey].full.length > 0;
                    let hasShort = chKey && groupedChannels[chKey].short.length > 0;

                    if (hasFull) {
                        groupedChannels[chKey].full.sort((a,b) => parseInt(a.getAttribute('data-scrape-index')) - parseInt(b.getAttribute('data-scrape-index')));
                        fullCards.push({ card: groupedChannels[chKey].full[0], name: chKey });
                    } else {
                        missing.push(ch);
                    }

                    if (hasShort) {
                        groupedChannels[chKey].short.sort((a,b) => parseInt(a.getAttribute('data-scrape-index')) - parseInt(b.getAttribute('data-scrape-index')));
                        shortCards.push({ card: groupedChannels[chKey].short[0], name: chKey });
                    }
                });

                MISSING_CHANNELS_NAMES = missing;
                fullCards.sort((a,b) => a.name.localeCompare(b.name));
                shortCards.sort((a,b) => a.name.localeCompare(b.name));
                displayList =[...fullCards.map(i => i.card), ...shortCards.map(i => i.card)];
            }

            const mainGrid = getVideoGrid();
            const insertionPoint = document.querySelector('.page-nav-container') || document.querySelector('.h-box:has(.pure-button)');
            const currentVisibleCards = Array.from(mainGrid.children).filter(c => c.querySelector('a[href^="/watch"]') && !c.classList.contains('bucket-hidden'));

            let needsReorder = false;
            if (currentVisibleCards.length !== displayList.length) {
                needsReorder = true;
            } else {
                for (let i = 0; i < displayList.length; i++) {
                    if (currentVisibleCards[i] !== displayList[i]) {
                        needsReorder = true;
                        break;
                    }
                }
            }

            if (needsReorder) {
                cards.forEach(c => c.classList.add('bucket-hidden'));

                displayList.forEach(card => {
                    card.classList.remove('bucket-hidden');
                    if (insertionPoint && insertionPoint.parentNode === mainGrid) {
                        mainGrid.insertBefore(card, insertionPoint);
                    } else {
                        mainGrid.appendChild(card);
                    }
                });

                cards.forEach(card => {
                    if (!displayList.includes(card)) {
                        if (insertionPoint && insertionPoint.parentNode === mainGrid) {
                            mainGrid.insertBefore(card, insertionPoint);
                        } else {
                            mainGrid.appendChild(card);
                        }
                    }
                });
            }

            const allGrids = document.querySelectorAll('#contents .pure-g');
            allGrids.forEach(g => {
                if (g !== mainGrid && g.children.length === 0) g.remove();
            });

            updateStatsPanel(displayList);
            observeLazyImages();

            const scroller = document.querySelector('.bucket-scroll-area');
            if (scroller) renderButtons(scroller);
            fillBucket();

        } catch (e) {
            bLog("ERROR", "Renderer", "Error in applyChangesLive", e);
        }
    }

    // =========================================================
    // 6.5 PURE MONOCHROME DASHBOARD
    // =========================================================
    function updateStatsPanel(displayList) {
        try {
            let debugPanel = document.getElementById('bucket-debug-panel');
            if (!debugPanel) {
                debugPanel = document.createElement('div');
                debugPanel.id = 'bucket-debug-panel';
                document.body.appendChild(debugPanel);
            }

            const isFeed = window.location.pathname.includes('/feed/subscriptions');
            let feedSpecificHtml = '';

            if (isFeed) {
                let totalAllowed = 0;
                if (CURRENT_FILTER === 'ALL' || CURRENT_FILTER === 'UNSORTED') {
                    totalAllowed = displayList.length;
                } else {
                    totalAllowed = BUCKETS[CURRENT_FILTER]?.channels?.length || 0;
                }

                let headerStatus = `
                    <div style="color:#f1f1f1; font-size:11px; margin-bottom:10px; font-weight:bold; text-transform:uppercase; letter-spacing:1px;">Filter: ${CURRENT_FILTER}</div>
                    <div style="background:#272727; padding:12px; border-radius:8px; border: 1px solid #444; color:#f1f1f1; font-weight:bold; margin-bottom: 15px; text-align:center;">
                        <i class="icon ion-md-funnel" style="margin-right:6px;"></i>Total Items: ${displayList.length}
                    </div>`;

                if (CURRENT_FILTER !== 'ALL' && CURRENT_FILTER !== 'UNSORTED') {
                    let currentlyFetching = MISSING_CHANNELS_NAMES.filter(ch => ACTIVE_FETCHES.has(ch));
                    let failedToFind = MISSING_CHANNELS_NAMES.filter(ch => COMPLETED_FETCHES.has(ch));

                    if (currentlyFetching.length > 0) {
                        headerStatus += `<div class="missing-alert"><i class="icon ion-md-search" style="margin-right:4px;"></i> Targeting ${currentlyFetching.length} MIA...</div>`;
                    } else if (failedToFind.length > 0) {
                        headerStatus += `<div class="missing-alert"><i class="icon ion-md-alert" style="margin-right:4px;"></i> MIA CHECKED - No Recent</div>`;
                    }
                } else {
                    if (IS_FETCHING) {
                        headerStatus += `<div class="missing-alert"><i class="icon ion-md-sync" style="margin-right:4px;"></i> Fetching Timeline...</div>`;
                    }
                }

                feedSpecificHtml += headerStatus + `<div style="display:flex; flex-direction:column; gap:4px; margin-top: 15px;">`;

                let foundNames = new Set();

                displayList.forEach(card => {
                    const link = card.querySelector('a[href^="/channel/"]');
                    let name = card.getAttribute('data-target-channel') || (link ? getCleanName(link) : 'Unknown');

                    let isShortFallback = card.getAttribute('data-is-short') === 'true' || card.getAttribute('data-is-short-fallback') === 'true';

                    let trackingKey = name.toLowerCase().trim() + (isShortFallback ? '_short' : '_full');
                    if (foundNames.has(trackingKey)) return;
                    foundNames.add(trackingKey);

                    let channelUrl = CHANNEL_CACHE[name.trim()] || (link ? link.getAttribute('href') : '#');
                    let safeName = name.replace(/"/g, '&quot;');

                    let styleOverride = isShortFallback ? `border-left: 3px solid #ff9800;` : ``;
                    let iconOverride = isShortFallback ? `<i class="icon ion-md-phone-portrait" title="Short Fallback" style="color:#ff9800; margin-right:6px;"></i>` : ``;

                    feedSpecificHtml += `
                        <div class="sidebar-badge found-badge" data-scroll-target="${safeName}" title="Scroll to ${name}'s Video" style="${styleOverride}">
                            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:80%; color:#f1f1f1;">${iconOverride}${name}</span>
                            <a href="${channelUrl}" target="_blank" class="channel-link-icon" title="Open Channel Page in New Tab"><i class="icon ion-md-open"></i></a>
                        </div>`;
                });

                if (CURRENT_FILTER !== 'ALL' && CURRENT_FILTER !== 'UNSORTED') {
                    const expectedChannels = BUCKETS[CURRENT_FILTER]?.channels ||[];
                    expectedChannels.forEach(ch => {
                        let cleanCh = ch.toLowerCase().trim();
                        if (!foundNames.has(cleanCh + '_full') && COMPLETED_FETCHES.has(ch)) {
                            feedSpecificHtml += `
                                <div class="sidebar-badge" style="color:#f1f1f1; border: 1px solid #444; background: #1a1a1a; cursor:default; opacity:0.7;">
                                    <span><i class="icon ion-md-close-circle" style="margin-right:5px; color:#f1f1f1;"></i>${ch} (MIA)</span>
                                </div>`;
                        }
                    });
                }
                feedSpecificHtml += `</div>`;
            }

            let authIcon = IS_LOGGED_IN ? "ion-md-log-out" : "ion-md-log-in";
            let authTitle = IS_LOGGED_IN ? "Log Out" : "Log In";

            let html = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; border-bottom: 1px solid #303030; padding-bottom: 15px;">
                    <h2 style="margin:0; color:#f1f1f1; font-size:18px; text-transform:uppercase; font-weight: 500;">DASHBOARD</h2>
                    <div style="cursor:pointer; font-size:24px; color:#f1f1f1; line-height:1;" title="Close Sidebar" onclick="document.body.classList.remove('tracker-open'); GM_setValue('bucket_tracker_open_gm', 'false');"><i class="icon ion-md-close"></i></div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; background:#272727; border: 1px solid #444; padding:12px 15px; border-radius:8px; margin-bottom:15px;">
                    <div style="font-weight:bold; color:#f1f1f1; font-size:14px; text-transform:uppercase;"><i class="icon ion-md-person" style="margin-right:6px;"></i>${USER_NAME}</div>
                    <div style="display:flex; gap:14px; font-size:18px;"><a href="#" id="sidebar-logout-btn" title="${authTitle}" style="text-decoration:none; color:#f1f1f1; transition:0.2s;"><i class="icon ${authIcon}"></i></a></div>
                </div>
                <div style="display:flex; flex-direction:column; gap:2px; margin-bottom: 15px; border-bottom: 1px solid #303030; padding-bottom: 15px;">
                    <div style="color:#f1f1f1; font-size:11px; margin-bottom:5px; font-weight:bold; text-transform:uppercase; letter-spacing:1px;">Tools</div>
                    <a href="/notifications" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;"><span><i class="icon ion-md-notifications" style="margin-right:8px;"></i>${NOTIF_COUNT}</span></a>
                    <a href="/feed/history" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;"><span><i class="icon ion-md-time" style="margin-right:8px;"></i>Watch History</span></a>
                    <a href="/subscription_manager" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;"><span><i class="icon ion-md-people" style="margin-right:8px;"></i>Manage Subscriptions</span></a>
                    <a href="/preferences" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;"><span><i class="icon ion-md-options" style="margin-right:8px;"></i>Invidious Preferences</span></a>
                </div>
                <div style="display:flex; flex-direction:column; gap:2px; margin-bottom: 15px; border-bottom: 1px solid #303030; padding-bottom: 15px;">
                    <div style="color:#f1f1f1; font-size:11px; margin-bottom:5px; font-weight:bold; text-transform:uppercase; letter-spacing:1px;">Navigation</div>
                    <a href="/feed/popular" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;"><span><i class="icon ion-md-flame" style="margin-right:8px;"></i>Popular</span></a>
                    <a href="/feed/trending" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;"><span><i class="icon ion-md-trending-up" style="margin-right:8px;"></i>Trending</span></a>
                    <a href="/feed/subscriptions" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;"><span><i class="icon ion-md-play-circle" style="margin-right:8px;"></i>Subscriptions</span></a>
                    <a href="/feed/playlists" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;"><span><i class="icon ion-md-folder" style="margin-right:8px;"></i>Playlists</span></a>
                </div>
                ${feedSpecificHtml}
            `;
            if (debugPanel.innerHTML !== html) {
                debugPanel.innerHTML = html;
            }
        } catch (e) {
            bLog("ERROR", "Renderer", "Error updating Stats Panel", e);
        }
    }

    document.addEventListener('click', (e) => {
        if (e.target.closest('#sidebar-logout-btn')) {
            e.preventDefault();
            try {
                if (IS_LOGGED_IN) {
                    let allForms = Array.from(document.querySelectorAll('form'));
                    let formLogout = allForms.find(f => f.action && (f.action.toLowerCase().includes('logout') || f.action.toLowerCase().includes('signout')));
                    let allNativeLinks = Array.from(document.querySelectorAll('a')).filter(a => !a.closest('#bucket-debug-panel') && !a.closest('#custom-unified-header'));
                    let aLogout = allNativeLinks.find(a => a.href && (a.href.toLowerCase().includes('logout') || a.href.toLowerCase().includes('signout')));

                    if (formLogout) {
                        let btn = formLogout.querySelector('button, input[type="submit"]');
                        if (btn) btn.click(); else formLogout.submit();
                    } else if (aLogout) {
                        aLogout.click();
                        setTimeout(() => window.location.href = '/signout?referer=/feed/subscriptions', 500);
                    } else {
                        window.location.href = '/signout?referer=/feed/subscriptions';
                    }
                } else {
                    let allNativeLinks = Array.from(document.querySelectorAll('a')).filter(a => !a.closest('#bucket-debug-panel') && !a.closest('#custom-unified-header'));
                    let aLogin = allNativeLinks.find(a => a.href && a.href.toLowerCase().includes('login'));

                    if (aLogin) {
                        aLogin.href = '/login?referer=/feed/subscriptions';
                        aLogin.click();
                        setTimeout(() => window.location.href = '/login?referer=/feed/subscriptions', 500);
                    } else {
                        window.location.href = '/login?referer=/feed/subscriptions';
                    }
                }
            } catch (err) {
                bLog("ERROR", "UX_Click", "Logout fail", err);
            }
            return;
        }

        const badge = e.target.closest('.sidebar-badge.found-badge');
        if (badge) {
            if (e.target.closest('.channel-link-icon')) return;
            const targetName = badge.getAttribute('data-scroll-target');
            if (targetName) {
                const mainGrid = getVideoGrid();
                if (!mainGrid) return;
                const cards = Array.from(mainGrid.children);
                let targetCard = null;
                for (let card of cards) {
                    if (card.classList.contains('bucket-hidden')) continue;
                    let link = card.querySelector('a[href^="/channel/"]');
                    let cName = card.getAttribute('data-target-channel') || (link ? getCleanName(link) : '');
                    if (cName.toLowerCase().trim() === targetName.toLowerCase().trim()) {
                        targetCard = card;
                        break;
                    }
                }
                if (targetCard) {
                    targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    targetCard.classList.remove('flash-highlight');
                    void targetCard.offsetWidth;
                    targetCard.classList.add('flash-highlight');
                    setTimeout(() => targetCard.classList.remove('flash-highlight'), 1600);
                }
            }
        }
    });

    function updateTagInDOM(channelNode, assignedBucket, explicitChannelName) {
        let parent = channelNode.parentNode;
        parent.style.display = 'flex';
        parent.style.alignItems = 'center';
        parent.style.gap = '10px';
        parent.style.flexWrap = 'nowrap';
        parent.style.marginTop = '8px';
        parent.style.marginBottom = '8px';
        parent.style.overflow = 'hidden';

        channelNode.style.display = 'flex';
        channelNode.style.alignItems = 'center';
        channelNode.style.lineHeight = '1';

        let tag = parent.querySelector('.bucket-tag');
        let btn = parent.querySelector('.bucket-add-btn');

        if (tag) {
            if (!assignedBucket) tag.remove();
            else tag.innerText = assignedBucket;
        } else if (assignedBucket) {
            tag = document.createElement('span');
            tag.className = 'bucket-tag';
            tag.innerText = assignedBucket;
            if (btn) {
                parent.insertBefore(tag, btn);
            } else {
                parent.appendChild(tag);
            }
        }

        if (!btn) {
            const addBtn = document.createElement('span');
            addBtn.className = 'bucket-add-btn';
            addBtn.innerText = '+';
            addBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                let chName = explicitChannelName || getCleanName(channelNode);
                openManagerModal(chName);
            };
            parent.appendChild(addBtn);
        }
    }

    function getBucketForChannel(name) {
        let cleanName = name.toLowerCase().trim();
        for (const[key, val] of Object.entries(BUCKETS)) {
            if (val.channels.some(n => n.toLowerCase().trim() === cleanName)) return key;
        }
        return null;
    }

    // =========================================================
    // 7. UI MODALS
    // =========================================================
    function openSettingsModal() {
        const existing = document.querySelector('.bucket-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'bucket-modal-overlay';
        overlay.onclick = (e) => { if(e.target === overlay) overlay.remove(); };

        const modal = document.createElement('div');
        modal.className = 'bucket-modal';
        modal.innerHTML = `<h2 style="margin:0 0 10px 0;">Settings & Ordering</h2>`;

        const sortedKeys = Object.keys(BUCKETS).sort((a,b) => BUCKETS[a].order - BUCKETS[b].order);

        sortedKeys.forEach(key => {
            const row = document.createElement('div');
            row.className = 'bucket-order-row';
            row.style.display = 'flex';
            row.style.gap = '10px';

            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'bucket-order-input';
            input.value = BUCKETS[key].order;
            input.onchange = (e) => {
                BUCKETS[key].order = parseInt(e.target.value) || 0;
                saveBuckets(BUCKETS);
            };

            const nameLabel = document.createElement('span');
            nameLabel.style.flexGrow = '1';
            nameLabel.innerText = key;

            const exemptLabel = document.createElement('label');
            exemptLabel.style.fontSize = '11px';
            exemptLabel.style.display = 'flex';
            exemptLabel.style.alignItems = 'center';
            exemptLabel.style.gap = '4px';
            exemptLabel.style.cursor = 'pointer';
            exemptLabel.title = "Exempt from duration-based Shorts guessing (Treat all videos as standard)";

            const exemptCheck = document.createElement('input');
            exemptCheck.type = 'checkbox';
            exemptCheck.checked = BUCKETS[key].ignoreShortsTimer || false;
            exemptCheck.onchange = (e) => {
                BUCKETS[key].ignoreShortsTimer = e.target.checked;
                saveBuckets(BUCKETS);
            };

            exemptLabel.appendChild(exemptCheck);
            exemptLabel.appendChild(document.createTextNode('⏱️ Ignore Duration'));

            row.appendChild(input);
            row.appendChild(nameLabel);
            row.appendChild(exemptLabel);
            modal.appendChild(row);
        });

        const grid = document.createElement('div');
        grid.className = 'bucket-grid';

        const createBtn = document.createElement('div');
        createBtn.className = 'bucket-option';
        createBtn.style.gridColumn = 'span 2';
        createBtn.style.background = '#f1f1f1';
        createBtn.style.color = '#0f0f0f';
        createBtn.innerText = "+ Create New Category";

        createBtn.onclick = () => {
            const name = prompt("Name:");
            if (name && !BUCKETS[name]) {
                BUCKETS[name] = { channels:[], order: Object.keys(BUCKETS).length + 2, ignoreShortsTimer: false };
                saveBuckets(BUCKETS);
                openSettingsModal();
            }
        };

        grid.appendChild(createBtn);
        modal.appendChild(grid);

        const purgeGroup = document.createElement('div');
        purgeGroup.className = 'bucket-purge-group';

        const pt = document.createElement('div');
        pt.className = 'purge-btn purge-tags';
        pt.innerText = "Empty All Categories";
        pt.onclick = () => {
            if(confirm("Clear ALL tagged channels?")) {
                Object.keys(BUCKETS).forEach(k => BUCKETS[k].channels =[]);
                saveBuckets(BUCKETS);
                location.reload();
            }
        };

        const pc = document.createElement('div');
        pc.className = 'purge-btn purge-cats';
        pc.innerText = "Reset Everything";
        pc.onclick = () => {
            if(confirm("Delete ALL categories?")) {
                saveBuckets({});
                location.reload();
            }
        };

        purgeGroup.appendChild(pt);
        purgeGroup.appendChild(pc);
        modal.appendChild(purgeGroup);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'bucket-close';
        closeBtn.innerText = "Close & Apply";
        closeBtn.onclick = () => {
            overlay.remove();
            location.reload();
        };

        modal.appendChild(closeBtn);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    function openManagerModal(channelName) {
        const existing = document.querySelector('.bucket-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'bucket-modal-overlay';
        overlay.onclick = (e) => { if(e.target === overlay) overlay.remove(); };

        const modal = document.createElement('div');
        modal.className = 'bucket-modal';
        modal.innerHTML = `<h2 style="margin:0 0 15px 0;">Manage: ${channelName}</h2>`;

        const grid = document.createElement('div');
        grid.className = 'bucket-grid';

        Object.keys(BUCKETS).forEach(key => {
            const btn = document.createElement('div');
            btn.className = 'bucket-option';
            if (BUCKETS[key].channels.some(n => n.toLowerCase().trim() === channelName.toLowerCase().trim())) {
                btn.classList.add('selected');
            }
            btn.innerText = key;

            btn.onclick = () => {
                const isSelected = btn.classList.contains('selected');
                Object.keys(BUCKETS).forEach(k => {
                    BUCKETS[k].channels = BUCKETS[k].channels.filter(n => n.toLowerCase().trim() !== channelName.toLowerCase().trim());
                });

                if (!isSelected) {
                    BUCKETS[key].channels.push(channelName.trim());
                }
                saveBuckets(BUCKETS);
                applyChangesLive();
                openManagerModal(channelName);
            };
            grid.appendChild(btn);
        });

        const closeBtn = document.createElement('button');
        closeBtn.className = 'bucket-close';
        closeBtn.innerText = "Close";
        closeBtn.onclick = () => overlay.remove();

        modal.appendChild(grid);
        modal.appendChild(closeBtn);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    // =========================================================
    // 8. GLOBAL MONOLITH HEADER
    // =========================================================
    function injectDashboardHeader() {
        try {
            const isFeed = window.location.pathname.includes('/feed/subscriptions');
            if (document.getElementById('custom-unified-header')) return;

            const header = document.createElement('div');
            header.id = 'custom-unified-header';

            const logo = document.createElement('a');
            logo.href = "/feed/subscriptions";
            logo.className = 'custom-invidious-logo';
            logo.innerText = 'INVIDIOUS';
            header.appendChild(logo);

            const nativeForm = document.querySelector('form[action="/search"]');
            if (nativeForm) {
                header.appendChild(nativeForm);
            }

            const wrapper = document.createElement('div');
            wrapper.className = isFeed ? 'bucket-ui-wrapper' : 'bucket-ui-wrapper mini-wrapper';

            const statBtn = document.createElement('div');
            statBtn.className = 'bucket-btn action-btn';
            statBtn.innerHTML = '<i class="icon ion-md-stats" style="margin-right:6px;"></i>Tracker';
            statBtn.onclick = () => {
                const isOpen = document.body.classList.toggle('tracker-open');
                GM_setValue('bucket_tracker_open_gm', isOpen.toString());
            };

            const logBtn = document.createElement('div');
            logBtn.className = 'bucket-btn action-btn';
            logBtn.innerHTML = '<i class="icon ion-md-clipboard" style="margin-right:6px;"></i>Logs';
            logBtn.onclick = downloadLogs;

            const cog = document.createElement('div');
            cog.className = 'bucket-btn action-btn';
            cog.innerHTML = '<i class="icon ion-md-settings" style="margin-right:6px;"></i>Settings';
            cog.onclick = openSettingsModal;

            if (isFeed) {
                const lBtn = document.createElement('div');
                lBtn.className = 'bucket-nav-btn';
                lBtn.innerHTML = '<i class="icon ion-md-arrow-back"></i>';

                const rBtn = document.createElement('div');
                rBtn.className = 'bucket-nav-btn';
                rBtn.innerHTML = '<i class="icon ion-md-arrow-forward"></i>';

                const scroller = document.createElement('div');
                scroller.className = 'bucket-scroll-area';

                lBtn.onclick = () => { scroller.scrollLeft -= 300; };
                rBtn.onclick = () => { scroller.scrollLeft += 300; };

                wrapper.appendChild(lBtn);
                wrapper.appendChild(scroller);
                wrapper.appendChild(rBtn);
                wrapper.appendChild(statBtn);
                wrapper.appendChild(logBtn);
                wrapper.appendChild(cog);

                renderButtons(scroller);
            } else {
                const backBtn = document.createElement('div');
                backBtn.className = 'bucket-btn action-btn';
                backBtn.innerHTML = '<i class="icon ion-md-arrow-back" style="margin-right:6px;"></i>Dashboard';
                backBtn.onclick = () => { window.location.href = '/feed/subscriptions'; };

                wrapper.appendChild(backBtn);
                wrapper.appendChild(statBtn);
                wrapper.appendChild(logBtn);
                wrapper.appendChild(cog);
            }

            header.appendChild(wrapper);
            document.body.insertBefore(header, document.body.firstChild);
        } catch (e) {
            bLog("ERROR", "Renderer", "Error injecting Monolith Header", e);
        }
    }

    function renderButtons(container) {
        if (!container) return;
        container.innerHTML = '';

        createButton(container, 'ALL', () => { CURRENT_FILTER = 'ALL'; applyChangesLive(); });
        createButton(container, 'UNSORTED', () => { CURRENT_FILTER = 'UNSORTED'; applyChangesLive(); });

        const sorted = Object.keys(BUCKETS).sort((a,b) => BUCKETS[a].order - BUCKETS[b].order);
        sorted.forEach(key => createButton(container, key, () => { CURRENT_FILTER = key; applyChangesLive(); }));
    }

    function createButton(parent, text, onClick) {
        const btn = document.createElement('div');
        btn.innerText = text;
        btn.className = 'bucket-btn';
        if (text === CURRENT_FILTER) btn.classList.add('active');

        btn.onclick = (e) => {
            document.querySelectorAll('.bucket-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            sessionStorage.setItem('bucket_active_tab', text);
            onClick();
        };
        parent.appendChild(btn);
    }

    let isRightClickGestureActive = false;
    let hasScrolledSpeed = false;

    function setupGestures() {
        try {
            // Speed Gesture: Pointer Down/Up hooks
            window.addEventListener('pointerdown', (e) => {
                if (e.button === 2) {
                    isRightClickGestureActive = true;
                    hasScrolledSpeed = false;
                }
            }, true);

            window.addEventListener('pointerup', (e) => {
                if (e.button === 2) isRightClickGestureActive = false;
            }, true);

            window.addEventListener('contextmenu', (e) => {
                if (hasScrolledSpeed) {
                    e.preventDefault();
                    hasScrolledSpeed = false;
                }
            }, true);

            window.addEventListener('wheel', (e) => {
                // Right-Click + Scroll for Speed
                if (isRightClickGestureActive) {
                    const media = document.querySelector('video') || document.querySelector('audio');
                    if (media) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        hasScrolledSpeed = true;
                        let step = 0.25;
                        media.playbackRate = (e.deltaY < 0) ? Math.min(8, media.playbackRate + step) : Math.max(0.25, media.playbackRate - step);
                        showToast(`Speed: ${media.playbackRate.toFixed(2)}x`, 'info');
                    }
                    return;
                }

                // Shift + Scroll for Fast Pagination (Ignored on Subscriptions page)
                if (e.shiftKey) {
                    e.preventDefault();
                    if (window.location.pathname.includes('/feed/subscriptions')) return;

                    const direction = e.deltaY > 0 ? 'Next page' : 'Previous page';
                    const btn = Array.from(document.querySelectorAll('a.pure-button')).find(b => b.textContent.includes(direction));
                    if (btn) btn.click();
                }
            }, { passive: false });
        } catch (e) {
            bLog("ERROR", "Gestures", "Error setting up gestures", e);
        }
    }

    function setupInfiniteScrollHold() {
        let bottomHoldTimer = null;
        window.addEventListener('scroll', () => {
            if (window.location.pathname.includes('/feed/subscriptions') && CURRENT_FILTER === 'UNSORTED') {
                const scrollDist = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;

                if (scrollDist < 150) {
                    if (!bottomHoldTimer && !IS_FETCHING) {
                        bottomHoldTimer = setTimeout(() => {
                            if (CURRENT_FILTER === 'UNSORTED') {
                                TARGET_PAGES += 5;
                                bLog("INFO", "Scraper", `Bottom hold of 1.5s detected. Increased TARGET_PAGES to ${TARGET_PAGES}`);
                                fillBucket();
                            }
                            bottomHoldTimer = null;
                        }, 1500);
                    }
                } else {
                    if (bottomHoldTimer) {
                        clearTimeout(bottomHoldTimer);
                        bottomHoldTimer = null;
                    }
                }
            }
        });
    }

    // =========================================================
    // 9. TRANSCRIPT LOGIC
    // =========================================================
    function cleanVTT(rawText) {
        if (!rawText || rawText.trim().length === 0) return "";
        let text = rawText.replace(/WEBVTT[\s\S]*?\n\n/, '');

        const lines = text.split('\n');
        let cleanOutput =[];
        let lastText = "";
        let currentTimestamp = "";
        const timeRegex = /^(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d+)?/;

        lines.forEach(line => {
            line = line.trim();
            if (!line) return;
            if (line.includes('-->')) {
                const match = line.match(timeRegex);
                if (match) currentTimestamp = match[0].split('.')[0].split(',')[0];
                return;
            }

            let content = line.replace(/<[^>]+>/g, '').trim();
            if (content && content !== lastText) {
                let timeStr = currentTimestamp || "00:00";
                cleanOutput.push(`[${timeStr}] ${content}`);
                lastText = content;
            }
        });
        return cleanOutput.length > 0 ? cleanOutput.join('\n') : "";
    }

    function injectTranscriptButton() {
        try {
            if (!window.location.pathname.startsWith('/watch')) return;
            if (document.getElementById('tm-transcript-btn')) return;

            const captionsBtn = document.querySelector('#player .vjs-control-bar .vjs-captions-button');
            if (!captionsBtn || !captionsBtn.parentNode) return;

            const btn = document.createElement('button');
            btn.id = 'tm-transcript-btn';
            btn.className = 'vjs-control vjs-button';
            btn.type = 'button';
            btn.title = 'Copy Clean Transcript';
            btn.style.cssText = `width: 4em; cursor: pointer; font-family: "Roboto", "Arial", sans-serif !important; color: #f1f1f1 !important; display: flex; align-items: center; justify-content: center; order: -1;`;
            btn.innerHTML = '<i class="icon ion-md-document" style="font-size: 1.5em; line-height: 1;"></i>';

            captionsBtn.parentNode.insertBefore(btn, captionsBtn);

            btn.onclick = async () => {
                const videoID = new URLSearchParams(window.location.search).get('v');
                if (!videoID) return;

                const span = btn.querySelector('i');
                span.className = 'icon ion-md-hourglass';

                try {
                    bLog("INFO", "Transcript", `Fetching transcript for ${videoID}`);
                    const response = await fetch(`${API_URL}/get-transcript?v=${videoID}`);
                    const data = await response.json();

                    if (data.error) throw new Error(data.error);
                    if (!data.vtt_content) throw new Error("Bridge returned empty content.");

                    const finalCleanText = cleanVTT(data.vtt_content);
                    if (!finalCleanText) throw new Error("Cleaning resulted in empty text.");

                    await navigator.clipboard.writeText(finalCleanText);

                    span.className = 'icon ion-md-checkmark';
                    setTimeout(() => span.className = 'icon ion-md-document', 2000);
                    bLog("INFO", "Transcript", `Copied to clipboard successfully.`);
                } catch (e) {
                    bLog("ERROR", "Transcript", "Bridge Copy Error", e);
                    span.className = 'icon ion-md-close';
                    alert(`Error: ${e.message}`);
                }
            };
        } catch (e) {
            bLog("ERROR", "Transcript", "Error injecting transcript button", e);
        }
    }

    // =========================================================
    // 10. SPA AUDIO SHUFFLE ENGINE
    // =========================================================
    function initTrueShuffle() {
        try {
            const actionBtns = Array.from(document.querySelectorAll('a.pure-button')).filter(btn =>
                btn.textContent.includes('+ Add videos') ||
                btn.textContent.includes('Edit') ||
                btn.textContent.includes('Delete')
            );

            if (actionBtns.length > 0 && !document.getElementById('tm-audio-shuffle-btn')) {
                const targetBtn = actionBtns[0];
                const shuffleBtn = document.createElement('a');
                shuffleBtn.id = 'tm-audio-shuffle-btn';
                shuffleBtn.className = 'pure-button';
                shuffleBtn.style.cssText = 'background: #f1f1f1; color: #0f0f0f; font-weight: bold; margin-right: 5px; cursor: pointer; border: none;';
                shuffleBtn.innerHTML = '<i class="icon ion-md-musical-notes" style="margin-right:6px;"></i>Audio Shuffle';

                targetBtn.parentNode.insertBefore(shuffleBtn, targetBtn);

                shuffleBtn.onclick = (e) => {
                    e.preventDefault();
                    const videoLinks = Array.from(document.querySelectorAll('a[href^="/watch"]'));
                    let ids =[...new Set(videoLinks.map(a => new URL(a.href, window.location.origin).searchParams.get('v')).filter(Boolean))];

                    if (ids.length === 0) return alert("No videos found to shuffle!");

                    for (let i = ids.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [ids[i], ids[j]] = [ids[j], ids[i]];
                    }

                    sessionStorage.setItem('bucket_audio_original', JSON.stringify(ids));
                    let firstVideo = ids.shift();
                    sessionStorage.setItem('bucket_audio_pool', JSON.stringify(ids));

                    window.location.href = `/watch?v=${firstVideo}&audio_shuffle=true`;
                };
            }

            const isAudioActive = window.location.search.includes('audio_shuffle=true');
            if (window.location.pathname.startsWith('/watch') && isAudioActive) {
                const hijackPlayer = setInterval(() => {
                    const playerContainer = document.getElementById('player-container');

                    if (playerContainer) {
                        clearInterval(hijackPlayer);
                        bLog("INFO", "SPA_Audio", "Nuking native Video.js player and installing SPA Audio UI.");

                        playerContainer.innerHTML = `
                            <div id="custom-audio-ui" style="width: 100%; min-height: 75vh; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#0a0a0a; border-radius: 12px; padding: 20px; box-sizing: border-box; border: 1px solid #303030;">
                                <img id="ca-thumb" style="max-height: 40vh; max-width: 100%; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.8); transition: opacity 0.3s;" src="" />
                                <h2 id="ca-title" style="color:#f1f1f1; text-align:center; margin-bottom: 5px; font-weight: 500;">Loading Track...</h2>
                                <h4 id="ca-author" style="color:#aaa; text-align:center; margin-top: 0; margin-bottom: 30px; font-weight: normal;"></h4>
                                <audio id="ca-audio" controls autoplay style="width: 80%; max-width: 600px; outline: none;"></audio>
                                <div style="margin-top:30px; display:flex; gap:15px; align-items: center;">
                                    <button id="ca-transcript" class="bucket-btn action-btn"><i class="icon ion-md-document" style="margin-right:6px;"></i>Copy Transcript</button>
                                    <button id="ca-next" class="bucket-btn action-btn" style="background:#f1f1f1; color:#0f0f0f; border-color:#f1f1f1; font-weight:bold;"><i class="icon ion-md-skip-forward" style="margin-right:6px;"></i>Next Track</button>
                                    <button id="ca-stop" class="bucket-btn action-btn" style="background:#8b0000; border-color:#8b0000;"><i class="icon ion-md-close-circle" style="margin-right:6px;"></i>Stop</button>
                                </div>
                            </div>
                        `;

                        const related = document.getElementById('related');
                        if (related) related.style.display = 'none';
                        // Removed line that hid comments so comments render natively below player

                        const audioElem = document.getElementById('ca-audio');
                        const titleElem = document.getElementById('ca-title');
                        const authorElem = document.getElementById('ca-author');
                        const thumbElem = document.getElementById('ca-thumb');

                        // VOLUME MEMORY
                        const savedVol = GM_getValue('bucket_audio_volume_gm', 0.7);
                        audioElem.volume = parseFloat(savedVol);

                        audioElem.addEventListener('volumechange', () => {
                            GM_setValue('bucket_audio_volume_gm', audioElem.volume);
                        });

                        async function playTrack(videoId) {
                            try {
                                titleElem.innerText = "Fetching Track Data...";
                                thumbElem.style.opacity = '0.5';
                                history.pushState(null, '', `/watch?v=${videoId}&audio_shuffle=true`);

                                const res = await fetch(`${window.location.origin}/api/v1/videos/${videoId}`);
                                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                                const data = await res.json();

                                titleElem.innerText = data.title;
                                authorElem.innerText = data.author;
                                document.title = `🎵 ${data.title}`;

                                if (data.videoThumbnails && data.videoThumbnails.length > 0) {
                                    const bestThumb = data.videoThumbnails.find(t => t.quality === 'maxres') || data.videoThumbnails[data.videoThumbnails.length - 1];
                                    thumbElem.src = bestThumb.url.startsWith('/') ? window.location.origin + bestThumb.url : bestThumb.url;
                                    thumbElem.style.opacity = '1';
                                }

                                let audioFormat = null;
                                if (data.adaptiveFormats) {
                                    const audioStreams = data.adaptiveFormats.filter(f => f.type && f.type.startsWith('audio/'));
                                    audioFormat = audioStreams.find(f => f.type.includes('mp4')) || audioStreams[0];
                                }

                                if (!audioFormat && data.formatStreams) {
                                    audioFormat = data.formatStreams.find(f => !f.resolution) || data.formatStreams[0];
                                }

                                if (audioFormat && audioFormat.url) {
                                    let finalAudioUrl = audioFormat.url.startsWith('/') ? window.location.origin + audioFormat.url : audioFormat.url;
                                    audioElem.src = finalAudioUrl;

                                    // Memory & Tab Sync for SPA
                                    setupProgressMemory(audioElem, videoId);
                                    setupTabSync(audioElem);

                                    audioElem.play().catch(e => bLog("WARN", "SPA_Audio", "Autoplay prevented", e));
                                } else {
                                    titleElem.innerText = "Error: No Audio Stream Found";
                                    setTimeout(playNextTrack, 3000);
                                }
                            } catch (err) {
                                bLog("ERROR", "SPA_Audio", `Fetch Error for ${videoId}`, err);
                                titleElem.innerText = "Network Error - Skipping...";
                                setTimeout(playNextTrack, 3000);
                            }
                        }

                        function playNextTrack() {
                            let pool = JSON.parse(sessionStorage.getItem('bucket_audio_pool') || '[]');
                            let original = JSON.parse(sessionStorage.getItem('bucket_audio_original') || '[]');

                            if (pool.length === 0) {
                                pool = [...original];
                                for (let i = pool.length - 1; i > 0; i--) {
                                    const j = Math.floor(Math.random() * (i + 1));
                                    [pool[i], pool[j]] = [pool[j], pool[i]];
                                }
                                const currentV = new URLSearchParams(window.location.search).get('v');
                                if(pool[0] === currentV) pool.push(pool.shift());
                            }

                            if (pool.length > 0) {
                                let nextId = pool.shift();
                                sessionStorage.setItem('bucket_audio_pool', JSON.stringify(pool));
                                playTrack(nextId);
                            }
                        }

                        audioElem.addEventListener('ended', playNextTrack);
                        audioElem.addEventListener('error', () => {
                            bLog("WARN", "SPA_Audio", "Audio stream error");
                            playNextTrack();
                        });

                        document.getElementById('ca-next').onclick = playNextTrack;

                        document.getElementById('ca-stop').onclick = () => {
                            sessionStorage.removeItem('bucket_audio_pool');
                            sessionStorage.removeItem('bucket_audio_original');
                            window.location.href = '/feed/playlists';
                        };

                        document.getElementById('ca-transcript').onclick = async (e) => {
                            const btn = e.currentTarget;
                            const originalText = btn.innerHTML;
                            btn.innerHTML = '<i class="icon ion-md-hourglass" style="margin-right:6px;"></i>Fetching...';

                            const videoID = new URLSearchParams(window.location.search).get('v');
                            try {
                                const response = await fetch(`${API_URL}/get-transcript?v=${videoID}`);
                                const data = await response.json();

                                if (data.error) throw new Error(data.error);
                                await navigator.clipboard.writeText(cleanVTT(data.vtt_content));

                                btn.innerHTML = '<i class="icon ion-md-checkmark" style="margin-right:6px;"></i>Copied!';
                                setTimeout(() => btn.innerHTML = originalText, 2000);
                            } catch (err) {
                                alert("Transcript error: " + err.message);
                                btn.innerHTML = originalText;
                            }
                        };

                        const initialId = new URLSearchParams(window.location.search).get('v');
                        if (initialId) playTrack(initialId);
                    }
                }, 100);
            }
        } catch (e) {
            bLog("ERROR", "SPA_Audio", "Error initializing True Shuffle", e);
        }
    }

    // =========================================================
    // 11. INIT BOOTSTRAPPER
    // =========================================================
    function init() {
        try {
            extractUserData();
            hideNativeHeaderJunk();
            setupGestures();
            setupInfiniteScrollHold();
            loadBuckets();
            initTrueShuffle();
            injectDashboardHeader();

            if (window.location.pathname.includes('/feed/subscriptions')) {
                setInterval(() => {
                    // THROTTLE: Only update Live DOM if the tab is actively being viewed
                    if (document.visibilityState === 'visible') {
                        applyChangesLive();
                    }
                }, 1000);
            } else {
                if (window.location.pathname.startsWith('/watch')) {
                    optimizePlayback();
                    injectTranscriptButton();

                    // If it's a standard video watch page (not SPA Audio), hook the native video player
                    const isAudioActive = window.location.search.includes('audio_shuffle=true');
                    if (!isAudioActive) {
                        const initStandardVideoHooks = setInterval(() => {
                            const video = document.querySelector('video');
                            const videoId = new URLSearchParams(window.location.search).get('v');
                            if (video && videoId) {
                                clearInterval(initStandardVideoHooks);
                                setupTabSync(video);
                                setupProgressMemory(video, videoId);

                                if (video.readyState >= 1) handleAutoSpeed(video);
                                else video.addEventListener('loadedmetadata', () => handleAutoSpeed(video), {once: true});
                            }
                        }, 500);
                    }
                }
            }
        } catch (e) {
            bLog("ERROR", "System", "Fatal error during init", e);
        }
    }

    init();
})();