        let STATIONS_BY_DIVISION = {};

        let teamsData = [];
        let TEAM_DATA_BY_DIVISION = {};
        let divisionDataCache = {};
        let selectedConference = 'NFC';
        let selectedDivision = 'EAST';
        const SETTINGS_STORAGE_KEY = 'nflDivisionDashboard.settings.v1';
        const HISTORY_STORAGE_KEY = 'nflDivisionDashboard.history.v1';
        const HISTORY_LIMIT = 20;
        const DASHBOARD_DATA_URL = 'data.json';
        const EMPTY_SVG_DATA_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
        const EXPORT_IMAGE_PLACEHOLDER = EMPTY_SVG_DATA_URL;
        const IS_LOCALHOST = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

        // Custom panel state
        let customOrder = []; // team names in drag order
        let customValues = {}; // team -> value
        let customDragSrc = null;
        let divisionStates = {};
        let settingsHistory = [];
        let autoSnapshotTimer = null;
        let logoAnalysisRequestId = 0;
        const FOX_BASE_GRADIENT = ['#04133b', '#0b2a6e'];
        const CONFERENCE_LOGO_BY_KEY = {
            AFC: 'https://upload.wikimedia.org/wikipedia/commons/7/7a/American_Football_Conference_logo.svg',
            NFC: 'https://upload.wikimedia.org/wikipedia/commons/6/6f/National_Football_Conference_logo.svg'
        };

        let selectedLogoUrl = EMPTY_SVG_DATA_URL;
        let selectedHeaderColors = ['#1e3a8a', '#3b82f6'];
        let previewStationConfig = null;
        function getDomToImage() {
            return Promise.resolve(window.domtoimage);
        }

        function normalizeDataUrlMime(url) {
            if (typeof url !== 'string') return url;
            if (!url.startsWith('data:;base64,')) return url;
            const payload = url.slice('data:;base64,'.length);
            const isLikelySvg = payload.startsWith('PHN2Zy') || payload.startsWith('PD94bWwg');
            return `data:${isLikelySvg ? 'image/svg+xml' : 'image/png'};base64,${payload}`;
        }

        function normalizeExportImageSources(containerElement) {
            if (!containerElement) return;
            containerElement.querySelectorAll('img').forEach((img) => {
                const rawSrc = img.getAttribute('src') || '';
                const fixed = normalizeDataUrlMime(rawSrc);
                if (fixed !== rawSrc) {
                    console.warn('[export] normalized typeless data URL', {
                        alt: img.alt || '',
                        originalPrefix: rawSrc.slice(0, 40)
                    });
                    img.setAttribute('src', fixed);
                }
            });
        }

        function describeExportError(error) {
            if (!error) return { summary: 'Unknown export error' };
            if (error instanceof Event) {
                const target = error.target || error.srcElement || null;
                const src = target && (target.currentSrc || target.src || target.getAttribute?.('src')) || null;
                return {
                    summary: `DOM event error: ${error.type || 'unknown'}`,
                    isTrusted: !!error.isTrusted,
                    failedSrc: src,
                    targetTag: target && target.tagName ? target.tagName : null
                };
            }
            if (error instanceof Error) {
                return {
                    summary: error.message || 'Error',
                    name: error.name || 'Error',
                    stack: error.stack || null
                };
            }
            if (typeof error === 'object') {
                return { summary: 'Object error', ...error };
            }
            return { summary: String(error) };
        }

        function waitForImageElement(img, timeoutMs) {
            return new Promise((resolve) => {
                if (!img) {
                    resolve({ ok: false, reason: 'missing' });
                    return;
                }
                if (img.complete) {
                    const ok = (img.naturalWidth || 0) > 0;
                    resolve({ ok, reason: ok ? 'complete' : 'broken' });
                    return;
                }

                let done = false;
                const finish = (result) => {
                    if (done) return;
                    done = true;
                    img.removeEventListener('load', onLoad);
                    img.removeEventListener('error', onError);
                    clearTimeout(timer);
                    resolve(result);
                };
                const onLoad = () => finish({ ok: true, reason: 'load' });
                const onError = () => finish({ ok: false, reason: 'error' });
                const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);

                img.addEventListener('load', onLoad, { once: true });
                img.addEventListener('error', onError, { once: true });
            });
        }

        async function preflightExportImages(containerElement) {
            const images = Array.from(containerElement.querySelectorAll('img'));
            if (!images.length) return;

            const checks = await Promise.all(images.map((img) => waitForImageElement(img, 900)));
            const failed = [];

            checks.forEach((result, index) => {
                if (result.ok) return;
                const img = images[index];
                failed.push({
                    reason: result.reason,
                    src: (img.currentSrc || img.src || '').slice(0, 240),
                    alt: img.alt || ''
                });
                // Prevent dom-to-image from waiting forever on a bad/stuck image.
                img.src = EMPTY_SVG_DATA_URL;
            });

            if (failed.length) {
                console.warn('[export] image preflight replaced problematic images', failed);
            } else {
                console.log('[export] image preflight all good');
            }
        }

        function shouldIncludeNodeForExport(node) {
            if (!(node instanceof Element)) return true;
            if (node.id === 'history-controls') return false;
            if (node.id === 'history-popover') return false;
            if (node.id === 'custom-panel') return false;
            if (node.id === 'custom-overlay') return false;
            if (node.classList.contains('controls')) return false;
            if (node.closest('.controls')) return false;
            if (node.closest('#history-controls')) return false;
            if (node.closest('#custom-panel')) return false;
            if (node.closest('#custom-overlay')) return false;
            return true;
        }

        function getExportDisplayUrl() {
            if (IS_LOCALHOST) return 'https://nfl.rprtd.app';
            const { protocol, host, pathname } = window.location;
            return `${protocol}//${host}${pathname || '/'}`;
        }

        function getDivisionKey() {
            return `${selectedConference.toLowerCase()}_${selectedDivision.toLowerCase()}`;
        }

        function getDivisionLabel() {
            return `${selectedConference} ${selectedDivision}`;
        }

        function withLocalNoCache(url) {
            if (!IS_LOCALHOST || !url || url.startsWith('data:')) return url;
            try {
                const parsed = new URL(url, window.location.href);
                const pathname = parsed.pathname || '';
                const isImage = /\.(svg|png|jpe?g|gif|webp|avif)$/i.test(pathname);
                // Keep logo/image URLs clean so dom-to-image can infer MIME type correctly.
                if (isImage) return url;
            } catch (_) {
                // If URL parsing fails, fall through to original behavior.
            }
            const sep = url.includes('?') ? '&' : '?';
            return `${url}${sep}devcb=${Date.now()}`;
        }

        function renderDivisionButtons() {
            document.querySelectorAll('.conference-toggle').forEach((button) => {
                button.classList.toggle('active', button.dataset.value === selectedConference);
            });
            document.querySelectorAll('.division-toggle-btn').forEach((button) => {
                button.classList.toggle('active', button.dataset.value === selectedDivision);
            });
        }

        function getDefaultStationsForDivision() {
            const divisionStations = getStationsForDivision();
            return divisionStations[0] || {
                url: EMPTY_SVG_DATA_URL,
                color: '#1e3a8a,#3b82f6',
                tint: null
            };
        }

        function normalizeTintValue(tint) {
            if (tint === undefined) return undefined;
            if (tint === null) return null;
            const value = String(tint).trim().toLowerCase();
            if (!value || value === 'null' || value === 'none') return null;
            if (value === 'white' || value === 'black') return value;
            return null;
        }

        function getStationsForDivision() {
            const key = getDivisionKey();
            const raw = STATIONS_BY_DIVISION[key] || [];
            return raw.map((station) => {
                const hasTint = Object.prototype.hasOwnProperty.call(station, 'tint');
                const normalizedTint = normalizeTintValue(station.tint);
                return {
                    ...station,
                    hasExplicitTint: hasTint,
                    tint: hasTint ? normalizedTint : (isFoxStationExcept29(station.label || '') ? 'white' : null)
                };
            });
        }

        function normalizeColorPair(colorCsv) {
            const parts = (colorCsv || '').split(',');
            return [
                parts[0] ? parts[0].trim() : '#1e3a8a',
                parts[1] ? parts[1].trim() : '#3b82f6'
            ];
        }

        function parseHexColor(hex) {
            if (!hex || typeof hex !== 'string') return null;
            const clean = hex.trim().replace('#', '');
            const full = clean.length === 3
                ? clean.split('').map((ch) => ch + ch).join('')
                : clean;
            if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
            return {
                r: parseInt(full.slice(0, 2), 16),
                g: parseInt(full.slice(2, 4), 16),
                b: parseInt(full.slice(4, 6), 16)
            };
        }

        function rgbToHex(rgb) {
            const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
            return `#${c(rgb.r)}${c(rgb.g)}${c(rgb.b)}`;
        }

        function getPerceivedLuma(rgb) {
            return (0.2126 * rgb.r) + (0.7152 * rgb.g) + (0.0722 * rgb.b);
        }

        function darkenForWhiteText(colorHex) {
            const rgb = parseHexColor(colorHex);
            if (!rgb) return '#1e3a8a';
            const luma = getPerceivedLuma(rgb);
            if (luma <= 120) return colorHex;
            const factor = 120 / luma;
            return rgbToHex({
                r: rgb.r * factor,
                g: rgb.g * factor,
                b: rgb.b * factor
            });
        }

        function tintTowardBlue(colorHex) {
            const rgb = parseHexColor(colorHex);
            if (!rgb) return '#1e3a8a';
            return rgbToHex({
                r: rgb.r * 0.82,
                g: rgb.g * 0.9,
                b: (rgb.b * 1.15) + 12
            });
        }

        function getReadableHeaderColors(colors) {
            const stationLabel = getSelectedStationLabel();
            const station = getSelectedStationConfig();
            const explicitNullTint = !!(station && station.hasExplicitTint && station.tint === null);
            const sourceColors = (isFoxStationExcept29(stationLabel) && !explicitNullTint)
                ? FOX_BASE_GRADIENT
                : colors;
            const c1 = darkenForWhiteText(tintTowardBlue(sourceColors[0]));
            const c2 = darkenForWhiteText(tintTowardBlue(sourceColors[1]));
            if (c1.toLowerCase() === c2.toLowerCase()) {
                const rgb = parseHexColor(c2) || { r: 30, g: 58, b: 138 };
                return [c1, rgbToHex({ r: rgb.r * 0.85, g: rgb.g * 0.85, b: rgb.b * 0.85 })];
            }
            return [c1, c2];
        }

        function getSelectedLogoUrl() {
            const active = document.querySelector('.logo-toggle.active');
            if (active && active.dataset.url === 'custom') {
                return document.getElementById('custom-logo-url').value || selectedLogoUrl;
            }
            return selectedLogoUrl;
        }

        function getSelectedStationConfig() {
            if (previewStationConfig) return previewStationConfig;
            const active = document.querySelector('.logo-toggle.active');
            if (active && active.dataset.url === 'custom') return null;
            const selected = active ? active.dataset.url : getSelectedLogoUrl();
            return getStationsForDivision().find((station) => station.url === selected) || null;
        }

        function getSelectedStationLabel() {
            const station = getSelectedStationConfig();
            return station ? (station.label || '') : '';
        }

        function isFoxStationExcept29(label) {
            const text = (label || '').trim().toLowerCase();
            return text.includes('fox') && !text.includes('fox 29');
        }

        function setLogoBackgroundMode(enable) {
            const header = document.querySelector('.header');
            header.classList.toggle('dark-logo-bg', !!enable);
        }

        function shouldForceWhiteFoxLogo() {
            const station = getSelectedStationConfig();
            return station ? station.tint === 'white' : false;
        }

        function hexToRgb(hex) {
            const clean = (hex || '').replace('#', '').trim();
            const full = clean.length === 3
                ? clean.split('').map((ch) => ch + ch).join('')
                : clean;
            if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
            return {
                r: parseInt(full.slice(0, 2), 16),
                g: parseInt(full.slice(2, 4), 16),
                b: parseInt(full.slice(4, 6), 16)
            };
        }

        function colorDistance(a, b) {
            const dr = a.r - b.r;
            const dg = a.g - b.g;
            const db = a.b - b.b;
            return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
        }

        function luminance(rgb) {
            return (0.2126 * rgb.r) + (0.7152 * rgb.g) + (0.0722 * rgb.b);
        }

        function analyzeLogoProfile(url, bgHex) {
            return new Promise((resolve) => {
                if (!url) {
                    resolve({ needsLightHeader: false, needsInvert: false, invertToWhite: true });
                    return;
                }
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = 40;
                        canvas.height = 40;
                        const ctx = canvas.getContext('2d', { willReadFrequently: true });
                        ctx.clearRect(0, 0, 40, 40);
                        ctx.drawImage(img, 0, 0, 40, 40);
                        const data = ctx.getImageData(0, 0, 40, 40).data;

                        let sampled = 0;
                        let darkCount = 0;
                        let alphaCount = 0;
                        let sumR = 0;
                        let sumG = 0;
                        let sumB = 0;

                        for (let i = 0; i < data.length; i += 4) {
                            const r = data[i];
                            const g = data[i + 1];
                            const b = data[i + 2];
                            const a = data[i + 3];
                            if (a < 20) continue;
                            alphaCount++;
                            const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
                            if (luminance < 48) darkCount++;
                            sumR += r;
                            sumG += g;
                            sumB += b;
                            sampled++;
                        }

                        if (!sampled || alphaCount < 40) {
                            resolve({ needsLightHeader: false, needsInvert: false, invertToWhite: true });
                            return;
                        }

                        const darkRatio = darkCount / sampled;
                        const avg = {
                            r: Math.round(sumR / sampled),
                            g: Math.round(sumG / sampled),
                            b: Math.round(sumB / sampled)
                        };
                        const bg = hexToRgb(bgHex) || { r: 30, g: 58, b: 138 };
                        const similarToBg = colorDistance(avg, bg) < 62;
                        const invertToWhite = luminance(bg) < 150;
                        resolve({
                            needsLightHeader: darkRatio > 0.65,
                            needsInvert: similarToBg,
                            invertToWhite
                        });
                    } catch (error) {
                        resolve({ needsLightHeader: false, needsInvert: false, invertToWhite: true });
                    }
                };
                img.onerror = () => resolve({ needsLightHeader: false, needsInvert: false, invertToWhite: true });
                img.src = withLocalNoCache(url);
            });
        }

        function refreshLogoContrastBackground(url, bgHex) {
            const requestId = ++logoAnalysisRequestId;
            const networkLogo = document.getElementById('network-logo');
            const header = document.querySelector('.header');
            const station = getSelectedStationConfig();
            const tint = station ? (station.tint ?? null) : null;
            const disableAutoTint = !!(station && station.hasExplicitTint && tint === null);
            const forceWhiteFoxLogo = !disableAutoTint && shouldForceWhiteFoxLogo();
            const foxLogoPop = !!(station && !station.hasExplicitTint && /fox/i.test(station.label || ''));
            networkLogo.classList.toggle('fox-pop-logo', foxLogoPop);
            if (header) header.classList.toggle('fox-pop-header', foxLogoPop);
            console.log('[contrast] start', {
                requestId,
                url,
                bgHex,
                stationLabel: station ? station.label : null,
                tint,
                hasExplicitTint: !!(station && station.hasExplicitTint),
                disableAutoTint,
                forceWhiteFoxLogo,
                foxLogoPop
            });
            networkLogo.classList.toggle('logo-white-invert', tint === 'white' || forceWhiteFoxLogo);
            networkLogo.classList.remove('logo-black-invert');

            // Explicit null means never apply tint/invert logic.
            if (disableAutoTint) {
                console.log('[contrast] branch: explicit-null-no-tint');
                networkLogo.classList.remove('logo-white-invert');
                networkLogo.classList.remove('logo-black-invert');
                setLogoBackgroundMode(false);
                return;
            }

            if (tint === 'black') {
                console.log('[contrast] branch: force-black');
                networkLogo.classList.remove('logo-white-invert');
                networkLogo.classList.add('logo-black-invert');
                setLogoBackgroundMode(false);
                return;
            }

            if (tint === 'white' || forceWhiteFoxLogo) {
                console.log('[contrast] branch: force-white');
                setLogoBackgroundMode(false);
                return;
            }

            console.log('[contrast] branch: analyze-profile');
            setLogoBackgroundMode(false);
            analyzeLogoProfile(url, bgHex).then((profile) => {
                if (requestId !== logoAnalysisRequestId) {
                    console.log('[contrast] branch: stale-request-skip', { requestId, activeRequestId: logoAnalysisRequestId });
                    return;
                }
                console.log('[contrast] profile', profile);
                if (profile.needsInvert && !disableAutoTint) {
                    console.log('[contrast] branch: auto-invert', { invertToWhite: profile.invertToWhite });
                    networkLogo.classList.toggle('logo-white-invert', profile.invertToWhite);
                    networkLogo.classList.toggle('logo-black-invert', !profile.invertToWhite);
                    setLogoBackgroundMode(false);
                    return;
                }
                console.log('[contrast] branch: no-invert', { needsLightHeader: profile.needsLightHeader });
                networkLogo.classList.remove('logo-white-invert');
                networkLogo.classList.remove('logo-black-invert');
                setLogoBackgroundMode(profile.needsLightHeader);
            });
        }

        function persistCurrentDivisionState() {
            const key = getDivisionKey();
            if (!teamsData.length) return;
            divisionStates[key] = {
                title: document.getElementById('custom-title').value,
                subtitle: document.getElementById('custom-subtitle').value,
                order: [...customOrder],
                values: { ...customValues },
                logoUrl: selectedLogoUrl,
                colors: [...selectedHeaderColors]
            };
        }

        function buildCurrentSettingsSnapshot() {
            return {
                selectedConference,
                selectedDivision,
                divisionStates: JSON.parse(JSON.stringify(divisionStates)),
                selectedLogoUrl,
                selectedHeaderColors: [...selectedHeaderColors],
                customLogoInput: document.getElementById('custom-logo-url').value || ''
            };
        }

        function saveSettingsToStorage(options = {}) {
            const { skipHistory = false } = options;
            try {
                localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(buildCurrentSettingsSnapshot()));
                if (!skipHistory) {
                    scheduleAutoSnapshot();
                }
            } catch (error) {
                console.warn('Unable to save settings:', error);
            }
        }

        function restoreSettingsFromStorage() {
            try {
                const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
                if (!raw) return;
                const saved = JSON.parse(raw);
                selectedConference = saved.selectedConference || selectedConference;
                selectedDivision = saved.selectedDivision || selectedDivision;
                divisionStates = saved.divisionStates || {};
                selectedLogoUrl = saved.selectedLogoUrl || selectedLogoUrl;
                selectedHeaderColors = Array.isArray(saved.selectedHeaderColors) && saved.selectedHeaderColors.length === 2
                    ? saved.selectedHeaderColors
                    : selectedHeaderColors;
                document.getElementById('custom-logo-url').value = saved.customLogoInput || '';
            } catch (error) {
                console.warn('Unable to restore settings:', error);
            }
        }

        function saveHistoryToStorage() {
            try {
                localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(settingsHistory));
            } catch (error) {
                console.warn('Unable to save history:', error);
            }
        }

        function restoreHistoryFromStorage() {
            try {
                const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
                settingsHistory = raw ? JSON.parse(raw) : [];
                settingsHistory = settingsHistory.map((item) => {
                    if (item.uniqueKey) return item;
                    const state = item.state || {};
                    return {
                        ...item,
                        uniqueKey: buildSnapshotUniqueKey(state)
                    };
                });
            } catch (error) {
                settingsHistory = [];
            }
        }

        function stableStringify(value) {
            if (value === null || typeof value !== 'object') {
                return JSON.stringify(value);
            }
            if (Array.isArray(value)) {
                return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
            }
            const keys = Object.keys(value).sort();
            return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
        }

        function hashString(input) {
            let hash = 2166136261;
            for (let i = 0; i < input.length; i++) {
                hash ^= input.charCodeAt(i);
                hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
            }
            return (hash >>> 0).toString(36);
        }

        function buildSnapshotUniqueKey(snapshotState) {
            return hashString(stableStringify(snapshotState));
        }

        function formatShortDateTime(timestamp) {
            const d = new Date(timestamp);
            return d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        }

        function renderHistoryPopover() {
            const controls = document.getElementById('history-controls');
            const popover = document.getElementById('history-popover');
            const toggle = document.getElementById('history-toggle-btn');

            controls.style.display = settingsHistory.length ? 'flex' : 'none';
            toggle.textContent = settingsHistory.length ? `Previous ${settingsHistory.length}` : 'Snapshots';
            popover.innerHTML = '';

            settingsHistory.forEach((item) => {
                const confKey = item.conference || item.state?.selectedConference || '';
                const divKey = item.division || item.state?.selectedDivision || '';
                const stationUrl = item.stationLogoUrl || item.state?.selectedLogoUrl || '';
                const row = document.createElement('div');
                row.className = `history-item${item.auto ? ' auto' : ''}`;
                row.dataset.id = item.id;

                const top = document.createElement('div');
                top.className = 'history-item-top';

                const logos = document.createElement('div');
                logos.className = 'history-item-logos';

                if (CONFERENCE_LOGO_BY_KEY[confKey]) {
                    const conf = document.createElement('img');
                    conf.className = 'history-conf-logo';
                    conf.alt = confKey || 'Conference';
                    conf.loading = 'lazy';
                    conf.decoding = 'async';
                    conf.dataset.src = CONFERENCE_LOGO_BY_KEY[confKey];
                    logos.appendChild(conf);
                }

                if (stationUrl) {
                    const station = document.createElement('img');
                    station.className = 'history-station-logo';
                    station.alt = item.stationLabel || 'Station';
                    station.loading = 'lazy';
                    station.decoding = 'async';
                    station.dataset.src = stationUrl;
                    logos.appendChild(station);
                }

                const badge = document.createElement('span');
                badge.className = 'history-division-badge';
                badge.textContent = `${confKey} ${divKey}`.trim();
                logos.appendChild(badge);

                const del = document.createElement('button');
                del.className = 'history-delete-btn';
                del.type = 'button';
                del.textContent = '\u00d7';
                del.addEventListener('click', (event) => {
                    event.stopPropagation();
                    deleteSnapshotById(item.id);
                });

                top.appendChild(logos);
                top.appendChild(del);
                row.appendChild(top);

                const title = document.createElement('div');
                title.className = 'history-item-title';
                title.textContent = item.title || 'NFL Meme War';
                row.appendChild(title);

                const subtitle = document.createElement('div');
                subtitle.className = 'history-item-subtitle';
                subtitle.textContent = item.subtitle || `In the ${confKey} ${divKey}`.trim();
                row.appendChild(subtitle);

                const date = document.createElement('div');
                date.className = 'history-item-date';
                date.textContent = formatShortDateTime(item.createdAt || Number(item.id));
                row.appendChild(date);

                row.addEventListener('click', () => {
                    loadSnapshotById(item.id);
                    document.getElementById('history-popover').classList.remove('visible');
                });

                popover.appendChild(row);
            });

            if (popover.classList.contains('visible')) {
                hydrateHistoryLogos();
            }
        }

        function hydrateHistoryLogos() {
            document.querySelectorAll('#history-popover img[data-src]').forEach((img) => {
                if (!img.src) {
                    img.src = withLocalNoCache(img.dataset.src);
                }
                img.removeAttribute('data-src');
            });
        }

        function saveSnapshot(auto = false) {
            persistCurrentDivisionState();
            const snapshotState = buildCurrentSettingsSnapshot();
            const uniqueKey = buildSnapshotUniqueKey(snapshotState);
            if (settingsHistory[0] && settingsHistory[0].uniqueKey === uniqueKey) {
                return;
            }
            const now = new Date();
            const activeLogo = document.querySelector('.logo-toggle.active');
            const createdAt = now.toISOString();
            const snapshot = {
                id: `snap_${uniqueKey}`,
                createdAt,
                conference: selectedConference,
                division: selectedDivision,
                stationLabel: activeLogo ? activeLogo.textContent.trim() : '',
                stationLogoUrl: getSelectedLogoUrl(),
                title: document.getElementById('custom-title').value || 'NFL Meme War',
                subtitle: document.getElementById('custom-subtitle').value || `In the ${getDivisionLabel()}`,
                auto: !!auto,
                state: snapshotState,
                uniqueKey
            };

            const existingIndex = settingsHistory.findIndex((item) => item.uniqueKey === uniqueKey);
            if (existingIndex >= 0) {
                settingsHistory.splice(existingIndex, 1);
            }
            settingsHistory.unshift(snapshot);
            settingsHistory = settingsHistory.slice(0, HISTORY_LIMIT);
            saveHistoryToStorage();
            renderHistoryPopover();
        }

        function scheduleAutoSnapshot() {
            clearTimeout(autoSnapshotTimer);
            autoSnapshotTimer = setTimeout(() => saveSnapshot(true), 1200);
        }

        function loadSnapshotById(snapshotId) {
            const snapshotIndex = settingsHistory.findIndex(item => item.id === snapshotId);
            const snapshot = snapshotIndex >= 0 ? settingsHistory[snapshotIndex] : null;
            if (!snapshot) return;

            const state = snapshot.state || {};
            selectedConference = state.selectedConference || selectedConference;
            selectedDivision = state.selectedDivision || selectedDivision;
            divisionStates = state.divisionStates || {};
            selectedLogoUrl = state.selectedLogoUrl || selectedLogoUrl;
            selectedHeaderColors = Array.isArray(state.selectedHeaderColors) && state.selectedHeaderColors.length === 2
                ? state.selectedHeaderColors
                : selectedHeaderColors;
            document.getElementById('custom-logo-url').value = state.customLogoInput || '';
            renderDivisionButtons();

            // Re-use action should refresh recency without creating a duplicate history entry.
            const nowIso = new Date().toISOString();
            snapshot.createdAt = nowIso;
            settingsHistory.splice(snapshotIndex, 1);
            settingsHistory.unshift(snapshot);
            saveHistoryToStorage();
            renderHistoryPopover();

            loadDivisionData().then(() => {
                saveSettingsToStorage({ skipHistory: true });
            });
        }

        function deleteSnapshotById(snapshotId) {
            settingsHistory = settingsHistory.filter(item => item.id !== snapshotId);
            saveHistoryToStorage();
            renderHistoryPopover();
        }

        function applyStateForDivision() {
            const key = getDivisionKey();
            const saved = divisionStates[key];
            const defaultStation = getDefaultStationsForDivision();
            const stations = getStationsForDivision();

            customOrder = teamsData.map(t => t.team);
            customValues = {};
            selectedLogoUrl = defaultStation.url;
            selectedHeaderColors = normalizeColorPair(defaultStation.color);
            document.getElementById('custom-title').value = '';
            document.getElementById('custom-subtitle').value = `In the ${getDivisionLabel()}`;

            if (saved) {
                document.getElementById('custom-title').value = saved.title || '';
                document.getElementById('custom-subtitle').value = saved.subtitle || `In the ${getDivisionLabel()}`;
                customOrder = saved.order && saved.order.length ? [...saved.order] : customOrder;
                customValues = saved.values ? { ...saved.values } : {};
                selectedLogoUrl = saved.logoUrl || selectedLogoUrl;
                selectedHeaderColors = saved.colors && saved.colors.length === 2
                    ? [...saved.colors]
                    : selectedHeaderColors;

                const isStationLogo = stations.some((station) => station.url === selectedLogoUrl);
                const customInput = (document.getElementById('custom-logo-url').value || '').trim();
                const isCustomLogo = !!customInput && customInput === selectedLogoUrl;
                if (!isStationLogo && !isCustomLogo) {
                    selectedLogoUrl = defaultStation.url;
                    selectedHeaderColors = normalizeColorPair(defaultStation.color);
                    if (divisionStates[key]) {
                        divisionStates[key].logoUrl = selectedLogoUrl;
                        divisionStates[key].colors = [...selectedHeaderColors];
                    }
                }
            }
        }

        function renderStationOptions() {
            const parent = document.getElementById('division-station-options');
            parent.innerHTML = '';

            const group = document.createElement('div');
            group.className = 'logo-group';

            const label = document.createElement('div');
            label.className = 'logo-group-label';
            label.textContent = `${getDivisionLabel()} Top Stations`;
            group.appendChild(label);

            const buttons = document.createElement('div');
            buttons.className = 'logo-group-buttons';
            getStationsForDivision().forEach((station) => {
                const btn = document.createElement('button');
                btn.className = 'logo-toggle';
                btn.dataset.url = station.url;
                btn.dataset.color = station.color;
                btn.dataset.tint = station.tint == null ? 'null' : String(station.tint);
                btn.textContent = station.label;
                if (station.url === selectedLogoUrl) {
                    btn.classList.add('active');
                }
                btn.addEventListener('click', handleLogoToggleClick);
                btn.addEventListener('mouseenter', () => previewStationOption(station));
                btn.addEventListener('mouseleave', restoreStationPreview);
                buttons.appendChild(btn);
            });
            group.appendChild(buttons);
            parent.appendChild(group);

            const customBtn = document.querySelector('.logo-toggle[data-url="custom"]');
            if (customBtn) {
                const hasDivisionMatch = getStationsForDivision()
                    .some(station => station.url === selectedLogoUrl);
                customBtn.classList.toggle('active', !hasDivisionMatch);
                customBtn.removeEventListener('click', handleLogoToggleClick);
                customBtn.addEventListener('click', handleLogoToggleClick);
            }

            const urlInput = document.getElementById('custom-logo-url');
            if (customBtn && customBtn.classList.contains('active')) {
                urlInput.classList.add('visible');
            } else {
                urlInput.classList.remove('visible');
            }
        }

        function previewStationOption(station) {
            if (!station || !station.url) return;
            const networkLogo = document.getElementById('network-logo');
            const header = document.querySelector('.header');
            if (!networkLogo || !header) return;

            previewStationConfig = station;
            const previewColors = normalizeColorPair(station.color || selectedHeaderColors.join(','));
            const readableColors = getReadableHeaderColors(previewColors);
            networkLogo.src = withLocalNoCache(station.url);
            networkLogo.alt = `${station.label || getDivisionLabel()} Network Logo`;
            refreshLogoContrastBackground(station.url, previewColors[0]);
            header.style.background = `linear-gradient(135deg, ${readableColors[0]} 0%, ${readableColors[1]} 100%)`;
        }

        function restoreStationPreview() {
            previewStationConfig = null;
            renderCustomTeams();
        }

        function handleLogoToggleClick(e) {
            previewStationConfig = null;
            const btn = e.currentTarget;
            document.querySelectorAll('.logo-toggle').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const urlInput = document.getElementById('custom-logo-url');
            if (btn.dataset.url === 'custom') {
                urlInput.classList.add('visible');
                urlInput.focus();
            } else {
                urlInput.classList.remove('visible');
                selectedLogoUrl = btn.dataset.url;
            }
            selectedHeaderColors = normalizeColorPair(btn.dataset.color);
            saveSettingsToStorage();
        }

        function openCustomPanel() {
            const panel = document.getElementById('custom-panel');
            const overlay = document.getElementById('custom-overlay');
            panel.classList.add('visible');
            overlay.classList.add('visible');

            renderStationOptions();
            renderCustomInputs();
        }

        function closeCustomPanel() {
            document.getElementById('custom-panel').classList.remove('visible');
            document.getElementById('custom-overlay').classList.remove('visible');
        }

        function renderCustomInputs() {
            const container = document.getElementById('custom-team-inputs');
            container.innerHTML = '';

            customOrder.forEach((teamName, idx) => {
                const team = teamsData.find(t => t.team === teamName);
                if (!team) return;

                const row = document.createElement('div');
                row.className = 'custom-team-row';
                row.style.background = team.color;
                row.draggable = true;
                row.dataset.team = teamName;
                row.dataset.index = idx;

                const handle = document.createElement('span');
                handle.className = 'drag-handle';
                handle.textContent = '\u2630';

                const name = document.createElement('span');
                name.className = 'team-name';
                name.textContent = teamName;

                const input = document.createElement('input');
                input.type = 'text';
                input.placeholder = 'Value';
                input.value = customValues[teamName] || '';
                input.addEventListener('input', (event) => {
                    customValues[teamName] = event.target.value;
                    persistCurrentDivisionState();
                    saveSettingsToStorage();
                });

                row.appendChild(handle);
                row.appendChild(name);
                row.appendChild(input);
                container.appendChild(row);

                row.addEventListener('dragstart', (event) => {
                    customDragSrc = idx;
                    row.classList.add('dragging');
                    event.dataTransfer.effectAllowed = 'move';
                });
                row.addEventListener('dragend', () => {
                    row.classList.remove('dragging');
                    container.querySelectorAll('.custom-team-row').forEach(r => r.classList.remove('drag-over'));
                });
                row.addEventListener('dragover', (event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    container.querySelectorAll('.custom-team-row').forEach(r => r.classList.remove('drag-over'));
                    row.classList.add('drag-over');
                });
                row.addEventListener('drop', (event) => {
                    event.preventDefault();
                    row.classList.remove('drag-over');
                    const targetIdx = parseInt(row.dataset.index, 10);
                    if (customDragSrc !== null && customDragSrc !== targetIdx) {
                        const item = customOrder.splice(customDragSrc, 1)[0];
                        customOrder.splice(targetIdx, 0, item);
                        renderCustomInputs();
                    }
                    customDragSrc = null;
                });
            });
        }

        function sortCustom(ascending) {
            customOrder.sort((a, b) => {
                const va = customValues[a] || '';
                const vb = customValues[b] || '';
                const na = parseFloat(va);
                const nb = parseFloat(vb);
                if (!isNaN(na) && !isNaN(nb)) {
                    return ascending ? na - nb : nb - na;
                }
                return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
            });
            renderCustomInputs();
            persistCurrentDivisionState();
            saveSettingsToStorage();
        }

        function renderCustomTeams() {
            const title = document.getElementById('custom-title').value || 'NFL Meme War';
            const subtitle = document.getElementById('custom-subtitle').value || `In the ${getDivisionLabel()}`;
            const logoUrl = getSelectedLogoUrl();

            document.getElementById('page-title').textContent = title;
            document.getElementById('page-subtitle').textContent = subtitle;
            const networkLogo = document.getElementById('network-logo');
            networkLogo.src = withLocalNoCache(logoUrl);
            networkLogo.alt = `${getDivisionLabel()} Network Logo`;
            refreshLogoContrastBackground(logoUrl, selectedHeaderColors[0]);
            const readableColors = getReadableHeaderColors(selectedHeaderColors);
            document.querySelector('.header').style.background =
                `linear-gradient(135deg, ${readableColors[0]} 0%, ${readableColors[1]} 100%)`;

            const container = document.getElementById('teams-container');
            container.innerHTML = '';

            if (!teamsData.length) {
                container.innerHTML = '<div style="color: white; text-align: center; padding: 50px;">No team data found for this division</div>';
                return;
            }

            customOrder.forEach((teamName, index) => {
                const team = teamsData.find(t => t.team === teamName);
                if (!team) return;

                const row = document.createElement('div');
                row.className = 'team-row';
                row.style.backgroundColor = team.color;
                row.style.zIndex = customOrder.length - index;

                const logo = document.createElement('img');
                logo.crossOrigin = 'anonymous';
                logo.src = withLocalNoCache(team.logo);
                logo.alt = `${team.team} Logo`;
                logo.className = 'team-logo';

                const points = document.createElement('div');
                points.className = 'points';
                const val = customValues[teamName] || '';
                if (val.length > 10) {
                    points.style.fontSize = '60px';
                } else if (val.length > 6) {
                    points.style.fontSize = '80px';
                }
                points.textContent = val;

                row.appendChild(logo);
                row.appendChild(points);
                container.appendChild(row);
            });
        }

        function applyCustom() {
            closeCustomPanel();
            persistCurrentDivisionState();
            renderCustomTeams();
            saveSettingsToStorage();
        }

        function fetchDivisionData(divisionKey) {
            if (divisionDataCache[divisionKey]) {
                return Promise.resolve(divisionDataCache[divisionKey]);
            }

            const teams = TEAM_DATA_BY_DIVISION[divisionKey] || [];
            divisionDataCache[divisionKey] = { teams };
            return Promise.resolve(divisionDataCache[divisionKey]);
        }

        function loadDivisionData() {
            const divisionKey = getDivisionKey();
            return fetchDivisionData(divisionKey).then((data) => {
                teamsData = data.teams || [];
                renderDivisionButtons();
                applyStateForDivision();
                renderStationOptions();
                renderCustomInputs();
                renderCustomTeams();
            });
        }

        function exportToPNG() {
            console.log('[export] clicked');
            const exportBtn = document.getElementById('export-btn');
            const controls = document.querySelector('.controls');
            const historyControls = document.getElementById('history-controls');
            const historyPopover = document.getElementById('history-popover');
            const containerElement = document.querySelector('.container');
            if (!controls || !containerElement || !exportBtn) {
                console.error('[export] missing refs', {
                    hasControls: !!controls,
                    hasContainer: !!containerElement,
                    hasButton: !!exportBtn
                });
                alert('Export failed: missing UI container.');
                return;
            }
            console.log('[export] refs ok', {
                containerSize: {
                    width: containerElement.offsetWidth,
                    height: containerElement.offsetHeight
                },
                imgCount: containerElement.querySelectorAll('img').length
            });
            const prevControlsDisplay = controls.style.display;
            const prevHistoryControlsDisplay = historyControls ? historyControls.style.display : '';
            const wasHistoryPopoverVisible = !!historyPopover && historyPopover.classList.contains('visible');
            const prevContainerPosition = containerElement.style.position;
            let exportUrlBadge = null;
            controls.style.display = 'none';
            if (historyControls) {
                historyControls.style.display = 'none';
            }
            if (historyPopover) {
                historyPopover.classList.remove('visible');
            }

            containerElement.style.position = 'relative';
            exportUrlBadge = document.createElement('div');
            exportUrlBadge.id = 'export-url-badge';
            exportUrlBadge.textContent = getExportDisplayUrl();
            exportUrlBadge.style.position = 'absolute';
            exportUrlBadge.style.left = '50%';
            exportUrlBadge.style.bottom = '18px';
            exportUrlBadge.style.transform = 'translateX(-50%)';
            exportUrlBadge.style.fontFamily = 'Arial Black, Arial, sans-serif';
            exportUrlBadge.style.fontSize = '24px';
            exportUrlBadge.style.fontWeight = '700';
            exportUrlBadge.style.letterSpacing = '0.5px';
            exportUrlBadge.style.color = 'rgba(255,255,255,0.75)';
            exportUrlBadge.style.textShadow = '0 2px 8px rgba(0,0,0,0.55)';
            exportUrlBadge.style.pointerEvents = 'none';
            exportUrlBadge.style.zIndex = '9999';
            containerElement.appendChild(exportUrlBadge);
            exportBtn.textContent = 'Exporting...';
            exportBtn.disabled = true;
            console.log('[export] ui locked');

            {
                setTimeout(() => {
                    console.log('[export] normalize sources start');
                    normalizeExportImageSources(containerElement);
                    console.log('[export] normalize sources done');
                    preflightExportImages(containerElement)
                    .then(() => {
                    console.log('[export] loading dom-to-image');
                    getDomToImage()
                    .then((domtoimage) => {
                        console.log('[export] dom-to-image loaded', {
                            hasToPng: !!(domtoimage && domtoimage.toPng)
                        });
                        console.log('[export] toPng start');
                        return domtoimage.toPng(containerElement, {
                            width: 1080,
                            height: 1920,
                            quality: 1.0,
                            cacheBust: true,
                            imagePlaceholder: EXPORT_IMAGE_PLACEHOLDER,
                            filter: shouldIncludeNodeForExport,
                            style: {
                                margin: '0',
                                padding: '0'
                            }
                        });
                    })
                    .then((dataUrl) => {
                        console.log('[export] toPng resolved', {
                            dataUrlPrefix: typeof dataUrl === 'string' ? dataUrl.slice(0, 30) : typeof dataUrl
                        });
                        const link = document.createElement('a');
                        const now = new Date();
                        const month = String(now.getMonth() + 1).padStart(2, '0');
                        const day = String(now.getDate()).padStart(2, '0');
                        const year = String(now.getFullYear()).slice(-2);
                        const filename = `${selectedConference}${selectedDivision}Meme-${month}-${day}-${year}.png`;

                        link.download = filename;
                        link.href = dataUrl;
                        link.click();
                        console.log('[export] download triggered', { filename });
                    })
                    .catch((error) => {
                        const details = describeExportError(error);
                        window.lastExportError = details;
                        console.error('[export] failed', details);
                        alert('Error exporting image. Please try again.');
                    })
                    .finally(() => {
                        console.log('[export] finally restore ui');
                        if (exportUrlBadge && exportUrlBadge.parentNode) {
                            exportUrlBadge.parentNode.removeChild(exportUrlBadge);
                        }
                        containerElement.style.position = prevContainerPosition;
                        controls.style.display = prevControlsDisplay || 'flex';
                        if (historyControls) {
                            historyControls.style.display = prevHistoryControlsDisplay;
                        }
                        if (historyPopover && wasHistoryPopoverVisible) {
                            historyPopover.classList.add('visible');
                        }
                        exportBtn.textContent = 'Export PNG';
                        exportBtn.disabled = false;
                        console.log('[export] done');
                    });
                    })
                    .catch((error) => {
                        console.error('[export] preflight failed', error);
                        controls.style.display = prevControlsDisplay || 'flex';
                        if (historyControls) {
                            historyControls.style.display = prevHistoryControlsDisplay;
                        }
                        if (historyPopover && wasHistoryPopoverVisible) {
                            historyPopover.classList.add('visible');
                        }
                        exportBtn.textContent = 'Export PNG';
                        exportBtn.disabled = false;
                    });
                }, 300);
            }
        }

        fetch(withLocalNoCache(DASHBOARD_DATA_URL), { cache: IS_LOCALHOST ? 'no-store' : 'default' })
            .then((response) => {
                if (!response.ok) throw new Error('Missing data.json');
                return response.json();
            })
            .then((data) => {
                TEAM_DATA_BY_DIVISION = data.teamsByDivision || {};
                STATIONS_BY_DIVISION = data.stationsByDivision || {};
                restoreSettingsFromStorage();
                restoreHistoryFromStorage();
                renderHistoryPopover();
                renderDivisionButtons();

                document.querySelectorAll('.conference-toggle').forEach((button) => {
                    button.addEventListener('click', () => {
                        const value = button.dataset.value;
                        if (value === selectedConference) return;
                        persistCurrentDivisionState();
                        selectedConference = value;
                        loadDivisionData().then(() => saveSettingsToStorage());
                    });
                });

                document.querySelectorAll('.division-toggle-btn').forEach((button) => {
                    button.addEventListener('click', () => {
                        const value = button.dataset.value;
                        if (value === selectedDivision) return;
                        persistCurrentDivisionState();
                        selectedDivision = value;
                        loadDivisionData().then(() => saveSettingsToStorage());
                    });
                });

                document.getElementById('custom-logo-url').addEventListener('input', (event) => {
                    if (document.querySelector('.logo-toggle.active')?.dataset.url === 'custom') {
                        selectedLogoUrl = event.target.value.trim() || selectedLogoUrl;
                        persistCurrentDivisionState();
                        saveSettingsToStorage();
                    }
                });
                document.getElementById('custom-title').addEventListener('input', () => {
                    persistCurrentDivisionState();
                    saveSettingsToStorage();
                });
                document.getElementById('custom-subtitle').addEventListener('input', () => {
                    persistCurrentDivisionState();
                    saveSettingsToStorage();
                });
                document.getElementById('sort-asc-btn').addEventListener('click', () => sortCustom(true));
                document.getElementById('sort-desc-btn').addEventListener('click', () => sortCustom(false));
                document.getElementById('custom-apply-btn').addEventListener('click', applyCustom);
                document.getElementById('custom-overlay').addEventListener('click', closeCustomPanel);
                document.getElementById('edit-btn').addEventListener('click', openCustomPanel);
                document.getElementById('export-btn').addEventListener('click', exportToPNG);
                document.getElementById('history-toggle-btn').addEventListener('click', (event) => {
                    event.stopPropagation();
                    const popover = document.getElementById('history-popover');
                    popover.classList.toggle('visible');
                    if (popover.classList.contains('visible')) {
                        hydrateHistoryLogos();
                    }
                });
                document.getElementById('history-popover').addEventListener('click', (event) => {
                    event.stopPropagation();
                });
                document.addEventListener('click', () => {
                    document.getElementById('history-popover').classList.remove('visible');
                });

                loadDivisionData().then(() => saveSettingsToStorage());
            })
            .catch(error => {
                console.error('Error loading data:', error);
                document.getElementById('teams-container').innerHTML =
                    '<div style="color: white; text-align: center; padding: 50px;">Error loading data</div>';
            });
