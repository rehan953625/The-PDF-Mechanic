/*
 * Photo Quality Enhancer — The PDF Mechanic
 * 100% client-side. Two distinct, honestly-labeled operations:
 *   - Upscale (2x / 4x): a real AI super-resolution model (Swin2SR, via
 *     transformers.js), loaded lazily and run in a Web Worker, tiled to
 *     keep memory bounded.
 *   - Enhancement (Sharpness / Noise Reduction / Contrast / Brightness /
 *     Saturation): ordinary, non-AI pixel-level adjustments, run in the
 *     same worker so neither blocks the main thread.
 * Nothing here ever sends image data anywhere; everything runs locally.
 */
(function () {
    'use strict';

    const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB, per the UI's stated limit
    const MAX_DIMENSION = 3000; // long-edge cap before any processing, to protect memory
    const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    const TILE_SIZE = 176;
    const TILE_OVERLAP = 16;
    const MODEL_2X = 'Xenova/swin2SR-lightweight-x2-64';
    const MODEL_4X = 'onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr-ONNX';

    const state = {
        file: null,
        workingWidth: 0,
        workingHeight: 0,
        workingRgba: null,      // Uint8ClampedArray, canonical (possibly capped) source pixels
        cappedForProcessing: false,
        upscale: 1,
        sliders: { sharpness: 0, denoise: 0, contrast: 0, brightness: 0, saturation: 0 },
        busy: false,
        worker: null,
        enhancedBlobUrl: null,
        enhancedWidth: 0,
        enhancedHeight: 0,
        enhancedCanvas: null,   // OffscreenCanvas holding the final enhanced pixels
        beforeUrl: null,
        format: 'jpeg',
        quality: 0.9,
        comparePct: 50,
        zoomScale: 1
    };

    // ---------------- DOM shortcuts ----------------
    const $ = (id) => document.getElementById(id);

    function showFileError(message) {
        $('fileErrorText').textContent = message;
        $('fileError').classList.remove('hidden');
    }
    function hideFileError() {
        $('fileError').classList.add('hidden');
    }
    // OffscreenCanvas.convertToBlob() needs Safari 16.4+; on anything older
    // (and everywhere else it's unsupported) fall back to a regular <canvas>
    // element's toBlob(), which has been supported far longer.
    async function canvasToBlobCompat(offscreenCanvas, mime, quality) {
        if (typeof offscreenCanvas.convertToBlob === 'function') {
            return quality === undefined
                ? offscreenCanvas.convertToBlob({ type: mime })
                : offscreenCanvas.convertToBlob({ type: mime, quality });
        }
        const el = document.createElement('canvas');
        el.width = offscreenCanvas.width;
        el.height = offscreenCanvas.height;
        el.getContext('2d').drawImage(offscreenCanvas, 0, 0);
        return new Promise((resolve, reject) => {
            el.toBlob((blob) => blob ? resolve(blob) : reject(new Error('toBlob failed')), mime, quality);
        });
    }

    function humanSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    // ---------------- File handling ----------------
    function handleFileSelect(event) {
        const file = event.target.files[0];
        if (file) loadFile(file);
    }
    function handleDrop(event) {
        event.preventDefault();
        $('uploadArea').classList.remove('drag-active');
        const file = event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) loadFile(file);
    }

    async function loadFile(file) {
        hideFileError();

        const looksSupported = ACCEPTED_TYPES.includes(file.type) ||
            /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
        if (!looksSupported) {
            showFileError(`"${file.name}" isn't a supported image type. Please choose a JPG, PNG or WebP file.`);
            return;
        }
        if (file.size > MAX_FILE_SIZE) {
            showFileError(`"${file.name}" is ${humanSize(file.size)}, which is over the 25MB limit. Try a smaller photo.`);
            return;
        }

        let bitmap;
        try {
            bitmap = await createImageBitmap(file);
        } catch (err) {
            console.error(err);
            if (/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) {
                showFileError('This looks like a HEIC/HEIF photo, and your browser can\'t decode that format here. Please convert it to JPG first, or use a browser with native HEIC support.');
            } else {
                showFileError(`"${file.name}" couldn't be opened. It may be corrupted or not a valid image file.`);
            }
            return;
        }

        let width = bitmap.width, height = bitmap.height;
        if (!width || !height) {
            showFileError('This image has no readable dimensions. Please try a different file.');
            bitmap.close && bitmap.close();
            return;
        }

        let cappedForProcessing = false;
        let workW = width, workH = height;
        const longEdge = Math.max(width, height);
        if (longEdge > MAX_DIMENSION) {
            const scale = MAX_DIMENSION / longEdge;
            workW = Math.round(width * scale);
            workH = Math.round(height * scale);
            cappedForProcessing = true;
        }

        const canvas = document.createElement('canvas');
        canvas.width = workW; canvas.height = workH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, workW, workH);
        bitmap.close && bitmap.close();

        let imageData;
        try {
            imageData = ctx.getImageData(0, 0, workW, workH);
        } catch (err) {
            console.error(err);
            showFileError('This photo is too large for your browser to process safely. Try a smaller image.');
            return;
        }

        // Reset previous state
        resetResultOnly();

        state.file = file;
        state.workingWidth = workW;
        state.workingHeight = workH;
        state.workingRgba = imageData.data;
        state.cappedForProcessing = cappedForProcessing;

        if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
        state.beforeUrl = URL.createObjectURL(file);

        $('sourceThumb').src = state.beforeUrl;
        $('fileName').textContent = file.name;
        const metaBits = [`${width}×${height}px`, humanSize(file.size)];
        if (cappedForProcessing) metaBits.push(`processing at ${workW}×${workH}px`);
        $('fileMeta').textContent = metaBits.join(' · ');

        $('uploadArea').classList.add('hidden');
        $('uploadArea').classList.remove('drag-active');
        $('settingsArea').classList.remove('hidden');
        $('resultArea').classList.add('hidden');
    }

    // ---------------- Controls: upscale pills ----------------
    function selectUpscale(pill) {
        document.querySelectorAll('#upscaleGroup .upscale-pill').forEach(p => {
            p.classList.remove('active');
            p.setAttribute('aria-checked', 'false');
        });
        pill.classList.add('active');
        pill.setAttribute('aria-checked', 'true');
        state.upscale = parseInt(pill.dataset.value, 10);
    }
    function wirePillGroup(selector, onSelect) {
        document.querySelectorAll(selector).forEach(pill => {
            pill.addEventListener('click', () => onSelect(pill));
            pill.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(pill);
                }
            });
        });
    }

    // ---------------- Controls: sliders ----------------
    const SLIDER_IDS = ['sharpness', 'denoise', 'contrast', 'brightness', 'saturation'];
    function wireSliders() {
        SLIDER_IDS.forEach(name => {
            const input = $(name + 'Range');
            const label = $(name + 'Value');
            input.addEventListener('input', () => {
                state.sliders[name] = parseInt(input.value, 10);
                label.textContent = input.value;
            });
        });
    }
    function setSliders(values) {
        SLIDER_IDS.forEach(name => {
            const v = values[name] != null ? values[name] : 0;
            state.sliders[name] = v;
            $(name + 'Range').value = v;
            $(name + 'Value').textContent = v;
        });
    }

    // ---------------- Worker ----------------
    function ensureWorker() {
        if (state.worker) return state.worker;
        state.worker = createEnhanceWorker();
        return state.worker;
    }
    function terminateWorker() {
        if (state.worker) {
            state.worker.terminate();
            state.worker = null;
        }
    }

    function createEnhanceWorker() {
        const workerSource = `
            import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
            env.backends.onnx.wasm.numThreads = 1;

            const MODEL_2X = ${JSON.stringify(MODEL_2X)};
            const MODEL_4X = ${JSON.stringify(MODEL_4X)};
            const TILE_SIZE = ${TILE_SIZE};
            const TILE_OVERLAP = ${TILE_OVERLAP};

            let upscalers = {}; // cached pipelines keyed by model id
            let cancelled = false;
            let chosenDevice = 'wasm';

            async function detectDevice() {
                try {
                    if (typeof navigator !== 'undefined' && navigator.gpu) {
                        const adapter = await navigator.gpu.requestAdapter();
                        if (adapter) return 'webgpu';
                    }
                } catch (e) { /* fall through to wasm */ }
                return 'wasm';
            }

            async function ensureUpscaler(modelId, onProgress) {
                if (upscalers[modelId]) return upscalers[modelId];
                const pipe = await pipeline('image-to-image', modelId, {
                    dtype: 'fp32',
                    device: chosenDevice,
                    progress_callback: onProgress
                });
                upscalers[modelId] = pipe;
                return pipe;
            }

            // ---- Classical pixel-level adjustments (non-AI) ----
            // All of these operate in place on an RGBA Uint8ClampedArray and
            // never touch the alpha channel, so transparency survives.

            function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

            function boxBlur(src, width, height, radius) {
                if (radius <= 0) return src.slice();
                const out = new Uint8ClampedArray(src.length);
                const tmp = new Float32Array(src.length);
                // horizontal pass
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        let r = 0, g = 0, b = 0, count = 0;
                        for (let k = -radius; k <= radius; k++) {
                            const xx = x + k;
                            if (xx < 0 || xx >= width) continue;
                            const idx = (y * width + xx) * 4;
                            r += src[idx]; g += src[idx + 1]; b += src[idx + 2]; count++;
                        }
                        const idx = (y * width + x) * 4;
                        tmp[idx] = r / count; tmp[idx + 1] = g / count; tmp[idx + 2] = b / count;
                    }
                }
                // vertical pass
                for (let x = 0; x < width; x++) {
                    for (let y = 0; y < height; y++) {
                        let r = 0, g = 0, b = 0, count = 0;
                        for (let k = -radius; k <= radius; k++) {
                            const yy = y + k;
                            if (yy < 0 || yy >= height) continue;
                            const idx = (yy * width + x) * 4;
                            r += tmp[idx]; g += tmp[idx + 1]; b += tmp[idx + 2]; count++;
                        }
                        const idx = (y * width + x) * 4;
                        out[idx] = r / count; out[idx + 1] = g / count; out[idx + 2] = b / count;
                        out[idx + 3] = src[idx + 3];
                    }
                }
                return out;
            }

            function applyDenoise(rgba, width, height, amount) {
                if (amount <= 0) return rgba;
                const radius = Math.max(1, Math.round((amount / 100) * 3));
                const blurred = boxBlur(rgba, width, height, radius);
                const mix = amount / 100;
                for (let i = 0; i < rgba.length; i += 4) {
                    rgba[i] = clamp255(rgba[i] * (1 - mix) + blurred[i] * mix);
                    rgba[i + 1] = clamp255(rgba[i + 1] * (1 - mix) + blurred[i + 1] * mix);
                    rgba[i + 2] = clamp255(rgba[i + 2] * (1 - mix) + blurred[i + 2] * mix);
                }
                return rgba;
            }

            function applySharpen(rgba, width, height, amount) {
                if (amount <= 0) return rgba;
                const blurred = boxBlur(rgba, width, height, 1);
                const strength = amount / 100 * 1.5; // unsharp-mask amount
                for (let i = 0; i < rgba.length; i += 4) {
                    rgba[i] = clamp255(rgba[i] + (rgba[i] - blurred[i]) * strength);
                    rgba[i + 1] = clamp255(rgba[i + 1] + (rgba[i + 1] - blurred[i + 1]) * strength);
                    rgba[i + 2] = clamp255(rgba[i + 2] + (rgba[i + 2] - blurred[i + 2]) * strength);
                }
                return rgba;
            }

            function applyToneAndColor(rgba, contrastSlider, brightnessSlider, saturationSlider) {
                if (!contrastSlider && !brightnessSlider && !saturationSlider) return rgba;
                const brightnessOffset = brightnessSlider * 2.55;
                const c = contrastSlider * 2.55; // -127.5..127.5
                const contrastFactor = (259 * (c + 255)) / (255 * (259 - c));
                const satFactor = 1 + saturationSlider / 50;
                for (let i = 0; i < rgba.length; i += 4) {
                    let r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
                    if (brightnessOffset) { r += brightnessOffset; g += brightnessOffset; b += brightnessOffset; }
                    if (contrastSlider) {
                        r = contrastFactor * (r - 128) + 128;
                        g = contrastFactor * (g - 128) + 128;
                        b = contrastFactor * (b - 128) + 128;
                    }
                    if (saturationSlider) {
                        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
                        r = luma + (r - luma) * satFactor;
                        g = luma + (g - luma) * satFactor;
                        b = luma + (b - luma) * satFactor;
                    }
                    rgba[i] = clamp255(r); rgba[i + 1] = clamp255(g); rgba[i + 2] = clamp255(b);
                }
                return rgba;
            }

            // ---- RawImage <-> OffscreenCanvas helpers ----
            function rgbaToCanvas(rgba, width, height) {
                const canvas = new OffscreenCanvas(width, height);
                const ctx = canvas.getContext('2d');
                ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
                return canvas;
            }

            // The Swin2SR models only understand RGB and return a fully-opaque
            // result, so transparency would otherwise be silently lost on any
            // AI-upscaled PNG/WebP. Instead, the original alpha channel is
            // pulled out as its own small grayscale image before upscaling and
            // resized back in afterward - cheap, and a no-op for opaque photos.
            function extractAlphaCanvas(rgba, width, height) {
                const gray = new Uint8ClampedArray(width * height * 4);
                for (let p = 0; p < width * height; p++) {
                    const a = rgba[p * 4 + 3];
                    gray[p * 4] = a; gray[p * 4 + 1] = a; gray[p * 4 + 2] = a; gray[p * 4 + 3] = 255;
                }
                return rgbaToCanvas(gray, width, height);
            }
            function restoreAlpha(rgba, width, height, alphaCanvas) {
                const resized = new OffscreenCanvas(width, height);
                const rctx = resized.getContext('2d');
                rctx.imageSmoothingEnabled = true;
                rctx.drawImage(alphaCanvas, 0, 0, width, height);
                const data = rctx.getImageData(0, 0, width, height).data;
                for (let p = 0; p < width * height; p++) rgba[p * 4 + 3] = data[p * 4];
                return rgba;
            }

            function rawImageToCanvas(img) {
                // img.data may be Uint8ClampedArray/Uint8Array (0-255) or a
                // float typed array (0-1 or 0-255) depending on the model's
                // postprocessing; normalize defensively rather than assume.
                const { width, height, channels, data } = img;
                const numPixels = width * height;
                let rgba = new Uint8ClampedArray(numPixels * 4);
                const isFloat = data instanceof Float32Array || data instanceof Float64Array;
                let maxVal = 1;
                if (isFloat) {
                    for (let i = 0; i < data.length; i++) if (data[i] > maxVal) maxVal = data[i];
                }
                const scale = isFloat ? (maxVal <= 1.5 ? 255 : 1) : 1;
                if (channels === 4) {
                    for (let p = 0; p < numPixels; p++) {
                        rgba[p * 4] = clamp255(data[p * 4] * scale);
                        rgba[p * 4 + 1] = clamp255(data[p * 4 + 1] * scale);
                        rgba[p * 4 + 2] = clamp255(data[p * 4 + 2] * scale);
                        rgba[p * 4 + 3] = clamp255(data[p * 4 + 3] * scale);
                    }
                } else if (channels === 3) {
                    for (let p = 0; p < numPixels; p++) {
                        rgba[p * 4] = clamp255(data[p * 3] * scale);
                        rgba[p * 4 + 1] = clamp255(data[p * 3 + 1] * scale);
                        rgba[p * 4 + 2] = clamp255(data[p * 3 + 2] * scale);
                        rgba[p * 4 + 3] = 255;
                    }
                } else { // grayscale
                    for (let p = 0; p < numPixels; p++) {
                        const v = clamp255(data[p] * scale);
                        rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255;
                    }
                }
                return rgbaToCanvas(rgba, width, height);
            }

            // ---- Tiled AI upscaling ----
            async function upscaleTiled(rgba, width, height, factor, onProgress) {
                const modelId = factor === 4 ? MODEL_4X : MODEL_2X;
                const upscaler = await ensureUpscaler(modelId, (p) => {
                    self.postMessage({ type: 'model-progress', payload: p });
                });
                if (cancelled) throw new Error('cancelled');

                const srcCanvas = rgbaToCanvas(rgba, width, height);
                const stepX = TILE_SIZE - TILE_OVERLAP * 2;
                const stepY = TILE_SIZE - TILE_OVERLAP * 2;
                const tilesX = Math.max(1, Math.ceil(Math.max(1, width - TILE_OVERLAP * 2) / stepX));
                const tilesY = Math.max(1, Math.ceil(Math.max(1, height - TILE_OVERLAP * 2) / stepY));
                const totalTiles = tilesX * tilesY;

                // Output canvas sized generously (exact final scale is derived
                // from the model's own output vs. input ratio, per tile, since
                // some SR models round dimensions internally rather than
                // scaling by an exact integer factor).
                let outCanvas = null, outCtx = null;
                let done = 0;

                for (let ty = 0; ty < tilesY; ty++) {
                    for (let tx = 0; tx < tilesX; tx++) {
                        if (cancelled) throw new Error('cancelled');
                        const sx = tx * stepX - TILE_OVERLAP;
                        const sy = ty * stepY - TILE_OVERLAP;
                        const cropX = Math.max(0, sx), cropY = Math.max(0, sy);
                        const cropRight = Math.min(width, sx + TILE_SIZE);
                        const cropBottom = Math.min(height, sy + TILE_SIZE);
                        const cropW = cropRight - cropX, cropH = cropBottom - cropY;
                        if (cropW <= 0 || cropH <= 0) { done++; continue; }

                        const tileCanvas = new OffscreenCanvas(cropW, cropH);
                        const tileCtx = tileCanvas.getContext('2d');
                        tileCtx.drawImage(srcCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

                        const rawInput = RawImage.fromCanvas(tileCanvas);
                        let output = await upscaler(rawInput);
                        if (Array.isArray(output)) output = output[0];
                        const tileOutCanvas = rawImageToCanvas(output);

                        const scaleX = tileOutCanvas.width / cropW;
                        const scaleY = tileOutCanvas.height / cropH;

                        if (!outCanvas) {
                            outCanvas = new OffscreenCanvas(Math.round(width * scaleX), Math.round(height * scaleY));
                            outCtx = outCanvas.getContext('2d');
                        }

                        const coreLeft = (cropX === 0) ? 0 : TILE_OVERLAP;
                        const coreTop = (cropY === 0) ? 0 : TILE_OVERLAP;
                        const coreRight = (cropRight === width) ? cropW : cropW - TILE_OVERLAP;
                        const coreBottom = (cropBottom === height) ? cropH : cropH - TILE_OVERLAP;
                        const coreW = Math.max(1, coreRight - coreLeft);
                        const coreH = Math.max(1, coreBottom - coreTop);

                        const destX = Math.round((cropX + coreLeft) * scaleX);
                        const destY = Math.round((cropY + coreTop) * scaleY);
                        const srcXin = Math.round(coreLeft * scaleX);
                        const srcYin = Math.round(coreTop * scaleY);
                        const srcWin = Math.round(coreW * scaleX);
                        const srcHin = Math.round(coreH * scaleY);

                        outCtx.drawImage(tileOutCanvas, srcXin, srcYin, srcWin, srcHin, destX, destY, srcWin, srcHin);

                        done++;
                        onProgress(done / totalTiles);
                    }
                }

                const finalData = outCtx.getImageData(0, 0, outCanvas.width, outCanvas.height);
                return { data: finalData.data, width: outCanvas.width, height: outCanvas.height };
            }

            self.onmessage = async (e) => {
                const { type, payload } = e.data;
                if (type === 'cancel') { cancelled = true; return; }
                if (type !== 'enhance') return;

                cancelled = false;
                try {
                    chosenDevice = await detectDevice();
                    self.postMessage({ type: 'device', payload: chosenDevice });

                    let { buffer, width, height, settings } = payload;
                    let rgba = new Uint8ClampedArray(buffer);

                    self.postMessage({ type: 'progress', payload: { stage: 'Reducing noise...', fraction: 0.05 } });
                    if (settings.denoise > 0) rgba = applyDenoise(rgba, width, height, settings.denoise);
                    if (cancelled) throw new Error('cancelled');

                    let outWidth = width, outHeight = height;
                    if (settings.upscale > 1) {
                        const alphaCanvas = extractAlphaCanvas(rgba, width, height);
                        self.postMessage({ type: 'progress', payload: { stage: 'Loading AI model...', fraction: 0.1 } });
                        const result = await upscaleTiled(rgba, width, height, settings.upscale, (frac) => {
                            self.postMessage({ type: 'progress', payload: { stage: 'AI upscaling ' + Math.round(frac * 100) + '%', fraction: 0.15 + frac * 0.65 } });
                        });
                        rgba = new Uint8ClampedArray(result.data);
                        outWidth = result.width; outHeight = result.height;
                        // The model output is always fully opaque - restore real
                        // transparency (or a no-op all-255 alpha, for opaque photos).
                        rgba = restoreAlpha(rgba, outWidth, outHeight, alphaCanvas);
                    }
                    if (cancelled) throw new Error('cancelled');

                    self.postMessage({ type: 'progress', payload: { stage: 'Sharpening...', fraction: 0.85 } });
                    if (settings.sharpness > 0) rgba = applySharpen(rgba, outWidth, outHeight, settings.sharpness);
                    if (cancelled) throw new Error('cancelled');

                    self.postMessage({ type: 'progress', payload: { stage: 'Adjusting color...', fraction: 0.95 } });
                    rgba = applyToneAndColor(rgba, settings.contrast, settings.brightness, settings.saturation);

                    self.postMessage({
                        type: 'done',
                        payload: { buffer: rgba.buffer, width: outWidth, height: outHeight }
                    }, [rgba.buffer]);
                } catch (err) {
                    if (err && err.message === 'cancelled') {
                        self.postMessage({ type: 'cancelled' });
                    } else {
                        console.error(err);
                        self.postMessage({ type: 'error', payload: String(err && err.message ? err.message : err) });
                    }
                }
            };
        `;
        const blob = new Blob([workerSource], { type: 'application/javascript' });
        return new Worker(URL.createObjectURL(blob), { type: 'module' });
    }

    // ---------------- Enhance orchestration ----------------
    function setProgress(fraction, text) {
        $('progressBarFill').style.width = Math.round(Math.min(1, Math.max(0, fraction)) * 100) + '%';
        $('progressPercent').textContent = Math.round(Math.min(1, Math.max(0, fraction)) * 100) + '%';
        if (text) $('progressText').textContent = text;
    }

    async function startEnhance() {
        if (state.busy || !state.workingRgba) return;
        state.busy = true;
        hideFileError();

        $('enhanceBtn').classList.add('hidden');
        $('resetControlsBtn').classList.add('hidden');
        $('progressContainer').classList.remove('hidden');
        setProgress(0, 'Preparing...');

        const worker = ensureWorker();
        worker.onmessage = handleWorkerMessage;
        worker.onerror = (err) => {
            console.error(err);
            handleEnhanceFailure('A processing error occurred in the background worker.');
        };

        const rgbaCopy = new Uint8ClampedArray(state.workingRgba); // keep original safe from transfer
        worker.postMessage({
            type: 'enhance',
            payload: {
                buffer: rgbaCopy.buffer,
                width: state.workingWidth,
                height: state.workingHeight,
                settings: {
                    upscale: state.upscale,
                    sharpness: state.sliders.sharpness,
                    denoise: state.sliders.denoise,
                    contrast: state.sliders.contrast,
                    brightness: state.sliders.brightness,
                    saturation: state.sliders.saturation
                }
            }
        }, [rgbaCopy.buffer]);
    }

    function cancelEnhance() {
        if (!state.busy || !state.worker) return;
        setProgress($('progressBarFill').style.width ? parseInt($('progressBarFill').style.width) / 100 : 0, 'Cancelling...');
        state.worker.postMessage({ type: 'cancel' });
        // Hard fallback: if the worker doesn't acknowledge quickly, kill it.
        setTimeout(() => {
            if (state.busy) {
                terminateWorker();
                handleEnhanceFailure('Cancelled.', true);
            }
        }, 1500);
    }

    function handleWorkerMessage(e) {
        const { type, payload } = e.data;
        if (type === 'device') {
            // no UI surface needed; informational only
        } else if (type === 'model-progress') {
            // model file download progress (0-100ish per file); folded into overall bar conservatively
            if (payload && typeof payload.progress === 'number') {
                setProgress(0.1 + Math.min(payload.progress, 100) / 100 * 0.05, 'Downloading AI model...');
            }
        } else if (type === 'progress') {
            setProgress(payload.fraction, payload.stage);
        } else if (type === 'done') {
            finishEnhance(payload);
        } else if (type === 'cancelled') {
            handleEnhanceFailure('Enhancement cancelled.', true);
        } else if (type === 'error') {
            handleEnhanceFailure(mapWorkerError(payload));
        }
    }

    function mapWorkerError(msg) {
        const m = String(msg || '');
        if (/out of memory|allocation/i.test(m)) return 'Your device ran out of memory while enhancing this photo. Try a smaller image or a lower upscale level.';
        if (/webgpu/i.test(m)) return 'The AI model failed to run on your GPU. Please try again — it will automatically fall back to a slower, more compatible mode.';
        if (/fetch|network|failed to load/i.test(m)) return 'The AI model could not be downloaded. Check your internet connection and try again.';
        return 'Something went wrong while enhancing this photo (' + m + '). Please try again.';
    }

    function handleEnhanceFailure(message, quiet) {
        state.busy = false;
        $('progressContainer').classList.add('hidden');
        $('enhanceBtn').classList.remove('hidden');
        $('resetControlsBtn').classList.remove('hidden');
        if (!quiet) showFileError(message);
    }

    async function finishEnhance(payload) {
        try {
            const { buffer, width, height } = payload;
            const rgba = new Uint8ClampedArray(buffer);
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d');
            ctx.putImageData(new ImageData(rgba, width, height), 0, 0);

            state.enhancedCanvas = canvas;
            state.enhancedWidth = width;
            state.enhancedHeight = height;
            state.busy = false;

            $('progressContainer').classList.add('hidden');
            $('enhanceBtn').classList.remove('hidden');
            $('resetControlsBtn').classList.remove('hidden');

            await showResult();
        } catch (err) {
            console.error(err);
            handleEnhanceFailure('The enhanced photo could not be prepared for display. Please try again.');
        }
    }

    // ---------------- Result / comparison / export ----------------
    async function showResult() {
        $('settingsArea').classList.add('hidden');
        $('resultArea').classList.remove('hidden');

        const beforeImg = $('beforeImg');
        beforeImg.src = state.beforeUrl;
        // The compare slider reads the stage's rendered size to lay out the
        // after-image overlay; wait for the before-image to actually decode
        // so that size is correct on the very first paint, not just 0x0.
        await (beforeImg.decode ? beforeImg.decode().catch(() => {}) : new Promise(r => { beforeImg.onload = r; }));

        await regenerateExportPreview();

        $('statOriginal').textContent = `${state.workingWidth}×${state.workingHeight}px · ${humanSize(state.file.size)}`;

        resetZoom();
        setComparePosition(50);
    }

    async function regenerateExportPreview() {
        if (!state.enhancedCanvas) return;
        const format = state.format;
        const quality = state.quality;
        const mime = format === 'jpeg' ? 'image/jpeg' : (format === 'webp' ? 'image/webp' : 'image/png');
        let blob;
        try {
            blob = format === 'png'
                ? await canvasToBlobCompat(state.enhancedCanvas, mime)
                : await canvasToBlobCompat(state.enhancedCanvas, mime, quality);
        } catch (err) {
            console.error(err);
            showFileError('Could not encode the enhanced photo in that format. Try a different format.');
            return;
        }

        if (state.enhancedBlobUrl) URL.revokeObjectURL(state.enhancedBlobUrl);
        state.enhancedBlobUrl = URL.createObjectURL(blob);
        $('afterImg').src = state.enhancedBlobUrl;

        const ext = format === 'jpeg' ? 'jpg' : format;
        const baseName = state.file.name.replace(/\.[^/.]+$/, '');
        const link = $('downloadLink');
        link.href = state.enhancedBlobUrl;
        link.download = `${baseName}_enhanced.${ext}`;

        $('statEnhanced').textContent = `${state.enhancedWidth}×${state.enhancedHeight}px · ${humanSize(blob.size)}`;
        $('estimatedSize').textContent = `Estimated download size: ${humanSize(blob.size)}`;

        // Re-sync the compare overlay now that the after-image source changed.
        requestAnimationFrame(() => setComparePosition(state.comparePct));
    }

    // ---------------- Compare slider ----------------
    function setComparePosition(pct) {
        pct = Math.min(100, Math.max(0, pct));
        state.comparePct = pct;
        const stage = $('compareStage');
        const rect = stage.getBoundingClientRect();
        const w = rect.width, h = rect.height;
        const afterImg = $('afterImg');
        const afterClip = $('afterClip');
        afterImg.style.width = w + 'px';
        afterImg.style.height = h + 'px';
        afterClip.style.width = (w * pct / 100) + 'px';
        $('compareDivider').style.left = pct + '%';
        $('compareHandle').setAttribute('aria-valuenow', String(Math.round(pct)));
    }

    function initCompareSlider() {
        const handle = $('compareHandle');
        const wrap = $('compareWrap');
        let dragging = false;

        function posFromEvent(clientX) {
            const rect = $('compareStage').getBoundingClientRect();
            const pct = ((clientX - rect.left) / rect.width) * 100;
            return pct;
        }

        function onPointerMove(clientX) {
            setComparePosition(posFromEvent(clientX));
        }

        handle.addEventListener('pointerdown', (e) => {
            dragging = true;
            handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            onPointerMove(e.clientX);
        });
        handle.addEventListener('pointerup', () => { dragging = false; });
        handle.addEventListener('pointercancel', () => { dragging = false; });

        wrap.addEventListener('pointerdown', (e) => {
            if (e.target === handle) return;
            onPointerMove(e.clientX);
        });

        handle.addEventListener('keydown', (e) => {
            let delta = 0;
            if (e.key === 'ArrowLeft') delta = -5;
            else if (e.key === 'ArrowRight') delta = 5;
            else if (e.key === 'Home') { setComparePosition(0); return; }
            else if (e.key === 'End') { setComparePosition(100); return; }
            else return;
            e.preventDefault();
            setComparePosition(state.comparePct + delta);
        });

        window.addEventListener('resize', () => setComparePosition(state.comparePct));
    }

    // ---------------- Zoom ----------------
    function applyZoom() {
        $('compareStage').style.transform = `scale(${state.zoomScale})`;
        $('compareStage').style.transformOrigin = 'top left';
        $('compareWrap').style.overflow = state.zoomScale > 1 ? 'auto' : 'hidden';
        requestAnimationFrame(() => setComparePosition(state.comparePct));
    }
    function resetZoom() {
        state.zoomScale = 1;
        applyZoom();
    }

    // ---------------- Reset ----------------
    function resetResultOnly() {
        if (state.enhancedBlobUrl) { URL.revokeObjectURL(state.enhancedBlobUrl); state.enhancedBlobUrl = null; }
        state.enhancedCanvas = null;
        $('resultArea').classList.add('hidden');
    }

    function resetTool() {
        terminateWorker();
        state.busy = false;
        if (state.beforeUrl) { URL.revokeObjectURL(state.beforeUrl); state.beforeUrl = null; }
        resetResultOnly();
        state.file = null;
        state.workingRgba = null;
        state.upscale = 1;
        setSliders({ sharpness: 0, denoise: 0, contrast: 0, brightness: 0, saturation: 0 });
        document.querySelectorAll('#upscaleGroup .upscale-pill').forEach((p, i) => {
            p.classList.toggle('active', i === 0);
            p.setAttribute('aria-checked', i === 0 ? 'true' : 'false');
        });

        hideFileError();
        $('fileInput').value = '';
        $('uploadArea').classList.remove('hidden');
        $('settingsArea').classList.add('hidden');
        $('resultArea').classList.add('hidden');
        $('enhanceBtn').classList.remove('hidden');
        $('resetControlsBtn').classList.remove('hidden');
        $('progressContainer').classList.add('hidden');
    }

    // ---------------- Init ----------------
    function initControls() {
        wirePillGroup('#upscaleGroup .upscale-pill', selectUpscale);
        wireSliders();

        $('autoEnhanceBtn').addEventListener('click', () => {
            setSliders({ sharpness: 35, denoise: 15, contrast: 10, brightness: 5, saturation: 12 });
            startEnhance();
        });
        $('resetControlsBtn').addEventListener('click', () => {
            setSliders({ sharpness: 0, denoise: 0, contrast: 0, brightness: 0, saturation: 0 });
        });
        $('enhanceBtn').addEventListener('click', startEnhance);
        $('cancelBtn').addEventListener('click', cancelEnhance);

        wirePillGroup('#formatGroup .quality-pill', (pill) => {
            document.querySelectorAll('#formatGroup .quality-pill').forEach(p => { p.classList.remove('active'); p.setAttribute('aria-checked', 'false'); });
            pill.classList.add('active'); pill.setAttribute('aria-checked', 'true');
            state.format = pill.dataset.format;
            $('qualityRow').style.display = state.format === 'png' ? 'none' : '';
            regenerateExportPreview();
        });
        wirePillGroup('#qualityGroup .quality-pill', (pill) => {
            document.querySelectorAll('#qualityGroup .quality-pill').forEach(p => { p.classList.remove('active'); p.setAttribute('aria-checked', 'false'); });
            pill.classList.add('active'); pill.setAttribute('aria-checked', 'true');
            state.quality = parseFloat(pill.dataset.quality);
            regenerateExportPreview();
        });

        initCompareSlider();
        $('zoomInBtn').addEventListener('click', () => { state.zoomScale = Math.min(4, state.zoomScale + 0.5); applyZoom(); });
        $('zoomOutBtn').addEventListener('click', () => { state.zoomScale = Math.max(1, state.zoomScale - 0.5); applyZoom(); });
        $('zoomFitBtn').addEventListener('click', resetZoom);
        $('zoomFullBtn').addEventListener('click', () => {
            if (!state.enhancedBlobUrl) return;
            $('fullPreviewImg').src = state.enhancedBlobUrl;
            $('fullPreviewDialog').classList.remove('hidden');
        });
        $('closePreviewBtn').addEventListener('click', () => $('fullPreviewDialog').classList.add('hidden'));
        $('fullPreviewDialog').addEventListener('click', (e) => {
            if (e.target === $('fullPreviewDialog')) $('fullPreviewDialog').classList.add('hidden');
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') $('fullPreviewDialog').classList.add('hidden');
        });
    }

    document.addEventListener('DOMContentLoaded', initControls);

    window.PhotoEnhancer = { handleFileSelect, handleDrop, resetTool };
})();
