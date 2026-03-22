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
        const PREVIEW_WIDTH = 1080;
        const PREVIEW_HEIGHT = 1920;

        // Custom panel state
        let customOrder = []; // team names in drag order
        let customValues = {}; // team -> end value
        let customStartValues = {}; // team -> start value
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
        let activeProcessingSession = null;
        let timelineProgress = 1;
        let timelineDurationMs = 3000;
        let timelineMoveSeconds = 1.0;
        let lastRenderedFrameSignature = '';
        let exportCaptureForwardOnly = false;
        function getDomToImage() {
            return Promise.resolve(window.domtoimage);
        }

        function beginProcessingSession(kind, onCancel) {
            if (activeProcessingSession) return null;
            const session = {
                kind,
                cancelled: false,
                onCancel
            };
            const onKeyDown = (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                if (session.cancelled) return;
                session.cancelled = true;
                console.log(`[${kind}] cancelled via Escape`);
                try {
                    if (typeof session.onCancel === 'function') session.onCancel();
                } catch (error) {
                    console.warn(`[${kind}] cancel handler error`, error);
                }
            };
            session.detach = () => window.removeEventListener('keydown', onKeyDown, true);
            window.addEventListener('keydown', onKeyDown, true);
            activeProcessingSession = session;
            return session;
        }

        function endProcessingSession(session) {
            if (!session) return;
            if (typeof session.detach === 'function') session.detach();
            if (activeProcessingSession === session) {
                activeProcessingSession = null;
            }
        }

        function parseNumericValue(value) {
            if (value === null || value === undefined) return null;
            const text = String(value).trim();
            if (!text.length) return null;
            const n = Number(text);
            return Number.isFinite(n) ? n : null;
        }

        function computePreviewScale() {
            const maxW = Math.max(320, window.innerWidth - 20);
            const maxH = Math.max(320, window.innerHeight - 20);
            const scaleByWidth = maxW / PREVIEW_WIDTH;
            const scaleByHeight = maxH / PREVIEW_HEIGHT;
            return Math.max(0.25, Math.min(1, scaleByWidth, scaleByHeight));
        }

        function applyResponsivePreviewScale() {
            const stage = document.getElementById('preview-stage');
            if (!stage) return;
            stage.style.setProperty('--preview-scale', String(computePreviewScale()));
        }

        function hasAnimationTargets() {
            return customOrder.some((team) => {
                const end = parseNumericValue(customValues[team]);
                return end !== null;
            });
        }

        function toPingPongProgress(raw) {
            const t = Math.max(0, Math.min(1, Number(raw) || 0));
            return t <= 0.5 ? (t * 2) : ((1 - t) * 2);
        }

        function getTimelineInputProgress() {
            const control = document.getElementById('timeline-progress');
            if (!control) return timelineProgress;
            const raw = Math.max(0, Math.min(1, Number(control.value || 0) / 100));
            if (!hasAnimationTargets()) return raw;
            if (exportCaptureForwardOnly) return raw;
            return toPingPongProgress(raw);
        }

        function setTimelineProgress(progress, rerender = true, animateRows = true) {
            timelineProgress = Math.max(0, Math.min(1, Number(progress) || 0));
            const control = document.getElementById('timeline-progress');
            const label = document.getElementById('timeline-progress-label');
            if (control) control.value = String(Math.round(timelineProgress * 100));
            if (label) label.textContent = `${Math.round(timelineProgress * 100)}%`;
            if (rerender) renderCustomTeams({ animateRows });
        }

        function updateExportButtonLabel() {
            const exportBtn = document.getElementById('export-btn');
            if (!exportBtn || exportBtn.disabled) return;
            exportBtn.textContent = hasAnimationTargets() ? 'Export MP4' : 'Export PNG';
        }

        function formatDisplayValue(value, rawFallback) {
            if (value === null || value === undefined) return rawFallback || '';
            if (Math.abs(value - Math.round(value)) < 0.0001) return String(Math.round(value));
            return value.toFixed(1);
        }

        function getTimedMoveCursor(progress, moveCount) {
            const count = Math.max(0, Number(moveCount) || 0);
            if (count <= 0) {
                return { stepIndex: 0, localT: 1 };
            }
            const MOVE_SECONDS = Math.max(0.2, Number(timelineMoveSeconds) || 1);
            const STEP_HOLD_SECONDS = 1;
            const FINAL_HOLD_SECONDS = 3;
            const totalSeconds =
                (count * MOVE_SECONDS) +
                (Math.max(0, count - 1) * STEP_HOLD_SECONDS) +
                FINAL_HOLD_SECONDS;
            const elapsed = Math.max(0, Math.min(1, Number(progress) || 0)) * totalSeconds;

            let cursor = 0;
            for (let stepIndex = 0; stepIndex < count; stepIndex += 1) {
                const moveEnd = cursor + MOVE_SECONDS;
                if (elapsed < moveEnd) {
                    const localT = (elapsed - cursor) / MOVE_SECONDS;
                    return { stepIndex, localT: Math.max(0, Math.min(1, localT)) };
                }
                cursor = moveEnd;

                const isLastStep = stepIndex === count - 1;
                if (isLastStep) {
                    return { stepIndex, localT: 1 };
                }

                const holdEnd = cursor + STEP_HOLD_SECONDS;
                if (elapsed < holdEnd) {
                    return { stepIndex, localT: 1 };
                }
                cursor = holdEnd;
            }

            return { stepIndex: count - 1, localT: 1 };
        }

        function getEndpointDisplayValue(teamName, startValue, endValue, progress, moveState) {
            const startRaw = String(customStartValues[teamName] ?? '').trim();
            const endRaw = String(customValues[teamName] ?? '').trim();

            if (endValue !== null && progress >= 0.999) {
                return endRaw || formatDisplayValue(endValue, endRaw);
            }
            if (moveState) {
                const totalMoves = moveState.totalMovesByTeam.get(teamName) || 0;
                const completedMoves = moveState.completedMovesByTeam.get(teamName) || 0;
                if (endValue !== null && completedMoves > 0) {
                    return endRaw || formatDisplayValue(endValue, endRaw);
                }
                if (endValue !== null && (totalMoves === 0 || completedMoves >= totalMoves)) {
                    return endRaw || formatDisplayValue(endValue, endRaw);
                }
            }
            if (startValue !== null) {
                return startRaw || formatDisplayValue(startValue, startRaw);
            }
            if (endValue !== null) {
                return endRaw || formatDisplayValue(endValue, endRaw);
            }
            return endRaw || '';
        }

        function buildTeamDisplayState(progress) {
            const baseIndex = new Map(customOrder.map((team, idx) => [team, idx]));
            const rows = customOrder.map((teamName) => {
                const team = teamsData.find((t) => t.team === teamName);
                const start = parseNumericValue(customStartValues[teamName]);
                const end = parseNumericValue(customValues[teamName]);
                let sortValue = null;
                if (end !== null) {
                    const from = start !== null ? start : end;
                    sortValue = from + ((end - from) * progress);
                } else {
                    sortValue = parseNumericValue(customValues[teamName]);
                }
                return {
                    teamName,
                    team,
                    startValue: start,
                    endValue: end,
                    sortValue,
                    displayValue: ''
                };
            });

            if (hasAnimationTargets()) {
                const startSorted = [...rows].sort((a, b) => {
                    const av = a.startValue !== null ? a.startValue : (a.endValue !== null ? a.endValue : -Infinity);
                    const bv = b.startValue !== null ? b.startValue : (b.endValue !== null ? b.endValue : -Infinity);
                    if (bv !== av) return bv - av;
                    return (baseIndex.get(a.teamName) || 0) - (baseIndex.get(b.teamName) || 0);
                });
                const endSorted = [...rows].sort((a, b) => {
                    const av = a.endValue !== null ? a.endValue : (a.startValue !== null ? a.startValue : -Infinity);
                    const bv = b.endValue !== null ? b.endValue : (b.startValue !== null ? b.startValue : -Infinity);
                    if (bv !== av) return bv - av;
                    return (baseIndex.get(a.teamName) || 0) - (baseIndex.get(b.teamName) || 0);
                });
                const startOrder = startSorted.map((row) => row.teamName);
                const endOrder = endSorted.map((row) => row.teamName);

                // Build deterministic sequence of single-team moves from start -> end.
                const workingOrder = [...startOrder];
                const movePlan = [];
                for (let targetIdx = 0; targetIdx < endOrder.length; targetIdx += 1) {
                    const teamName = endOrder[targetIdx];
                    let currentIdx = workingOrder.indexOf(teamName);
                    if (currentIdx === -1 || currentIdx === targetIdx) continue;

                    while (currentIdx > targetIdx) {
                        movePlan.push({
                            teamName,
                            from: currentIdx,
                            to: currentIdx - 1,
                            before: [...workingOrder]
                        });
                        const temp = workingOrder[currentIdx - 1];
                        workingOrder[currentIdx - 1] = workingOrder[currentIdx];
                        workingOrder[currentIdx] = temp;
                        currentIdx -= 1;
                    }

                    while (currentIdx < targetIdx) {
                        movePlan.push({
                            teamName,
                            from: currentIdx,
                            to: currentIdx + 1,
                            before: [...workingOrder]
                        });
                        const temp = workingOrder[currentIdx + 1];
                        workingOrder[currentIdx + 1] = workingOrder[currentIdx];
                        workingOrder[currentIdx] = temp;
                        currentIdx += 1;
                    }
                }

                const moveCursor = getTimedMoveCursor(progress, movePlan.length);
                const stepIndex = Math.min(Math.max(0, moveCursor.stepIndex), Math.max(0, movePlan.length - 1));
                const localT = Math.max(0, Math.min(1, moveCursor.localT));
                const totalMovesByTeam = new Map();
                const completedMovesByTeam = new Map();
                movePlan.forEach((step, idx) => {
                    totalMovesByTeam.set(step.teamName, (totalMovesByTeam.get(step.teamName) || 0) + 1);
                    if (idx < stepIndex || (idx === stepIndex && localT >= 0.999)) {
                        completedMovesByTeam.set(step.teamName, (completedMovesByTeam.get(step.teamName) || 0) + 1);
                    }
                });
                const moveState = { totalMovesByTeam, completedMovesByTeam };

                if (!movePlan.length) {
                    rows.forEach((row) => {
                        row.rankProgress = startOrder.indexOf(row.teamName);
                        row.rankDelta = 0;
                        row.isActiveMover = false;
                        row.displayValue = getEndpointDisplayValue(
                            row.teamName,
                            row.startValue,
                            row.endValue,
                            progress,
                            moveState
                        );
                    });
                } else if (progress >= 0.999) {
                    rows.forEach((row) => {
                        row.rankProgress = endOrder.indexOf(row.teamName);
                        row.rankDelta = 0;
                        row.isActiveMover = false;
                        row.displayValue = getEndpointDisplayValue(
                            row.teamName,
                            row.startValue,
                            row.endValue,
                            progress,
                            moveState
                        );
                    });
                } else {
                    const step = movePlan[stepIndex];
                    const baseOrder = step.before;
                    const baseRank = new Map(baseOrder.map((teamName, idx) => [teamName, idx]));

                    rows.forEach((row) => {
                        row.rankProgress = baseRank.get(row.teamName) ?? (baseIndex.get(row.teamName) || 0);
                        row.rankDelta = 0;
                        row.isActiveMover = false;
                        row.displayValue = getEndpointDisplayValue(
                            row.teamName,
                            row.startValue,
                            row.endValue,
                            progress,
                            moveState
                        );
                    });

                    const movingRow = rows.find((row) => row.teamName === step.teamName);
                    if (movingRow) {
                        movingRow.rankProgress = step.from + ((step.to - step.from) * localT);
                        movingRow.rankDelta = Math.abs(step.to - step.from);
                        movingRow.isActiveMover = true;
                    }

                    // Shift affected neighbors to avoid background gaps while primary team moves.
                    if (step.from < step.to) {
                        for (let idx = step.from + 1; idx <= step.to; idx += 1) {
                            const teamName = baseOrder[idx];
                            const row = rows.find((r) => r.teamName === teamName);
                            if (!row) continue;
                            row.rankProgress = idx - localT;
                            row.rankDelta = 1;
                        }
                    } else if (step.from > step.to) {
                        for (let idx = step.to; idx < step.from; idx += 1) {
                            const teamName = baseOrder[idx];
                            const row = rows.find((r) => r.teamName === teamName);
                            if (!row) continue;
                            row.rankProgress = idx + localT;
                            row.rankDelta = 1;
                        }
                    }
                }
            } else {
                rows.forEach((row) => {
                    row.rankProgress = baseIndex.get(row.teamName) || 0;
                    row.rankDelta = 0;
                    row.isActiveMover = false;
                    row.displayValue = getEndpointDisplayValue(
                        row.teamName,
                        row.startValue,
                        row.endValue,
                        progress
                    );
                });
            }

            rows.sort((a, b) => {
                if (a.rankProgress !== b.rankProgress) return a.rankProgress - b.rankProgress;
                const av = a.sortValue === null ? -Infinity : a.sortValue;
                const bv = b.sortValue === null ? -Infinity : b.sortValue;
                if (bv !== av) return bv - av;
                return (baseIndex.get(a.teamName) || 0) - (baseIndex.get(b.teamName) || 0);
            });
            return rows;
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
            if (node.id === 'export-progress-overlay') return false;
            if (node.id === 'export-top-progress') return false;
            if (node.classList.contains('controls')) return false;
            if (node.closest('.controls')) return false;
            if (node.closest('#history-controls')) return false;
            if (node.closest('#custom-panel')) return false;
            if (node.closest('#custom-overlay')) return false;
            if (node.closest('#export-progress-overlay')) return false;
            if (node.closest('#export-top-progress')) return false;
            return true;
        }

        function getExportDisplayUrl() {
            if (IS_LOCALHOST) return 'https://nfl.rprtd.app';
            const { protocol, host, pathname } = window.location;
            const raw = `${protocol}//${host}${pathname || '/'}`;
            return raw.replace(/\/+$/, '');
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
                startValues: { ...customStartValues },
                values: { ...customValues },
                timelineProgress,
                timelineDurationMs,
                timelineMoveSeconds,
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
            customStartValues = {};
            customValues = {};
            timelineProgress = 1;
            timelineDurationMs = 3000;
            timelineMoveSeconds = 1.0;
            selectedLogoUrl = defaultStation.url;
            selectedHeaderColors = normalizeColorPair(defaultStation.color);
            document.getElementById('custom-title').value = '';
            document.getElementById('custom-subtitle').value = `In the ${getDivisionLabel()}`;

            if (saved) {
                document.getElementById('custom-title').value = saved.title || '';
                document.getElementById('custom-subtitle').value = saved.subtitle || `In the ${getDivisionLabel()}`;
                customOrder = saved.order && saved.order.length ? [...saved.order] : customOrder;
                customStartValues = saved.startValues ? { ...saved.startValues } : {};
                customValues = saved.values ? { ...saved.values } : {};
                timelineProgress = typeof saved.timelineProgress === 'number' ? saved.timelineProgress : timelineProgress;
                timelineDurationMs = typeof saved.timelineDurationMs === 'number' ? saved.timelineDurationMs : timelineDurationMs;
                timelineMoveSeconds = typeof saved.timelineMoveSeconds === 'number' ? saved.timelineMoveSeconds : timelineMoveSeconds;
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
            setTimelineProgress(timelineProgress, false);
            const durationControl = document.getElementById('timeline-duration-ms');
            if (durationControl) durationControl.value = String(timelineDurationMs);
            const moveSecondsControl = document.getElementById('timeline-move-seconds');
            if (moveSecondsControl) moveSecondsControl.value = String(timelineMoveSeconds);
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

            lastRenderedFrameSignature = '';
            previewStationConfig = station;
            const previewColors = normalizeColorPair(station.color || selectedHeaderColors.join(','));
            const readableColors = getReadableHeaderColors(previewColors);
            networkLogo.src = withLocalNoCache(station.url);
            networkLogo.alt = `${station.label || getDivisionLabel()} Network Logo`;
            refreshLogoContrastBackground(station.url, previewColors[0]);
            header.style.background = `linear-gradient(135deg, ${readableColors[0]} 0%, ${readableColors[1]} 100%)`;
        }

        function restoreStationPreview() {
            lastRenderedFrameSignature = '';
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

            setTimelineProgress(timelineProgress, false);
            const durationControl = document.getElementById('timeline-duration-ms');
            if (durationControl) durationControl.value = String(timelineDurationMs);
            const moveSecondsControl = document.getElementById('timeline-move-seconds');
            if (moveSecondsControl) moveSecondsControl.value = String(timelineMoveSeconds);
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

                const startInput = document.createElement('input');
                startInput.type = 'text';
                startInput.className = 'team-value-input';
                startInput.placeholder = 'Start';
                startInput.value = customStartValues[teamName] || '';
                startInput.addEventListener('input', (event) => {
                    customStartValues[teamName] = event.target.value;
                    persistCurrentDivisionState();
                    saveSettingsToStorage();
                    updateExportButtonLabel();
                    renderCustomTeams();
                });

                const endInput = document.createElement('input');
                endInput.type = 'text';
                endInput.className = 'team-value-input';
                endInput.placeholder = 'End';
                endInput.value = customValues[teamName] || '';
                endInput.addEventListener('input', (event) => {
                    customValues[teamName] = event.target.value;
                    persistCurrentDivisionState();
                    saveSettingsToStorage();
                    updateExportButtonLabel();
                    renderCustomTeams();
                });

                row.appendChild(handle);
                row.appendChild(name);
                row.appendChild(startInput);
                row.appendChild(endInput);
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
            updateExportButtonLabel();
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

        function renderCustomTeams({ animateRows = true } = {}) {
            const title = document.getElementById('custom-title').value || 'NFL Meme War';
            const subtitle = document.getElementById('custom-subtitle').value || `In the ${getDivisionLabel()}`;
            const logoUrl = getSelectedLogoUrl();
            const progress = getTimelineInputProgress();
            const readableColors = getReadableHeaderColors(selectedHeaderColors);
            const rows = teamsData.length ? buildTeamDisplayState(progress) : [];
            const frameSignature = `${title}||${subtitle}||${logoUrl}||${readableColors[0]},${readableColors[1]}||${
                rows.map((row) => `${row.teamName}:${Math.round((row.rankProgress || 0) * 1000)}:${row.displayValue || ''}`).join('|')
            }`;
            if (frameSignature === lastRenderedFrameSignature) {
                return;
            }
            lastRenderedFrameSignature = frameSignature;

            document.getElementById('page-title').textContent = title;
            document.getElementById('page-subtitle').textContent = subtitle;
            const networkLogo = document.getElementById('network-logo');
            networkLogo.src = withLocalNoCache(logoUrl);
            networkLogo.alt = `${getDivisionLabel()} Network Logo`;
            refreshLogoContrastBackground(logoUrl, selectedHeaderColors[0]);
            document.querySelector('.header').style.background =
                `linear-gradient(135deg, ${readableColors[0]} 0%, ${readableColors[1]} 100%)`;

            const container = document.getElementById('teams-container');
            container.style.position = 'relative';
            container.style.display = 'block';

            if (!teamsData.length) {
                container.innerHTML = '<div style="color: white; text-align: center; padding: 50px;">No team data found for this division</div>';
                return;
            }

            const existingRows = new Map();
            container.querySelectorAll('.team-row').forEach((row) => {
                if (row.dataset.team) existingRows.set(row.dataset.team, row);
            });
            const containerHeight = Math.max(1, container.clientHeight || container.getBoundingClientRect().height || 1200);
            const rowHeight = containerHeight / Math.max(1, rows.length);
            const keepTeams = new Set(rows.map((r) => r.teamName));

            rows.forEach((rowData, index) => {
                const team = rowData.team;
                if (!team) return;

                let row = existingRows.get(rowData.teamName);
                let logo;
                let points;
                if (!row) {
                    row = document.createElement('div');
                    row.className = 'team-row';
                    row.dataset.team = rowData.teamName;

                    logo = document.createElement('img');
                    logo.crossOrigin = 'anonymous';
                    logo.className = 'team-logo';
                    row.appendChild(logo);

                    points = document.createElement('div');
                    points.className = 'points';
                    row.appendChild(points);
                } else {
                    row.dataset.team = rowData.teamName;
                    logo = row.querySelector('.team-logo');
                    points = row.querySelector('.points');
                }

                row.style.backgroundColor = team.color;
                row.style.position = 'absolute';
                row.style.left = '0';
                row.style.right = '0';
                row.style.width = '100%';
                row.style.height = `${rowHeight}px`;
                row.style.flex = 'none';
                const isMovingRank = !!rowData.isActiveMover;
                const movingBoost = isMovingRank ? 1000000 : 0;
                const rankLayer = (rows.length * 1000) - Math.round((rowData.rankProgress || index) * 1000);
                row.style.zIndex = String(movingBoost + rankLayer);
                row.style.transition = animateRows ? 'top 220ms linear' : 'none';
                row.style.top = `${(rowData.rankProgress || index) * rowHeight}px`;
                logo.src = withLocalNoCache(team.logo);
                logo.alt = `${team.team} Logo`;
                points.style.fontSize = '';
                const val = rowData.displayValue || '';
                if (val.length > 10) {
                    points.style.fontSize = '60px';
                } else if (val.length > 6) {
                    points.style.fontSize = '80px';
                }
                points.textContent = val;
                container.appendChild(row);
            });

            container.querySelectorAll('.team-row').forEach((row) => {
                if (!keepTeams.has(row.dataset.team)) {
                    row.remove();
                }
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
                updateExportButtonLabel();
            });
        }

        function lockExportUI(exportModeLabel) {
            const exportBtn = document.getElementById('export-btn');
            const controls = document.querySelector('.controls');
            const historyControls = document.getElementById('history-controls');
            const historyPopover = document.getElementById('history-popover');
            const containerElement = document.querySelector('.container');
            if (!controls || !containerElement || !exportBtn) {
                throw new Error('Missing export UI refs');
            }

            const prevControlsDisplay = controls.style.display;
            const prevHistoryControlsDisplay = historyControls ? historyControls.style.display : '';
            const wasHistoryPopoverVisible = !!historyPopover && historyPopover.classList.contains('visible');
            const prevContainerPosition = containerElement.style.position;
            const previewStage = document.getElementById('preview-stage');
            const prevPreviewScale = previewStage ? (previewStage.style.getPropertyValue('--preview-scale') || '') : '';

            controls.style.display = 'none';
            if (historyControls) historyControls.style.display = 'none';
            if (historyPopover) historyPopover.classList.remove('visible');
            if (previewStage) {
                previewStage.style.setProperty('--preview-scale', '1');
            }

            containerElement.style.position = 'relative';
            const exportUrlBadge = document.createElement('div');
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

            const exportProgressOverlay = document.createElement('div');
            exportProgressOverlay.id = 'export-progress-overlay';
            exportProgressOverlay.style.position = 'absolute';
            exportProgressOverlay.style.left = '50%';
            exportProgressOverlay.style.bottom = '64px';
            exportProgressOverlay.style.transform = 'translateX(-50%)';
            exportProgressOverlay.style.width = '420px';
            exportProgressOverlay.style.maxWidth = '80%';
            exportProgressOverlay.style.display = 'none';
            exportProgressOverlay.style.padding = '10px 12px';
            exportProgressOverlay.style.borderRadius = '10px';
            exportProgressOverlay.style.background = 'rgba(0,0,0,0.55)';
            exportProgressOverlay.style.backdropFilter = 'blur(3px)';
            exportProgressOverlay.style.pointerEvents = 'none';
            exportProgressOverlay.style.zIndex = '10000';

            const exportProgressLabel = document.createElement('div');
            exportProgressLabel.textContent = 'Encoding 0%';
            exportProgressLabel.style.color = 'rgba(255,255,255,0.95)';
            exportProgressLabel.style.fontFamily = 'Arial Black, Arial, sans-serif';
            exportProgressLabel.style.fontSize = '18px';
            exportProgressLabel.style.textAlign = 'center';
            exportProgressLabel.style.marginBottom = '8px';

            const exportProgressTrack = document.createElement('div');
            exportProgressTrack.style.height = '10px';
            exportProgressTrack.style.width = '100%';
            exportProgressTrack.style.background = 'rgba(255,255,255,0.2)';
            exportProgressTrack.style.borderRadius = '999px';
            exportProgressTrack.style.overflow = 'hidden';

            const exportProgressFill = document.createElement('div');
            exportProgressFill.style.height = '100%';
            exportProgressFill.style.width = '0%';
            exportProgressFill.style.borderRadius = '999px';
            exportProgressFill.style.background = 'linear-gradient(90deg, #38bdf8 0%, #60a5fa 100%)';
            exportProgressTrack.appendChild(exportProgressFill);

            exportProgressOverlay.appendChild(exportProgressLabel);
            exportProgressOverlay.appendChild(exportProgressTrack);
            containerElement.appendChild(exportProgressOverlay);

            const exportTopProgress = document.createElement('div');
            exportTopProgress.id = 'export-top-progress';
            exportTopProgress.style.position = 'absolute';
            exportTopProgress.style.top = '14px';
            exportTopProgress.style.left = '50%';
            exportTopProgress.style.transform = 'translateX(-50%)';
            exportTopProgress.style.padding = '8px 12px';
            exportTopProgress.style.borderRadius = '9px';
            exportTopProgress.style.background = 'rgba(0,0,0,0.48)';
            exportTopProgress.style.color = 'rgba(255,255,255,0.96)';
            exportTopProgress.style.fontFamily = 'Arial Black, Arial, sans-serif';
            exportTopProgress.style.fontSize = '18px';
            exportTopProgress.style.letterSpacing = '0.4px';
            exportTopProgress.style.textAlign = 'center';
            exportTopProgress.style.pointerEvents = 'none';
            exportTopProgress.style.zIndex = '10001';
            exportTopProgress.style.display = 'none';
            exportTopProgress.textContent = 'Preparing 0%';
            containerElement.appendChild(exportTopProgress);

            exportBtn.textContent = exportModeLabel;
            exportBtn.disabled = true;

            let restored = false;
            const setEncodingProgress = (percent = 0, stageLabel = 'Encoding') => {
                const p = Math.max(0, Math.min(100, Number(percent) || 0));
                exportProgressOverlay.style.display = 'block';
                exportProgressLabel.textContent = `${stageLabel} ${p}%`;
                exportProgressFill.style.width = `${p}%`;
                exportTopProgress.style.display = 'block';
                exportTopProgress.textContent = `${stageLabel} ${p}%`;
            };
            const hideEncodingProgress = () => {
                exportProgressOverlay.style.display = 'none';
                exportTopProgress.style.display = 'none';
            };

            const restore = () => {
                if (restored) return;
                restored = true;
                if (exportUrlBadge && exportUrlBadge.parentNode) {
                    exportUrlBadge.parentNode.removeChild(exportUrlBadge);
                }
                if (exportProgressOverlay && exportProgressOverlay.parentNode) {
                    exportProgressOverlay.parentNode.removeChild(exportProgressOverlay);
                }
                if (exportTopProgress && exportTopProgress.parentNode) {
                    exportTopProgress.parentNode.removeChild(exportTopProgress);
                }
                if (previewStage) {
                    if (prevPreviewScale) {
                        previewStage.style.setProperty('--preview-scale', prevPreviewScale);
                    } else {
                        previewStage.style.removeProperty('--preview-scale');
                    }
                    applyResponsivePreviewScale();
                }
                containerElement.style.position = prevContainerPosition;
                controls.style.display = prevControlsDisplay || 'flex';
                if (historyControls) historyControls.style.display = prevHistoryControlsDisplay;
                if (historyPopover && wasHistoryPopoverVisible) historyPopover.classList.add('visible');
                exportBtn.disabled = false;
                updateExportButtonLabel();
            };

            return { containerElement, restore, setEncodingProgress, hideEncodingProgress };
        }

        function downloadDataUrl(filename, dataUrl) {
            const link = document.createElement('a');
            link.download = filename;
            link.href = dataUrl;
            link.click();
        }

        function buildExportFilename(ext) {
            const now = new Date();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const year = String(now.getFullYear()).slice(-2);
            return `${selectedConference}${selectedDivision}Meme-${month}-${day}-${year}.${ext}`;
        }

        function setExportProgressTitle(percentText, suffix = 'Exporting MP4') {
            document.title = `NFL Meme War • ${suffix} ${percentText}`;
        }

        function restoreTitleAfterExport() {
            document.title = 'NFL Meme War';
        }

        function describeMp4Error(error, stage) {
            if (!error) return { stage, summary: 'Unknown MP4 error' };
            if (error instanceof Error) {
                return {
                    stage,
                    summary: error.message || 'Error',
                    name: error.name || 'Error',
                    stack: error.stack || null
                };
            }
            if (error instanceof Event) {
                return {
                    stage,
                    summary: `Event error: ${error.type || 'unknown'}`,
                    isTrusted: !!error.isTrusted
                };
            }
            if (typeof error === 'object') {
                return { stage, summary: 'Object error', ...error };
            }
            return { stage, summary: String(error) };
        }

        function createFfmpegWorker() {
            return new Worker(new URL('./ffmpeg-worker.js', import.meta.url), { type: 'module' });
        }

        async function exportToMP4() {
            console.log('[mp4] clicked');
            if (activeProcessingSession) {
                console.warn('[mp4] ignored: another processing task is active', { kind: activeProcessingSession.kind });
                return;
            }
            const ui = lockExportUI('Exporting MP4...');
            const previousProgress = timelineProgress;
            const session = beginProcessingSession('mp4', () => {
                ui.restore();
                setTimelineProgress(previousProgress, true);
                restoreTitleAfterExport();
            });
            if (!session) {
                ui.restore();
                return;
            }

            let mp4Stage = 'init';
            try {
                mp4Stage = 'preflight';
                normalizeExportImageSources(ui.containerElement);
                await preflightExportImages(ui.containerElement);
                if (session.cancelled) return;

                const fps = 30;
                const durationSec = Math.max(0.5, Number(timelineDurationMs || 3000) / 1000);
                const totalFrameCount = Math.max(2, Math.round(durationSec * fps));
                const frameCount = Math.max(2, Math.ceil(totalFrameCount / 2));
                const worker = createFfmpegWorker();
                let lastLoggedPercent = -1;
                console.log('[mp4] worker created', { fps, frameCount, totalFrameCount, durationSec });

                let encodeResolve = null;
                let encodeReject = null;
                const waitForReady = new Promise((resolve, reject) => {
                    const READY_TIMEOUT_MS = 180000;
                    const timeout = setTimeout(() => {
                        reject(new Error(`ffmpeg worker ready timeout after ${READY_TIMEOUT_MS}ms`));
                    }, READY_TIMEOUT_MS);
                    worker.onmessage = (event) => {
                        const data = event.data || {};
                        if (data.type === 'status') {
                            console.log('[mp4] worker status', data.stage);
                            return;
                        }
                        if (data.type === 'ready') {
                            clearTimeout(timeout);
                            console.log('[mp4] ffmpeg worker ready');
                            resolve();
                            return;
                        }
                        if (data.type === 'error') {
                            clearTimeout(timeout);
                            reject(new Error(data.message || 'ffmpeg worker init error'));
                        }
                    };
                    worker.onerror = (err) => {
                        clearTimeout(timeout);
                        reject(err instanceof Error ? err : new Error('ffmpeg worker runtime error'));
                    };
                });

                const encodedPromise = new Promise((resolve, reject) => {
                    encodeResolve = resolve;
                    encodeReject = reject;
                });

                worker.postMessage({ type: 'init', fps });
                setExportProgressTitle('0%', 'Preparing');
                ui.setEncodingProgress(0, 'Preparing');
                mp4Stage = 'worker-ready';
                await waitForReady;
                worker.onmessage = (event) => {
                    const data = event.data || {};
                    if (data.type === 'status') {
                        console.log('[mp4] worker status', data.stage);
                        return;
                    }
                    if (data.type === 'progress') {
                        const p = Math.max(0, Math.min(100, Math.round((Number(data.progress) || 0) * 100)));
                        if (p !== lastLoggedPercent) {
                            lastLoggedPercent = p;
                            console.log(`[mp4] encode progress ${p}%`);
                        }
                        setExportProgressTitle(`${p}%`, 'Encoding');
                        ui.setEncodingProgress(p, 'Encoding');
                        return;
                    }
                    if (data.type === 'done') {
                        console.log('[mp4] encode done');
                        if (encodeResolve) encodeResolve(data.buffer);
                        return;
                    }
                    if (data.type === 'error') {
                        console.error('[mp4] worker error', data);
                        if (encodeReject) encodeReject(new Error(data.message || 'ffmpeg worker error'));
                    }
                };
                worker.onerror = (err) => {
                    console.error('[mp4] worker onerror', err);
                    if (encodeReject) encodeReject(err instanceof Error ? err : new Error('ffmpeg worker runtime error'));
                };

                exportCaptureForwardOnly = true;
                for (let i = 0; i < frameCount; i += 1) {
                    if (session.cancelled) break;
                    mp4Stage = `capture-frame-${i + 1}`;
                    const progress = frameCount <= 1 ? 1 : i / (frameCount - 1);
                    const capturePercent = Math.round(((i + 1) / frameCount) * 100);
                    if (capturePercent !== lastLoggedPercent) {
                        lastLoggedPercent = capturePercent;
                        console.log(`[mp4] frame capture ${capturePercent}% (${i + 1}/${frameCount})`);
                    }
                    setExportProgressTitle(`${capturePercent}%`, 'Capturing');
                    ui.setEncodingProgress(capturePercent, 'Capturing');
                    setTimelineProgress(progress, true, false);
                    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
                    const blob = await window.domtoimage.toBlob(ui.containerElement, {
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
                    const buffer = await blob.arrayBuffer();
                    worker.postMessage({ type: 'frame', index: i, buffer }, [buffer]);
                }
                exportCaptureForwardOnly = false;

                if (!session.cancelled) {
                    setExportProgressTitle('0%', 'Encoding');
                    ui.setEncodingProgress(0, 'Encoding');
                    console.log('[mp4] starting encode');
                    mp4Stage = 'encode';
                    worker.postMessage({ type: 'encode', fps });
                    const outBuffer = await Promise.race([
                        encodedPromise,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('encode timeout')), 120000))
                    ]);
                    mp4Stage = 'finalize-download';
                    const blob = new Blob([outBuffer], { type: 'video/mp4' });
                    const dataUrl = URL.createObjectURL(blob);
                    const filename = buildExportFilename('mp4');
                    downloadDataUrl(filename, dataUrl);
                    console.log('[mp4] download triggered', { filename });
                    ui.hideEncodingProgress();
                    setTimeout(() => URL.revokeObjectURL(dataUrl), 2000);
                }
                worker.terminate();
            } catch (error) {
                if (!session.cancelled) {
                    const details = describeMp4Error(error, mp4Stage || 'unknown');
                    window.lastMp4Error = details;
                    console.error('[mp4] failed', details);
                    alert('Error exporting MP4. Please try again.');
                }
            } finally {
                exportCaptureForwardOnly = false;
                setTimelineProgress(previousProgress, true, false);
                ui.restore();
                endProcessingSession(session);
                restoreTitleAfterExport();
            }
        }

        function handleExportClick() {
            if (hasAnimationTargets()) {
                exportToMP4();
                return;
            }
            exportToPNG();
        }

        function exportToPNG() {
            console.log('[export] clicked');
            if (activeProcessingSession) {
                console.warn('[export] ignored: another processing task is active', { kind: activeProcessingSession.kind });
                return;
            }
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
            const previewStage = document.getElementById('preview-stage');
            const prevPreviewScale = previewStage ? (previewStage.style.getPropertyValue('--preview-scale') || '') : '';
            let exportUrlBadge = null;
            let uiRestored = false;
            const restoreUI = () => {
                if (uiRestored) return;
                uiRestored = true;
                if (exportUrlBadge && exportUrlBadge.parentNode) {
                    exportUrlBadge.parentNode.removeChild(exportUrlBadge);
                }
                if (previewStage) {
                    if (prevPreviewScale) {
                        previewStage.style.setProperty('--preview-scale', prevPreviewScale);
                    } else {
                        previewStage.style.removeProperty('--preview-scale');
                    }
                    applyResponsivePreviewScale();
                }
                containerElement.style.position = prevContainerPosition;
                controls.style.display = prevControlsDisplay || 'flex';
                if (historyControls) {
                    historyControls.style.display = prevHistoryControlsDisplay;
                }
                if (historyPopover && wasHistoryPopoverVisible) {
                    historyPopover.classList.add('visible');
                }
                exportBtn.disabled = false;
                updateExportButtonLabel();
            };

            controls.style.display = 'none';
            if (historyControls) {
                historyControls.style.display = 'none';
            }
            if (historyPopover) {
                historyPopover.classList.remove('visible');
            }
            if (previewStage) {
                previewStage.style.setProperty('--preview-scale', '1');
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

            const session = beginProcessingSession('export', () => {
                restoreUI();
            });
            if (!session) {
                restoreUI();
                return;
            }

            {
                setTimeout(() => {
                    if (session.cancelled) {
                        console.log('[export] aborted before preprocessing');
                        endProcessingSession(session);
                        return;
                    }
                    console.log('[export] normalize sources start');
                    normalizeExportImageSources(containerElement);
                    console.log('[export] normalize sources done');
                    preflightExportImages(containerElement)
                    .then(() => {
                    if (session.cancelled) return null;
                    console.log('[export] loading dom-to-image');
                    getDomToImage()
                    .then((domtoimage) => {
                        if (session.cancelled) return null;
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
                        if (session.cancelled || !dataUrl) {
                            console.log('[export] skipped download because export was cancelled');
                            return;
                        }
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
                        if (session.cancelled) {
                            console.log('[export] caught error after cancellation; ignoring', error);
                            return;
                        }
                        const details = describeExportError(error);
                        window.lastExportError = details;
                        console.error('[export] failed', details);
                        alert('Error exporting image. Please try again.');
                    })
                    .finally(() => {
                        console.log('[export] finally restore ui');
                        restoreUI();
                        endProcessingSession(session);
                        console.log('[export] done');
                    });
                    })
                    .catch((error) => {
                        if (session.cancelled) {
                            console.log('[export] preflight stopped after cancellation');
                            endProcessingSession(session);
                            return;
                        }
                        console.error('[export] preflight failed', error);
                        restoreUI();
                        endProcessingSession(session);
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
                document.getElementById('timeline-progress').addEventListener('input', (event) => {
                    setTimelineProgress(Number(event.target.value) / 100, true, false);
                    persistCurrentDivisionState();
                    saveSettingsToStorage();
                });
                document.getElementById('timeline-duration-ms').addEventListener('input', (event) => {
                    timelineDurationMs = Math.max(500, Number(event.target.value) || 3000);
                    persistCurrentDivisionState();
                    saveSettingsToStorage();
                });
                document.getElementById('timeline-move-seconds').addEventListener('input', (event) => {
                    timelineMoveSeconds = Math.max(0.2, Math.min(5, Number(event.target.value) || 1));
                    persistCurrentDivisionState();
                    saveSettingsToStorage();
                    renderCustomTeams({ animateRows: false });
                });
                document.getElementById('custom-apply-btn').addEventListener('click', applyCustom);
                document.getElementById('custom-overlay').addEventListener('click', closeCustomPanel);
                document.getElementById('edit-btn').addEventListener('click', openCustomPanel);
                document.getElementById('export-btn').addEventListener('click', handleExportClick);
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
                applyResponsivePreviewScale();
                window.addEventListener('resize', applyResponsivePreviewScale);

                loadDivisionData().then(() => {
                    saveSettingsToStorage();
                    updateExportButtonLabel();
                });
            })
            .catch(error => {
                console.error('Error loading data:', error);
                document.getElementById('teams-container').innerHTML =
                    '<div style="color: white; text-align: center; padding: 50px;">Error loading data</div>';
            });
