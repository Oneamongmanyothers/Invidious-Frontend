// ==UserScript==
// @name         (Stable) complete Invidious: Context Buckets + RTX VSR + Transcript Bridge + Proton Cloud Sync
// @namespace    http://tampermonkey.net/
// @version      50.1
// @description  Full Dashboard Migration: Flawless Navigation, Cookie Toggling, Dark Tables, True Centering, and SPA Audio Shuffle Engine (Tab Isolated).
// @author       You
// @match        *://127.0.0.1:3000/*
// @icon         http://127.0.0.1:5001/icon.png
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // --- PORT GUARD: Prevent kidnapping Sonarr/Prowlarr ---
    if (window.location.port !== '3000') {
        console.log("[Bucket] Wrong port detected. Script standing down.");
        return;
    }

    // --- ENFORCE CHRONOLOGICAL ANCHOR ---
    if (window.location.pathname === '/feed/subscriptions' && window.location.search.includes('page=')) {
        window.location.replace('/feed/subscriptions');
        return;
    }

    if (!localStorage.getItem('v41_4_cache_wipe')) {
        localStorage.removeItem('bucket_channel_cache');
        localStorage.setItem('v41_4_cache_wipe', 'true');
    }

    const API_URL = 'http://127.0.0.1:5001';
    let CURRENT_FILTER = sessionStorage.getItem('bucket_active_tab') || 'ALL';
    let BUCKETS = {};

    // State Memory
    let CURRENT_PAGE = 1;
    let IS_FETCHING = false;
    let TARGET_PAGES = 5;
    let LAST_ACTIVE_FILTER = null;
    let SCRAPE_COUNTER = 0;
    let MISSING_CHANNELS_NAMES =[];
    let NEXT_PAGE_URL_CACHE = null;
    let ACTIVE_FETCHES = new Set();
    let COMPLETED_FETCHES = new Set();

    // User Data Memory
    let IS_LOGGED_IN = false;
    let USER_NAME = "Guest";
    let NOTIF_COUNT = "0 unseen notifications";

    let CHANNEL_CACHE = JSON.parse(localStorage.getItem('bucket_channel_cache') || '{}');

    // Sidebar preference
    if (localStorage.getItem('bucket_tracker_open') !== 'false') {
        document.body.classList.add('tracker-open');
    }

    function updateCache(name, url) {
        if (!name || !url) return;
        let cleanName = name.trim();
        if (CHANNEL_CACHE[cleanName] !== url) {
            CHANNEL_CACHE[cleanName] = url;
            localStorage.setItem('bucket_channel_cache', JSON.stringify(CHANNEL_CACHE));
        }
    }

    // --- 0. BULLETPROOF DATA SCRAPER & CLUTTER REMOVAL ---
    function extractUserData() {
        try {
            // Filter out our injected panels to ensure we only read native Invidious elements
            let allNativeLinks = Array.from(document.querySelectorAll('a')).filter(a => !a.closest('#bucket-debug-panel') && !a.closest('#custom-unified-header'));
            let allForms = Array.from(document.querySelectorAll('form'));

            // Check literal string paths to completely bypass CSS selector quirks.
            // NOW SUPPORTS BOTH "/logout" AND "/signout" based on instance variants.
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

                // Sanity check incase it captured a menu icon instead of the username
                if (!USER_NAME || USER_NAME.toLowerCase() === "guest" || USER_NAME.toLowerCase() === "preferences" || USER_NAME === "⚙") {
                    USER_NAME = "User";
                }
            } else {
                let aLogin = allNativeLinks.find(a => a.href && a.href.toLowerCase().includes('login'));
                if (aLogin) {
                    IS_LOGGED_IN = false;
                    USER_NAME = "Guest";
                } else {
                    // Absolute Final Fallback: Check raw DOM HTML for any presence of a logout/signout string
                    let htmlStr = document.documentElement.innerHTML.toLowerCase();
                    IS_LOGGED_IN = htmlStr.includes('logout') || htmlStr.includes('signout');
                    USER_NAME = IS_LOGGED_IN ? "User" : "Guest";
                }
            }

            // Scrape Notification Count
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let node;
            while ((node = walker.nextNode())) {
                if (node.nodeValue.includes('unseen notifications')) {
                    NOTIF_COUNT = node.nodeValue.trim();
                    break;
                }
            }
        } catch (e) {
            console.error("[Bucket] Error in extractUserData:", e);
        }
    }

    function hideNativeHeaderJunk() {
        try {
            // Prevent destructive JS node hiding on the Preferences page
            if (window.location.pathname.includes('/preferences')) return;

            // Nuke the native sub-navigation menu (Popular, Trending, etc.)
            const popLink = document.querySelector('a[href="/feed/popular"]:not(.sidebar-nav-link)');
            if (popLink) {
                let container = popLink.closest('.pure-menu') || popLink.closest('.h-box') || popLink.parentElement;
                if (container) container.style.display = 'none';
            }

            // Nuke watch history / subscription manager links
            const histLink = document.querySelector('a[href="/feed/history"]:not(.sidebar-nav-link)');
            if (histLink) {
                let container = histLink.closest('.pure-g') || histLink.parentElement;
                if (container) container.style.display = 'none';
            }

            // Nuke unseen notifications floating text completely
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
            console.error("[Bucket] Error in hideNativeHeaderJunk:", e);
        }
    }

    // --- 1. CLOUD STORAGE LOGIC ---
    async function loadBuckets() {
        try {
            const response = await fetch(`${API_URL}/get-buckets`);
            const data = await response.json();

            let seenChannels = new Set();
            Object.keys(data).forEach(key => {
                if (Array.isArray(data[key])) data[key] = { channels: data[key], order: 0 };
                if (!data[key].channels) data[key].channels = [];
                if (typeof data[key].order !== 'number') data[key].order = 0;

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

            if (window.location.pathname.includes('/feed/subscriptions')) {
                applyChangesLive();
            } else {
                updateStatsPanel([]);
            }
        } catch (e) {
            console.error("[Bucket] Could not connect to Python Bridge:", e);
        }
    }

    async function saveBuckets(data) {
        try {
            await fetch(`${API_URL}/save-buckets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } catch (e) {
            console.error("[Bucket] Failed to save to Python Bridge:", e);
        }
    }

    // --- 2. DOM HELPERS ---
    function getVideoGrid() {
        const grids = Array.from(document.querySelectorAll('.pure-g'));
        let bestGrid = null;
        let maxDirectVideos = -1;

        grids.forEach(g => {
            if (g.classList.contains('navbar') || g.classList.contains('h-box') || g.closest('#custom-unified-header')) return;
            let count = 0;
            Array.from(g.children).forEach(child => {
                if (child.querySelector('a[href^="/watch"]')) count++;
            });
            if (count > maxDirectVideos) {
                maxDirectVideos = count;
                bestGrid = g;
            }
        });

        if (!bestGrid || maxDirectVideos === 0) {
             const contentGrid = document.querySelector('#contents .pure-g:not(.navbar)') ||
                                 document.querySelector('[class*="pure-u-md-"] > .pure-g:not(.navbar)');
             if (contentGrid && !contentGrid.closest('#custom-unified-header')) return contentGrid;
        }
        return bestGrid;
    }

    function getSafeCards() {
        const cards = new Set();
        const grid = getVideoGrid();
        if (!grid) return[];

        const elements = grid.children;
        Array.from(elements).forEach(card => {
            if (!card.querySelector('.navbar') && card.querySelector('a[href^="/watch"]')) {
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

    // --- 3. VSR OPTIMIZATION ---
    function optimizePlayback() {
        try {
            const video = document.querySelector('video');
            if (!video) return;
            if (video.style.transform !== 'translateZ(0px)') video.style.transform = 'translateZ(0px)';
            if (video.style.imageRendering !== 'auto') video.style.imageRendering = 'auto';
            if (video.style.filter !== 'none') video.style.filter = 'none';
            if (video.style.mask !== 'none') video.style.mask = 'none';

            const playerContainer = document.querySelector('#player-container');
            if (playerContainer) {
                if (playerContainer.style.maxWidth !== '100%') {
                    playerContainer.style.width = '100%';
                    playerContainer.style.maxWidth = '100%';
                    playerContainer.style.minHeight = '75vh';
                }
            }
        } catch (e) {
            console.error("[Bucket] Error in optimizePlayback:", e);
        }
    }

    // --- 4. DIRECT TARGET SCRAPING ---
    async function targetedFetch(channelName) {
        ACTIVE_FETCHES.add(channelName);
        try {
            let channelUrl = CHANNEL_CACHE[channelName];

            if (!channelUrl) {
                const searchRes = await fetch(window.location.origin + `/search?q=${encodeURIComponent(channelName)}`);
                const searchHtml = await searchRes.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(searchHtml, 'text/html');

                const links = Array.from(doc.querySelectorAll('a[href^="/channel/"]'));
                let match = links.find(l => getCleanName(l).toLowerCase() === channelName.toLowerCase());
                if (!match) match = links.find(l => getCleanName(l).toLowerCase().startsWith(channelName.toLowerCase()));
                if (!match) match = links.find(l => getCleanName(l).toLowerCase().includes(channelName.toLowerCase()));

                if (match) {
                    channelUrl = match.getAttribute('href');
                    updateCache(channelName, channelUrl);
                }
            }

            if (channelUrl) {
                const absoluteUrl = new URL(channelUrl, window.location.origin).href;
                const chRes = await fetch(absoluteUrl);
                const chHtml = await chRes.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(chHtml, 'text/html');

                let items = doc.querySelectorAll('#contents > .pure-g > [class*="pure-u-"]');
                if (items.length === 0) items = doc.querySelectorAll('.pure-g >[class*="pure-u-"]');

                let firstVideo = null;
                for (let item of items) {
                     let watchLink = item.querySelector('a[href^="/watch"]');
                     if (watchLink && !item.querySelector('.navbar')) {
                         firstVideo = item;
                         break;
                     }
                }

                if (firstVideo) {
                    firstVideo.setAttribute('data-target-channel', channelName);

                    let chLink = firstVideo.querySelector('a[href^="/channel/"]');
                    if (!chLink) {
                         let a = document.createElement('a');
                         a.href = channelUrl;
                         a.textContent = channelName;
                         a.style.display = 'none';
                         firstVideo.appendChild(a);
                    }

                    const watchHref = firstVideo.querySelector('a[href^="/watch"]').getAttribute('href');
                    const videoID = watchHref.split('v=')[1]?.split('&')[0];

                    if (!document.querySelector(`a[href*="v=${videoID}"]`)) {
                        firstVideo.setAttribute('data-scrape-index', SCRAPE_COUNTER++);

                        const mainGrid = getVideoGrid();
                        const insertionPoint = document.querySelector('.page-nav-container') || document.querySelector('.h-box:has(.pure-button)');
                        if (insertionPoint && insertionPoint.parentNode === mainGrid) {
                            mainGrid.insertBefore(firstVideo, insertionPoint);
                        } else {
                            mainGrid.appendChild(firstVideo);
                        }
                    }
                }
            }
        } catch (err) {
            console.error("[Bucket] Targeted Fetch Error for", channelName, err);
        } finally {
            ACTIVE_FETCHES.delete(channelName);
            COMPLETED_FETCHES.add(channelName);
        }
    }

    async function fillBucket() {
        if (!window.location.pathname.includes('/feed/subscriptions')) return;
        if (IS_FETCHING) return;

        try {
            if (CURRENT_FILTER === 'ALL' || CURRENT_FILTER === 'UNSORTED') {
                if (!NEXT_PAGE_URL_CACHE) NEXT_PAGE_URL_CACHE = extractNextPageUrl(document);

                const scrollDist = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
                const nearBottom = scrollDist < 1500;
                const shouldFetch = nearBottom && CURRENT_PAGE < TARGET_PAGES;

                if (shouldFetch && NEXT_PAGE_URL_CACHE) {
                    IS_FETCHING = true;
                    CURRENT_PAGE++;

                    try {
                        const absoluteNext = new URL(NEXT_PAGE_URL_CACHE, window.location.origin).href;
                        const response = await fetch(absoluteNext, { credentials: 'same-origin' });
                        const html = await response.text();
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');

                        NEXT_PAGE_URL_CACHE = extractNextPageUrl(doc);

                        let incomingItems = doc.querySelectorAll('#contents > .pure-g >[class*="pure-u-"]');
                        if (incomingItems.length === 0) incomingItems = doc.querySelectorAll('.pure-g >[class*="pure-u-"]');

                        const mainGrid = getVideoGrid();
                        const insertionPoint = document.querySelector('.page-nav-container') || document.querySelector('.h-box:has(.pure-button)');

                        if (incomingItems.length > 0) {
                            incomingItems.forEach(item => {
                                const watchLink = item.querySelector('a[href^="/watch"]');
                                if (watchLink && !item.querySelector('.navbar') && !item.innerText.includes('Next page')) {
                                    const videoID = watchLink.getAttribute('href').split('v=')[1]?.split('&')[0];
                                    const exists = document.querySelector(`a[href*="v=${videoID}"]`);
                                    if (!exists) {
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
                        console.error("[Bucket] Error inside fillBucket ALL fetch:", err);
                    }
                }
            } else {
                let toFetch = MISSING_CHANNELS_NAMES.filter(ch => !ACTIVE_FETCHES.has(ch) && !COMPLETED_FETCHES.has(ch));
                if (toFetch.length > 0) {
                    IS_FETCHING = true;
                    await Promise.all(toFetch.map(ch => targetedFetch(ch)));
                    IS_FETCHING = false;
                    applyChangesLive();
                }
            }
        } catch (e) {
            console.error("[Bucket] Error in fillBucket:", e);
            IS_FETCHING = false;
        }
    }

    // --- 5. GLOBAL YOUTUBE DARK UI STYLING ---
    const cssId = 'bucket-styles-v43-3';
    if (!document.getElementById(cssId)) {
        const style = document.createElement('style');
        style.id = cssId;
        style.innerHTML = `
            /* ========================================================= */
            /* YOUTUBE DARK MODE OVERRIDES */
            /* ========================================================= */
            body, html, #contents {
                background-color: #0f0f0f !important;
                color: #f1f1f1 !important;
                font-family: "Roboto", "Arial", sans-serif !important;
                font-size: 14px !important;
            }

            p[dir="auto"], h5[dir="auto"], p, h5, .video-card-row { font-family: "Roboto", "Arial", sans-serif !important; }
            p[dir="auto"] { font-weight: 500 !important; font-size: 15px !important; color: #f1f1f1 !important; margin-top: 10px !important; margin-bottom: 4px !important; line-height: 1.4 !important; }
            h5[dir="auto"] a, .video-data { font-weight: normal !important; color: #aaa !important; font-size: 13px !important; text-decoration: none !important; }

            .thumbnail, .thumbnail img, .thumbnail video { border-radius: 12px !important; overflow: hidden !important; background: transparent !important; border: none !important; box-shadow: none !important; object-fit: cover !important; }
            .video-card-row { border: none !important; box-shadow: none !important; }

            /* ========================================================= */
            /* THE TRUE MONOLITH HEADER (Replaces Native Navbar globally) */
            /* ========================================================= */
            .navbar { display: none !important; }

            #custom-unified-header {
                display: flex;
                flex-direction: column;
                align-items: center;
                width: 100%;
                margin-bottom: 15px;
                padding-top: 15px;
                background-color: #0f0f0f;
            }
            .custom-invidious-logo {
                font-size: 24px;
                font-weight: bold;
                color: #f1f1f1 !important;
                letter-spacing: 2px;
                margin-bottom: 10px;
                text-decoration: none !important;
            }
            #custom-unified-header form[action="/search"] {
                width: 100%;
                max-width: 650px;
                margin: 0 auto 10px auto !important;
                display: flex;
                /* NO TRANSLATEX OVERRIDES. Pure visual centering inside flexbox. */
                transform: none !important;
                left: auto !important;
                top: auto !important;
            }

            form[action="/search"] fieldset { display: flex !important; width: 100% !important; border: none !important; padding: 0 !important; margin: 0 !important; }
            form[action="/search"] input[name="q"], form[action="/search"] input[type="search"] {
                flex-grow: 1 !important;
                background-color: #121212 !important;
                border: 1px solid #303030 !important;
                border-radius: 40px 0 0 40px !important;
                color: #f1f1f1 !important;
                padding: 10px 24px !important;
                font-size: 16px !important;
                outline: none !important;
                box-shadow: inset 0 1px 2px rgba(0,0,0,0.3) !important;
                margin: 0 !important;
                height: 44px !important;
                box-sizing: border-box !important;
            }
            form[action="/search"] input[name="q"]:focus { border-color: #f1f1f1 !important; }
            form[action="/search"] button[type="submit"], form[action="/search"] button {
                background-color: #222222 !important;
                border: 1px solid #303030 !important;
                border-left: none !important;
                border-radius: 0 40px 40px 0 !important;
                padding: 0 24px !important;
                color: #f1f1f1 !important;
                cursor: pointer !important;
                margin: 0 !important;
                height: 44px !important;
                box-sizing: border-box !important;
            }
            form[action="/search"] button:hover { background-color: #303030 !important; color: #fff !important; }

            /* ========================================================= */
            /* NUCLEAR TABLE OVERRIDES (Fixing Red Subscription Rows) */
            /* ========================================================= */
            table, .pure-table { background-color: #0f0f0f !important; color: #f1f1f1 !important; border: none !important; width: 100% !important; }
            .pure-table th, .pure-table td { border-bottom: 1px solid #303030 !important; border-left: none !important; border-right: none !important; }
            .pure-table thead { background-color: #1a1a1a !important; color: #aaa !important; }
            /* Destroy ALL inline styles injected by Invidious natively */
            .pure-table tbody tr, .pure-table tbody tr[style] { background-color: #0f0f0f !important; color: #f1f1f1 !important; }
            .pure-table tbody tr:nth-child(even), .pure-table tbody tr:nth-child(even)[style] { background-color: #121212 !important; color: #f1f1f1 !important; }
            .pure-table a { color: #00bfff !important; text-decoration: none !important; }
            .pure-table a:hover { color: #f1f1f1 !important; }

            /* ========================================================= */
            /* TRACKER UI & LAYOUT ENGINE */
            /* ========================================================= */
            .bucket-hidden { display: none !important; }
            body.bucket-active-page.feed-view footer,
            body.bucket-active-page.feed-view .footer { display: none !important; }
            body.bucket-active-page.feed-view .page-nav-container { display: none !important; }
            body.bucket-active-page.feed-view .h-box > .pure-button-group { display: none !important; }

            body { transition: margin-left 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
            body.tracker-open { margin-left: 320px !important; }

            .bucket-ui-wrapper {
                display: flex;
                align-items: center;
                background: #0f0f0f;
                border-bottom: 1px solid #303030;
                border-top: 1px solid #303030;
                padding: 10px 16px;
                gap: 8px;
                width: 100%;
                box-sizing: border-box;
            }
            /* Centered Mini-bar for non-feed pages (History, Playlists, etc) */
            .bucket-ui-wrapper.mini-wrapper {
                justify-content: center !important;
                border-top: none !important;
            }

            .bucket-scroll-area { display: flex; flex-grow: 1; overflow: hidden; scroll-behavior: smooth; gap: 8px; white-space: nowrap; padding: 2px 0; }
            .bucket-nav-btn { background: #222; color: #f1f1f1; border: 1px solid #303030; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; user-select: none; flex-shrink: 0; font-weight: bold; }
            .bucket-btn { flex-shrink: 0; background: #222; color: #f1f1f1; border: 1px solid #303030; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: 0.2s; max-width: 300px; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center;}
            .bucket-btn.active { background: #f1f1f1; color: #0f0f0f; border-color: #f1f1f1; font-weight: bold; }
            .bucket-btn.action-btn { background: #272727; color: #f1f1f1; border-color: #303030; }
            .bucket-btn.action-btn:hover { background: #3f3f3f; }

            /* PERFECT FONT LEVELING FOR TAGS (Monochrome styling) */
            .bucket-tag { font-size: 11px; background: #272727; color: #f1f1f1; padding: 4px 8px; border-radius: 4px; border: 1px solid #444; display: flex; align-items: center; font-weight: 600; letter-spacing: 0.5px; white-space: nowrap; line-height: 1; }
            .bucket-add-btn { display: flex; align-items: center; color: #aaa; cursor: pointer; font-weight: bold; font-size: 18px; line-height: 1; padding: 0 4px; transition: 0.2s; }
            .bucket-add-btn:hover { color: #f1f1f1; transform: scale(1.2); }

            /* REMOVE ALL VIDEO CARD ICON CLUTTER (Indestructible) */
            .video-card-row a[href^="https://youtube.com"],
            .video-card-row a[title*="YouTube" i],
            .video-card-row a[title*="Listen" i],
            .video-card-row a[title*="Audio" i],
            .video-card-row a[title*="Switch" i],
            .video-card-row a[title*="instance" i],
            .video-card-row i[class*="ion-"],
            .video-card-row .icon {
                display: none !important;
            }

            /* The Persistent Monochrome Sidebar */
            #bucket-debug-panel {
                position: fixed;
                top: 0;
                left: -320px;
                width: 320px;
                height: 100vh;
                background: #0f0f0f;
                border-right: 1px solid #303030;
                z-index: 9999;
                padding: 20px;
                box-sizing: border-box;
                overflow-y: auto;
                transition: left 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }
            body.tracker-open #bucket-debug-panel { left: 0; }

            .sidebar-badge {
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: transparent;
                border: none;
                padding: 10px 12px;
                border-radius: 8px;
                color: #f1f1f1;
                font-weight: 500;
                font-size: 14px;
                transition: 0.2s;
            }
            .sidebar-badge.found-badge { cursor: pointer; }
            .sidebar-badge.found-badge:hover, .sidebar-nav-link:hover { background: #272727; transform: translateX(3px); }

            .channel-link-icon { margin-left: 10px; text-decoration: none; color:#f1f1f1; transition: 0.2s; font-size: 16px;}
            .channel-link-icon:hover { transform: scale(1.2); text-shadow: 0 0 4px #fff; }

            /* Soft White Neon Pulse Animation */
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

    // --- 6. REACTIVE ENGINE ---
    function applyChangesLive() {
        try {
            const isSubscriptionFeed = window.location.pathname.includes('/feed/subscriptions');

            document.body.classList.add('bucket-active-page');
            if (isSubscriptionFeed) document.body.classList.add('feed-view');
            else document.body.classList.remove('feed-view');

            const cards = getSafeCards();
            let groupedChannels = {};

            if (CURRENT_FILTER !== LAST_ACTIVE_FILTER) {
                LAST_ACTIVE_FILTER = CURRENT_FILTER;
                COMPLETED_FETCHES.clear();
            }

            cards.forEach(card => {
                // Icon Eradication
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

                let link = card.querySelector('a[href^="/channel/"]');
                let channelName = card.getAttribute('data-target-channel');
                if (!channelName && link) {
                    channelName = getCleanName(link);
                }

                if (!channelName) return;

                if (link && !card.getAttribute('data-target-channel')) {
                    updateCache(channelName, link.getAttribute('href'));
                }

                const assignedBucket = getBucketForChannel(channelName);

                card.setAttribute('data-bucket-category', assignedBucket || 'Unsorted');
                if (link) updateTagInDOM(link, assignedBucket);

                if (isSubscriptionFeed) {
                    let isAllowed = false;
                    if (CURRENT_FILTER === 'ALL') isAllowed = true;
                    else if (CURRENT_FILTER === 'UNSORTED') isAllowed = (assignedBucket === null || assignedBucket === 'Unsorted');
                    else isAllowed = (assignedBucket === CURRENT_FILTER);

                    if (isAllowed) {
                        if (!groupedChannels[channelName]) groupedChannels[channelName] = [];
                        groupedChannels[channelName].push(card);
                    }
                }
            });

            if (isSubscriptionFeed) {
                let displayList =[];

                if (CURRENT_FILTER === 'ALL' || CURRENT_FILTER === 'UNSORTED') {
                    MISSING_CHANNELS_NAMES = [];
                    let allowedFound =[];
                    for (const channel in groupedChannels) {
                        groupedChannels[channel].sort((a,b) => parseInt(a.getAttribute('data-scrape-index')) - parseInt(b.getAttribute('data-scrape-index')));
                        allowedFound.push(groupedChannels[channel][0]);
                    }
                    allowedFound.sort((a,b) => parseInt(a.getAttribute('data-scrape-index')) - parseInt(b.getAttribute('data-scrape-index')));
                    displayList = allowedFound;
                } else {
                    const expectedChannels = BUCKETS[CURRENT_FILTER]?.channels || [];
                    let missing = [];
                    let allowedFound =[];

                    expectedChannels.forEach(ch => {
                        let chKey = Object.keys(groupedChannels).find(gc => gc.toLowerCase().trim() === ch.toLowerCase().trim());
                        if (chKey && groupedChannels[chKey].length > 0) {
                            groupedChannels[chKey].sort((a,b) => parseInt(a.getAttribute('data-scrape-index')) - parseInt(b.getAttribute('data-scrape-index')));
                            allowedFound.push({ card: groupedChannels[chKey][0], name: chKey });
                        } else {
                            missing.push(ch);
                        }
                    });

                    MISSING_CHANNELS_NAMES = missing;
                    allowedFound.sort((a,b) => a.name.localeCompare(b.name));
                    displayList = allowedFound.map(item => item.card);
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

                updateStatsPanel(displayList);
            }

            const scroller = document.querySelector('.bucket-scroll-area');
            if (scroller) renderButtons(scroller);
            if (isSubscriptionFeed) fillBucket();
        } catch (e) {
            console.error("[Bucket] Error in applyChangesLive:", e);
        }
    }

    // --- 6.5. PURE MONOCHROME DASHBOARD (Ionicons Only) ---
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
                        <i class="icon ion-md-funnel" style="margin-right:6px;"></i>Total Found: ${displayList.length} / ${totalAllowed}
                    </div>
                `;

                if (CURRENT_FILTER !== 'ALL' && CURRENT_FILTER !== 'UNSORTED') {
                    let currentlyFetching = MISSING_CHANNELS_NAMES.filter(ch => ACTIVE_FETCHES.has(ch));
                    let failedToFind = MISSING_CHANNELS_NAMES.filter(ch => COMPLETED_FETCHES.has(ch));

                    if (currentlyFetching.length > 0) {
                        headerStatus += `<div class="missing-alert"><i class="icon ion-md-search" style="margin-right:4px;"></i> Targeting ${currentlyFetching.length} MIA...</div>`;
                    } else if (failedToFind.length > 0) {
                        headerStatus += `<div class="missing-alert"><i class="icon ion-md-alert" style="margin-right:4px;"></i> MIA CHECKED - No Recent</div>`;
                    }
                } else {
                    if (IS_FETCHING) headerStatus += `<div class="missing-alert"><i class="icon ion-md-sync" style="margin-right:4px;"></i> Fetching Timeline...</div>`;
                }

                feedSpecificHtml += headerStatus;
                feedSpecificHtml += `<div style="display:flex; flex-direction:column; gap:4px; margin-top: 15px;">`;

                let foundNames = new Set();
                displayList.forEach(card => {
                    const link = card.querySelector('a[href^="/channel/"]');
                    let name = card.getAttribute('data-target-channel') || (link ? getCleanName(link) : 'Unknown');
                    foundNames.add(name.toLowerCase().trim());

                    let channelUrl = CHANNEL_CACHE[name.trim()] || (link ? link.getAttribute('href') : '#');
                    let safeName = name.replace(/"/g, '&quot;');

                    feedSpecificHtml += `<div class="sidebar-badge found-badge" data-scroll-target="${safeName}" title="Scroll to ${name}'s Video">
                                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:80%; color:#f1f1f1;">${name}</span>
                                <a href="${channelUrl}" target="_blank" class="channel-link-icon" title="Open Channel Page in New Tab"><i class="icon ion-md-open"></i></a>
                             </div>`;
                });

                if (CURRENT_FILTER !== 'ALL' && CURRENT_FILTER !== 'UNSORTED') {
                    const expectedChannels = BUCKETS[CURRENT_FILTER]?.channels ||[];
                    expectedChannels.forEach(ch => {
                        let cleanCh = ch.toLowerCase().trim();
                        if (!foundNames.has(cleanCh) && COMPLETED_FETCHES.has(ch)) {
                            feedSpecificHtml += `<div class="sidebar-badge" style="color:#f1f1f1; border: 1px solid #444; background: #1a1a1a; cursor:default; opacity:0.7;">
                                        <span><i class="icon ion-md-close-circle" style="margin-right:5px; color:#f1f1f1;"></i>${ch} (MIA)</span>
                                     </div>`;
                        }
                    });
                }
                feedSpecificHtml += `</div>`;
            }

            // Dynamically apply correct Icon and Tooltip based on global state
            let authIcon = IS_LOGGED_IN ? "ion-md-log-out" : "ion-md-log-in";
            let authTitle = IS_LOGGED_IN ? "Log Out" : "Log In";

            let html = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; border-bottom: 1px solid #303030; padding-bottom: 15px;">
                    <h2 style="margin:0; color:#f1f1f1; font-size:18px; text-transform:uppercase; font-weight: 500;">DASHBOARD</h2>
                    <div style="cursor:pointer; font-size:24px; color:#f1f1f1; line-height:1;" title="Close Sidebar" onclick="document.body.classList.remove('tracker-open'); localStorage.setItem('bucket_tracker_open', 'false');"><i class="icon ion-md-close"></i></div>
                </div>

                <!-- USER ACCOUNT HUB (Monochrome Ionicons + Event Handlers) -->
                <div style="display:flex; justify-content:space-between; align-items:center; background:#272727; border: 1px solid #444; padding:12px 15px; border-radius:8px; margin-bottom:15px;">
                    <div style="font-weight:bold; color:#f1f1f1; font-size:14px; text-transform:uppercase;">
                        <i class="icon ion-md-person" style="margin-right:6px;"></i>${USER_NAME}
                    </div>
                    <div style="display:flex; gap:14px; font-size:18px;">
                        <a href="#" id="sidebar-logout-btn" title="${authTitle}" style="text-decoration:none; color:#f1f1f1; transition:0.2s;"><i class="icon ${authIcon}"></i></a>
                    </div>
                </div>

                <!-- DASHBOARD LINKS (Monochrome Ionicons) -->
                <div style="display:flex; flex-direction:column; gap:2px; margin-bottom: 15px; border-bottom: 1px solid #303030; padding-bottom: 15px;">
                    <div style="color:#f1f1f1; font-size:11px; margin-bottom:5px; font-weight:bold; text-transform:uppercase; letter-spacing:1px;">Tools</div>
                    <a href="/notifications" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;">
                        <span><i class="icon ion-md-notifications" style="margin-right:8px;"></i>${NOTIF_COUNT}</span>
                    </a>
                    <a href="/feed/history" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;">
                        <span><i class="icon ion-md-time" style="margin-right:8px;"></i>Watch History</span>
                    </a>
                    <a href="/subscription_manager" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;">
                        <span><i class="icon ion-md-people" style="margin-right:8px;"></i>Manage Subscriptions</span>
                    </a>
                    <a href="/preferences" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;">
                        <span><i class="icon ion-md-options" style="margin-right:8px;"></i>Invidious Preferences</span>
                    </a>
                </div>

                <!-- NATIVE NAVIGATION (Monochrome Ionicons) -->
                <div style="display:flex; flex-direction:column; gap:2px; margin-bottom: 15px; border-bottom: 1px solid #303030; padding-bottom: 15px;">
                    <div style="color:#f1f1f1; font-size:11px; margin-bottom:5px; font-weight:bold; text-transform:uppercase; letter-spacing:1px;">Navigation</div>
                    <a href="/feed/popular" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;">
                        <span><i class="icon ion-md-flame" style="margin-right:8px;"></i>Popular</span>
                    </a>
                    <a href="/feed/trending" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;">
                        <span><i class="icon ion-md-trending-up" style="margin-right:8px;"></i>Trending</span>
                    </a>
                    <a href="/feed/subscriptions" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;">
                        <span><i class="icon ion-md-play-circle" style="margin-right:8px;"></i>Subscriptions</span>
                    </a>
                    <a href="/feed/playlists" class="sidebar-badge sidebar-nav-link" style="text-decoration:none; color:#f1f1f1;">
                        <span><i class="icon ion-md-folder" style="margin-right:8px;"></i>Playlists</span>
                    </a>
                </div>

                ${feedSpecificHtml}
            `;

            if (debugPanel.innerHTML !== html) {
                debugPanel.innerHTML = html;
            }
        } catch (e) {
            console.error("[Bucket] Error in updateStatsPanel:", e);
        }
    }

    // Global Click Delegation (Sidebar functionality across all pages)
    document.addEventListener('click', (e) => {
        // Native Logout/Login Trigger
        if (e.target.closest('#sidebar-logout-btn')) {
            e.preventDefault();

            if (IS_LOGGED_IN) {
                let allForms = Array.from(document.querySelectorAll('form'));
                let formLogout = allForms.find(f => f.action && (f.action.toLowerCase().includes('logout') || f.action.toLowerCase().includes('signout')));

                let allNativeLinks = Array.from(document.querySelectorAll('a')).filter(a => !a.closest('#bucket-debug-panel') && !a.closest('#custom-unified-header'));
                let aLogout = allNativeLinks.find(a => a.href && (a.href.toLowerCase().includes('logout') || a.href.toLowerCase().includes('signout')));

                if (formLogout) {
                    let btn = formLogout.querySelector('button, input[type="submit"]');
                    if (btn) btn.click();
                    else formLogout.submit();
                } else if (aLogout) {
                    aLogout.click();
                    // Fallback force redirect to main dashboard if js blocked
                    setTimeout(() => window.location.href = '/signout?referer=/feed/subscriptions', 500);
                } else {
                    window.location.href = '/signout?referer=/feed/subscriptions';
                }
            } else {
                let allNativeLinks = Array.from(document.querySelectorAll('a')).filter(a => !a.closest('#bucket-debug-panel') && !a.closest('#custom-unified-header'));
                let aLogin = allNativeLinks.find(a => a.href && a.href.toLowerCase().includes('login'));

                if (aLogin) {
                    // Force the link to redirect to subscriptions rather than default Popular feed to avoid broken ui!
                    aLogin.href = '/login?referer=/feed/subscriptions';
                    aLogin.click();
                    setTimeout(() => window.location.href = '/login?referer=/feed/subscriptions', 500);
                } else {
                    window.location.href = '/login?referer=/feed/subscriptions';
                }
            }
            return;
        }

        // Scroll to Video Logic
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

    function updateTagInDOM(channelLink, assignedBucket) {
        let parent = channelLink.parentNode;

        // PERFECT FONT LEVELING - 10px Gap so it's less crowded
        parent.style.display = 'flex';
        parent.style.alignItems = 'center';
        parent.style.gap = '10px';
        parent.style.flexWrap = 'nowrap';
        parent.style.marginTop = '8px';
        parent.style.marginBottom = '8px';
        parent.style.overflow = 'hidden';

        // Lock the channel name link to the same center baseline
        channelLink.style.display = 'flex';
        channelLink.style.alignItems = 'center';
        channelLink.style.lineHeight = '1';

        let tag = parent.querySelector('.bucket-tag');
        let btn = parent.querySelector('.bucket-add-btn');

        if (tag) {
            if (!assignedBucket) tag.remove();
            else tag.innerText = assignedBucket;
        } else if (assignedBucket) {
            tag = document.createElement('span'); tag.className = 'bucket-tag'; tag.innerText = assignedBucket;
            if (btn) parent.insertBefore(tag, btn); else parent.appendChild(tag);
        }
        if (!btn) {
            const addBtn = document.createElement('span'); addBtn.className = 'bucket-add-btn'; addBtn.innerText = '+';
            addBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openManagerModal(getCleanName(channelLink)); };
            parent.appendChild(addBtn);
        }
    }

    function getBucketForChannel(name) {
        let cleanName = name.toLowerCase().trim();
        for (const [key, val] of Object.entries(BUCKETS)) {
            if (val.channels.some(n => n.toLowerCase().trim() === cleanName)) return key;
        }
        return null;
    }

    // --- 7. UI MODALS ---
    function openSettingsModal() {
        const existing = document.querySelector('.bucket-modal-overlay'); if (existing) existing.remove();
        const overlay = document.createElement('div'); overlay.className = 'bucket-modal-overlay';
        overlay.onclick = (e) => { if(e.target === overlay) overlay.remove(); };
        const modal = document.createElement('div'); modal.className = 'bucket-modal';
        modal.innerHTML = `<h2 style="margin:0 0 10px 0;">Settings & Ordering</h2>`;
        const sortedKeys = Object.keys(BUCKETS).sort((a,b) => BUCKETS[a].order - BUCKETS[b].order);
        sortedKeys.forEach(key => {
            const row = document.createElement('div'); row.className = 'bucket-order-row'; row.innerHTML = `<span>${key}</span>`;
            const input = document.createElement('input'); input.type = 'number'; input.className = 'bucket-order-input'; input.value = BUCKETS[key].order;
            input.onchange = (e) => { BUCKETS[key].order = parseInt(e.target.value) || 0; saveBuckets(BUCKETS); };
            row.appendChild(input); modal.appendChild(row);
        });
        const grid = document.createElement('div'); grid.className = 'bucket-grid';
        const createBtn = document.createElement('div'); createBtn.className = 'bucket-option'; createBtn.style.gridColumn = 'span 2'; createBtn.style.background = '#f1f1f1'; createBtn.style.color = '#0f0f0f'; createBtn.innerText = "+ Create New Category";
        createBtn.onclick = () => { const name = prompt("Name:"); if (name && !BUCKETS[name]) { BUCKETS[name] = { channels:[], order: Object.keys(BUCKETS).length + 2 }; saveBuckets(BUCKETS); openSettingsModal(); } };
        grid.appendChild(createBtn);
        modal.appendChild(grid);

        const purgeGroup = document.createElement('div'); purgeGroup.className = 'bucket-purge-group';
        const pt = document.createElement('div'); pt.className = 'purge-btn purge-tags'; pt.innerText = "Empty All Categories";
        pt.onclick = () => { if(confirm("Clear ALL tagged channels?")) { Object.keys(BUCKETS).forEach(k => BUCKETS[k].channels =[]); saveBuckets(BUCKETS); location.reload(); }};
        const pc = document.createElement('div'); pc.className = 'purge-btn purge-cats'; pc.innerText = "Reset Everything";
        pc.onclick = () => { if(confirm("Delete ALL categories?")) { saveBuckets({}); location.reload(); }};
        purgeGroup.appendChild(pt); purgeGroup.appendChild(pc); modal.appendChild(purgeGroup);

        const closeBtn = document.createElement('button'); closeBtn.className = 'bucket-close'; closeBtn.innerText = "Close & Apply";
        closeBtn.onclick = () => { overlay.remove(); location.reload(); };
        modal.appendChild(closeBtn); overlay.appendChild(modal); document.body.appendChild(overlay);
    }

    function openManagerModal(channelName) {
        const existing = document.querySelector('.bucket-modal-overlay'); if (existing) existing.remove();
        const overlay = document.createElement('div'); overlay.className = 'bucket-modal-overlay';
        overlay.onclick = (e) => { if(e.target === overlay) overlay.remove(); };
        const modal = document.createElement('div'); modal.className = 'bucket-modal';
        modal.innerHTML = `<h2 style="margin:0 0 15px 0;">Manage: ${channelName}</h2>`;
        const grid = document.createElement('div'); grid.className = 'bucket-grid';

        Object.keys(BUCKETS).forEach(key => {
            const btn = document.createElement('div'); btn.className = 'bucket-option';
            if (BUCKETS[key].channels.some(n => n.toLowerCase().trim() === channelName.toLowerCase().trim())) btn.classList.add('selected');
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
        const closeBtn = document.createElement('button'); closeBtn.className = 'bucket-close'; closeBtn.innerText = "Close";
        closeBtn.onclick = () => overlay.remove();
        modal.appendChild(grid); modal.appendChild(closeBtn); overlay.appendChild(modal); document.body.appendChild(overlay);
    }

    // --- GLOBAL MONOLITH HEADER (INJECTED ON EVERY PAGE) ---
    function injectDashboardHeader() {
        try {
            const isFeed = window.location.pathname.includes('/feed/subscriptions');
            if (document.getElementById('custom-unified-header')) return;

            const header = document.createElement('div');
            header.id = 'custom-unified-header';

            const logo = document.createElement('a');
            logo.href = "/feed/subscriptions"; // Directs back to your actual dashboard!
            logo.className = 'custom-invidious-logo';
            logo.innerText = 'INVIDIOUS';
            header.appendChild(logo);

            const nativeForm = document.querySelector('form[action="/search"]');
            if (nativeForm) {
                header.appendChild(nativeForm);
            }

            const wrapper = document.createElement('div');
            wrapper.className = isFeed ? 'bucket-ui-wrapper' : 'bucket-ui-wrapper mini-wrapper';

            const statBtn = document.createElement('div'); statBtn.className = 'bucket-btn action-btn';
            statBtn.innerHTML = '<i class="icon ion-md-stats" style="margin-right:6px;"></i>Tracker';
            statBtn.onclick = () => {
                const isOpen = document.body.classList.toggle('tracker-open');
                localStorage.setItem('bucket_tracker_open', isOpen);
            };

            const cog = document.createElement('div'); cog.className = 'bucket-btn action-btn';
            cog.innerHTML = '<i class="icon ion-md-settings" style="margin-right:6px;"></i>Settings';
            cog.onclick = openSettingsModal;

            if (isFeed) {
                const lBtn = document.createElement('div'); lBtn.className = 'bucket-nav-btn';
                lBtn.innerHTML = '<i class="icon ion-md-arrow-back"></i>';
                const rBtn = document.createElement('div'); rBtn.className = 'bucket-nav-btn';
                rBtn.innerHTML = '<i class="icon ion-md-arrow-forward"></i>';

                const scroller = document.createElement('div'); scroller.className = 'bucket-scroll-area';

                lBtn.onclick = () => { scroller.scrollLeft -= 300; };
                rBtn.onclick = () => { scroller.scrollLeft += 300; };

                wrapper.appendChild(lBtn);
                wrapper.appendChild(scroller);
                wrapper.appendChild(rBtn);
                wrapper.appendChild(statBtn);
                wrapper.appendChild(cog);
                renderButtons(scroller);
            } else {
                // THE ANTI-STRANDING BRIDGE (For Playlists, History, Settings)
                const backBtn = document.createElement('div');
                backBtn.className = 'bucket-btn action-btn';
                backBtn.innerHTML = '<i class="icon ion-md-arrow-back" style="margin-right:6px;"></i>Dashboard';
                backBtn.onclick = () => { window.location.href = '/feed/subscriptions'; };

                wrapper.appendChild(backBtn);
                wrapper.appendChild(statBtn);
                wrapper.appendChild(cog);
            }

            header.appendChild(wrapper);

            // Insert globally at the top of the body
            document.body.insertBefore(header, document.body.firstChild);
        } catch (e) {
            console.error("[Bucket] Error in injectDashboardHeader:", e);
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
        const btn = document.createElement('div'); btn.innerText = text; btn.className = 'bucket-btn';
        if (text === CURRENT_FILTER) btn.classList.add('active');
        btn.onclick = (e) => {
            document.querySelectorAll('.bucket-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            sessionStorage.setItem('bucket_active_tab', text);
            onClick();
        };
        parent.appendChild(btn);
    }

    // --- 8. TIME MACHINE GESTURES ---
    function setupGestures() {
        try {
            window.addEventListener('wheel', (e) => {
                if (e.shiftKey) {
                    e.preventDefault();

                    if (window.location.pathname.includes('/feed/subscriptions')) {
                        if (e.deltaY > 0) {
                            TARGET_PAGES += 5;
                            fillBucket();
                        }
                        return;
                    }

                    const direction = e.deltaY > 0 ? 'Next page' : 'Previous page';
                    const btn = Array.from(document.querySelectorAll('a.pure-button')).find(b => b.textContent.includes(direction));
                    if (btn) btn.click();
                }
            }, { passive: false });
        } catch (e) {
            console.error("[Bucket] Error in setupGestures:", e);
        }
    }

    // --- 9. TRANSCRIPT LOGIC ---
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
            btn.style.cssText = `
                width: 4em;
                cursor: pointer;
                font-family: "Roboto", "Arial", sans-serif !important;
                color: #f1f1f1 !important;
                display: flex;
                align-items: center;
                justify-content: center;
                order: -1;
            `;
            btn.innerHTML = '<i class="icon ion-md-document" style="font-size: 1.5em; line-height: 1;"></i>';
            captionsBtn.parentNode.insertBefore(btn, captionsBtn);

            btn.onclick = async () => {
                const videoID = new URLSearchParams(window.location.search).get('v');
                if (!videoID) return;

                const span = btn.querySelector('i');
                span.className = 'icon ion-md-hourglass';

                try {
                    const response = await fetch(`${API_URL}/get-transcript?v=${videoID}`);
                    const data = await response.json();

                    if (data.error) throw new Error(data.error);
                    if (!data.vtt_content) throw new Error("Bridge returned empty content.");

                    const finalCleanText = cleanVTT(data.vtt_content);
                    if (!finalCleanText) throw new Error("Cleaning resulted in empty text.");

                    await navigator.clipboard.writeText(finalCleanText);
                    span.className = 'icon ion-md-checkmark';
                    setTimeout(() => span.className = 'icon ion-md-document', 2000);

                } catch (e) {
                    console.error("[Bucket] Bridge Copy Error:", e);
                    span.className = 'icon ion-md-close';
                    alert(`Error: ${e.message}`);
                }
            };
        } catch (e) {
            console.error("[Bucket] Error in injectTranscriptButton:", e);
        }
    }

    // --- 11. SPA AUDIO SHUFFLE ENGINE ---
    function initTrueShuffle() {
        try {
            const log = (msg, ...args) => console.log(`[AudioShuffle] ${msg}`, ...args);

            // PART 1: The Playlist Page (Intercepting UI & Building Pool)
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

                    // Fully shuffle the array instantly before saving
                    for (let i = ids.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [ids[i], ids[j]] = [ids[j], ids[i]];
                    }

                    // Save exclusively to sessionStorage (Isolates to this tab only)
                    sessionStorage.setItem('bucket_audio_original', JSON.stringify(ids));

                    let firstVideo = ids.shift(); // Extract the first item

                    sessionStorage.setItem('bucket_audio_pool', JSON.stringify(ids));

                    // Launch Radio Mode using URL flag
                    window.location.href = `/watch?v=${firstVideo}&audio_shuffle=true`;
                };
            }

            // PART 2: The Watch Page (The SPA Audio Engine)
            // Strictly check the URL parameter, NO global flags!
            const isAudioActive = window.location.search.includes('audio_shuffle=true');

            if (window.location.pathname.startsWith('/watch') && isAudioActive) {

                // Wait for native player container to render so we can obliterate it
                const hijackPlayer = setInterval(() => {
                    const playerContainer = document.getElementById('player-container');
                    if (playerContainer) {
                        clearInterval(hijackPlayer);
                        log("Nuking native Video.js player and installing SPA Audio UI.");

                        // Build our custom sleek player UI
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

                        // Hide the rest of the page junk (comments, related videos)
                        const related = document.getElementById('related');
                        if (related) related.style.display = 'none';
                        const comments = document.getElementById('comments');
                        if (comments) comments.style.display = 'none';

                        const audioElem = document.getElementById('ca-audio');
                        const titleElem = document.getElementById('ca-title');
                        const authorElem = document.getElementById('ca-author');
                        const thumbElem = document.getElementById('ca-thumb');

                        // Function to fetch and play a video ID via the Invidious API
                        async function playTrack(videoId) {
                            try {
                                log(`Fetching API data for ${videoId}...`);
                                titleElem.innerText = "Fetching Track Data...";
                                thumbElem.style.opacity = '0.5';

                                // Push URL to history so Transcript Bridge has the correct ID context AND the param survives refreshes
                                history.pushState(null, '', `/watch?v=${videoId}&audio_shuffle=true`);

                                // ABSOLUTE URL FIX: Force the browser to use a fully qualified origin path
                                const apiUrl = `${window.location.origin}/api/v1/videos/${videoId}`;
                                const res = await fetch(apiUrl);

                                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                                const data = await res.json();

                                titleElem.innerText = data.title;
                                authorElem.innerText = data.author;
                                document.title = `🎵 ${data.title}`;

                                // Use the best available thumbnail
                                if (data.videoThumbnails && data.videoThumbnails.length > 0) {
                                    const bestThumb = data.videoThumbnails.find(t => t.quality === 'maxres') || data.videoThumbnails[data.videoThumbnails.length - 1];
                                    // Absolute URL Fix for Thumbnails
                                    thumbElem.src = bestThumb.url.startsWith('/') ? window.location.origin + bestThumb.url : bestThumb.url;
                                    thumbElem.style.opacity = '1';
                                }

                                // Find the best audio-only stream
                                let audioFormat = null;
                                if (data.adaptiveFormats) {
                                    const audioStreams = data.adaptiveFormats.filter(f => f.type && f.type.startsWith('audio/'));
                                    audioFormat = audioStreams.find(f => f.type.includes('mp4')) || audioStreams[0];
                                }

                                // Fallback if no adaptive streams are available
                                if (!audioFormat && data.formatStreams) {
                                    audioFormat = data.formatStreams.find(f => !f.resolution) || data.formatStreams[0];
                                }

                                if (audioFormat && audioFormat.url) {
                                    log("Audio stream found. Starting playback.");
                                    // Absolute URL Fix for the Media Stream
                                    let finalAudioUrl = audioFormat.url.startsWith('/') ? window.location.origin + audioFormat.url : audioFormat.url;
                                    audioElem.src = finalAudioUrl;
                                    audioElem.play().catch(e => log("Autoplay prevented:", e));
                                } else {
                                    titleElem.innerText = "Error: No Audio Stream Found";
                                    setTimeout(playNextTrack, 3000); // Skip automatically after 3s
                                }

                            } catch (err) {
                                console.error("[Bucket] Audio Fetch Error:", err);
                                titleElem.innerText = "Network Error - Skipping...";
                                setTimeout(playNextTrack, 3000);
                            }
                        }

                        // Core state engine to pop the next track
                        function playNextTrack() {
                            let pool = JSON.parse(sessionStorage.getItem('bucket_audio_pool') || '[]');
                            let original = JSON.parse(sessionStorage.getItem('bucket_audio_original') || '[]');

                            if (pool.length === 0) {
                                pool = [...original];
                                // Reshuffle
                                for (let i = pool.length - 1; i > 0; i--) {
                                    const j = Math.floor(Math.random() * (i + 1));
                                    [pool[i], pool[j]] =[pool[j], pool[i]];
                                }
                                const currentV = new URLSearchParams(window.location.search).get('v');
                                if(pool[0] === currentV) pool.push(pool.shift());
                            }

                            if (pool.length > 0) {
                                let nextId = pool.shift();
                                sessionStorage.setItem('bucket_audio_pool', JSON.stringify(pool));
                                playTrack(nextId); // Instantly swap the audio stream natively
                            }
                        }

                        // Native HTML5 Events
                        audioElem.addEventListener('ended', () => {
                            log("Track ended. Firing next track automatically.");
                            playNextTrack();
                        });

                        audioElem.addEventListener('error', () => {
                            log("Audio stream error. Skipping to next track.");
                            playNextTrack();
                        });

                        // Button wiring
                        document.getElementById('ca-next').onclick = playNextTrack;

                        document.getElementById('ca-stop').onclick = () => {
                            sessionStorage.removeItem('bucket_audio_pool');
                            sessionStorage.removeItem('bucket_audio_original');
                            window.location.href = '/feed/playlists'; // Throw user back to UI gracefully
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

                                const finalCleanText = cleanVTT(data.vtt_content);
                                await navigator.clipboard.writeText(finalCleanText);

                                btn.innerHTML = '<i class="icon ion-md-checkmark" style="margin-right:6px;"></i>Copied!';
                                setTimeout(() => btn.innerHTML = originalText, 2000);
                            } catch (err) {
                                alert("Transcript error: " + err.message);
                                btn.innerHTML = originalText;
                            }
                        };

                        // Kick off the first track immediately
                        const initialId = new URLSearchParams(window.location.search).get('v');
                        if (initialId) {
                            playTrack(initialId);
                        }
                    }
                }, 100);
            }
        } catch (e) {
            console.error("[Bucket] Error in initTrueShuffle:", e);
        }
    }

    // --- 10. INIT ---
    function init() {
        try {
            extractUserData();
            hideNativeHeaderJunk();
            setupGestures();
            loadBuckets();
            initTrueShuffle();

            // 1. Globally inject the Monolith Header
            injectDashboardHeader();

            // 2. Only run the scraper and sorter on the Subscription Feed
            if (window.location.pathname.includes('/feed/subscriptions')) {
                setInterval(() => {
                    applyChangesLive();
                }, 1000);
            } else {
                // For Watch/Channel/Search pages, run optimizations
                if (window.location.pathname.startsWith('/watch')) {
                    optimizePlayback();
                    injectTranscriptButton();
                }
            }
        } catch (e) {
            console.error("[Bucket] Fatal error during init:", e);
        }
    }

    init();
})();