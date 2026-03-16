// ==UserScript==
// @name         小红书图片一键保存
// @namespace    xhs_image_saver_lite
// @version      0.2.2
// @description  在小红书笔记页右侧提供一键保存当前图文全部图片的按钮
// @author       Codex
// @match        http*://www.xiaohongshu.com/explore/*
// @match        http*://www.xiaohongshu.com/discovery/item/*
// @match        http*://www.xiaohongshu.com/user/profile/*
// @grant        unsafeWindow
// @grant        GM_download
// @run-at       document-end
// ==/UserScript==

// 相对浏览器默认下载目录的子目录。
// 例如：
// - "xhs/xhs保存科研绘图" => <默认下载目录>/xhs/xhs保存科研绘图/
// - "" => 直接保存到浏览器默认下载目录
// 如果写成绝对 Windows 路径，脚本会只保留最后的目录片段，
// 避免整串路径被拼进文件名。
const DEFAULT_SAVE_DIR = '';

// 支持："jpg"、"png"、"original"
const DEFAULT_IMAGE_FORMAT = 'jpg';

const BUTTON_TEXT = '保存图片';
const BUTTON_TEXT_SAVING = '保存中...';
const TOAST_NO_IMAGE = '当前笔记没有可保存的图片';
const TOAST_SAVE_FAILED = '保存图片失败';
const TOAST_SAVE_DONE = (count) => `已开始保存 ${count} 张图片`;

const isNoteDetailPage = (url = '') => (
    url.includes('https://www.xiaohongshu.com/explore/') ||
    url.includes('https://www.xiaohongshu.com/discovery/item/')
);

const isImageNote = (note) => Boolean(
    note &&
    note.type === 'normal' &&
    Array.isArray(note.imageList) &&
    note.imageList.length > 0
);

const buildDirectImageItems = (note) => {
    if (!isImageNote(note)) {
        return [];
    }

    return note.imageList.map((item, index) => {
        const url = item?.urlDefault || item?.url || '';
        return url ? { index: index + 1, url } : null;
    }).filter(Boolean);
};

const buildFallbackImageItems = (candidates = []) => {
    const urls = [];

    for (const candidate of candidates) {
        const src = String(candidate?.src || '').trim();
        const width = Number(candidate?.width || 0);
        const height = Number(candidate?.height || 0);

        if (!src || src.startsWith('data:') || !/^https?:\/\//i.test(src)) {
            continue;
        }

        if (!/xhscdn\.com|xiaohongshu\.com/i.test(src)) {
            continue;
        }

        if (width < 200 && height < 200) {
            continue;
        }

        if (!urls.includes(src)) {
            urls.push(src);
        }
    }

    return urls.map((url, index) => ({ index: index + 1, url }));
};

const normalizeImageFormat = (format = DEFAULT_IMAGE_FORMAT) => {
    const normalized = String(format).trim().toLowerCase();
    if (normalized === 'png') return 'png';
    if (normalized === 'jpg' || normalized === 'jpeg') return 'jpg';
    if (normalized === 'original' || normalized === 'webp') return 'original';
    return 'jpg';
};

const buildDownloadTargetPath = (baseDir = DEFAULT_SAVE_DIR, fileName = '') => {
    const cleaned = String(baseDir)
        .trim()
        .replace(/[\\]+/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/{2,}/g, '/');
    const segments = cleaned.split('/').filter(Boolean);
    const isWindowsAbsolute = /^[a-z]:$/i.test(segments[0] || '');
    const isUnixAbsolute = String(baseDir).trim().startsWith('/');
    const knownAnchors = ['desktop', 'downloads', 'documents', 'pictures'];
    const anchorIndex = segments.findIndex((segment) => knownAnchors.includes(segment.toLowerCase()));
    const normalizedSegments = (isWindowsAbsolute || isUnixAbsolute)
        ? (anchorIndex >= 0 ? segments.slice(anchorIndex + 1) : segments.slice(-2))
        : segments;
    const normalizedBaseDir = normalizedSegments.join('/');
    return normalizedBaseDir ? `${normalizedBaseDir}/${fileName}` : fileName;
};

const shouldShowFixedSaveButton = (url, note) => isNoteDetailPage(url) && (isImageNote(note) || note == null);

const parseNoteIdFromUrl = (url = '') => {
    const match = url.match(/\/(?:explore|discovery\/item)\/([^?]+)/);
    return match ? match[1] : '';
};

const sanitizeFilePart = (value = '') => String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

const getNoteBaseName = ({ title = '', url = '' }) => {
    const cleanedTitle = sanitizeFilePart(title.replace(/ - 小红书$/, ''));
    return cleanedTitle || parseNoteIdFromUrl(url) || 'xhs-note';
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        buildDirectImageItems,
        buildFallbackImageItems,
        buildDownloadTargetPath,
        isImageNote,
        isNoteDetailPage,
        normalizeImageFormat,
        shouldShowFixedSaveButton,
    };
}

if (typeof window !== 'undefined') {
    (function () {
        'use strict';

        let isSaving = false;

        const showToast = (message, duration = 2600) => {
            const toast = document.createElement('div');
            toast.textContent = message;
            Object.assign(toast.style, {
                position: 'fixed',
                left: '50%',
                bottom: '3rem',
                transform: 'translateX(-50%)',
                maxWidth: '80vw',
                padding: '10px 16px',
                background: 'rgba(15, 23, 42, 0.86)',
                color: '#fff',
                fontSize: '14px',
                lineHeight: '1.4',
                borderRadius: '999px',
                boxShadow: '0 10px 30px rgba(0, 0, 0, 0.2)',
                zIndex: '2147483647',
                opacity: '0',
                transition: 'opacity 160ms ease',
                pointerEvents: 'none',
                whiteSpace: 'pre-wrap',
                textAlign: 'center',
            });

            document.body.appendChild(toast);
            requestAnimationFrame(() => {
                toast.style.opacity = '1';
            });

            setTimeout(() => {
                toast.style.opacity = '0';
                toast.addEventListener(
                    'transitionend',
                    () => {
                        toast.remove();
                    },
                    { once: true }
                );
            }, duration);
        };

        const extractNoteInfo = () => {
            const state = unsafeWindow.__INITIAL_STATE__;
            const direct = state?.noteData?.data?.noteData;
            if (direct) {
                return direct;
            }

            const noteId = parseNoteIdFromUrl(window.location.href);
            if (!noteId) {
                return null;
            }

            return state?.note?.noteDetailMap?.[noteId]?.note || null;
        };

        const extractFallbackImageItemsFromDom = () => {
            const images = Array.from(document.querySelectorAll('img'));
            const candidates = images.map((image) => ({
                src: image.currentSrc || image.src || '',
                width: image.naturalWidth || image.width || image.clientWidth || 0,
                height: image.naturalHeight || image.height || image.clientHeight || 0,
            }));
            return buildFallbackImageItems(candidates);
        };

        const fetchBlob = async (url) => {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    accept: '*/*',
                },
            });

            if (!response.ok) {
                throw new Error(`Download failed with status ${response.status}`);
            }

            return await response.blob();
        };

        const getExtensionFromMimeType = (mimeType = '') => {
            const normalized = mimeType.toLowerCase();
            if (normalized.includes('png')) return 'png';
            if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
            if (normalized.includes('gif')) return 'gif';
            if (normalized.includes('avif')) return 'avif';
            if (normalized.includes('heic')) return 'heic';
            if (normalized.includes('webp')) return 'webp';
            return '';
        };

        const getExtensionFromUrl = (url = '') => {
            const match = url.match(/\.([a-z0-9]{3,5})(?:[?#]|$)/i);
            return match ? match[1].toLowerCase() : '';
        };

        const blobToDrawable = async (blob) => {
            if (typeof createImageBitmap === 'function') {
                return await createImageBitmap(blob);
            }

            return await new Promise((resolve, reject) => {
                const image = new Image();
                const objectUrl = URL.createObjectURL(blob);
                image.onload = () => {
                    URL.revokeObjectURL(objectUrl);
                    resolve(image);
                };
                image.onerror = (error) => {
                    URL.revokeObjectURL(objectUrl);
                    reject(error);
                };
                image.src = objectUrl;
            });
        };

        const convertImageBlob = async (blob, outputFormat) => {
            const normalizedFormat = normalizeImageFormat(outputFormat);
            if (normalizedFormat === 'original') {
                return {
                    blob,
                    ext: getExtensionFromMimeType(blob.type) || 'webp',
                };
            }

            const drawable = await blobToDrawable(blob);
            const canvas = document.createElement('canvas');
            canvas.width = drawable.width;
            canvas.height = drawable.height;

            const context = canvas.getContext('2d');
            if (!context) {
                throw new Error('Canvas 2D context unavailable');
            }

            if (normalizedFormat === 'jpg') {
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);
            }

            context.drawImage(drawable, 0, 0, canvas.width, canvas.height);

            if (typeof drawable.close === 'function') {
                drawable.close();
            }

            const mimeType = normalizedFormat === 'png' ? 'image/png' : 'image/jpeg';
            const convertedBlob = await new Promise((resolve, reject) => {
                canvas.toBlob((result) => {
                    if (result) {
                        resolve(result);
                    } else {
                        reject(new Error('Image conversion failed'));
                    }
                }, mimeType, 0.92);
            });

            return {
                blob: convertedBlob,
                ext: normalizedFormat,
            };
        };

        const fallbackDownload = (blob, fileName) => {
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(objectUrl);
        };

        const saveBlobToConfiguredPath = async (blob, fileName) => {
            if (typeof GM_download !== 'function') {
                fallbackDownload(blob, fileName);
                return true;
            }

            const targetPath = buildDownloadTargetPath(DEFAULT_SAVE_DIR, fileName);
            await new Promise((resolve, reject) => {
                const objectUrl = URL.createObjectURL(blob);
                GM_download({
                    url: objectUrl,
                    name: targetPath,
                    saveAs: false,
                    conflictAction: 'uniquify',
                    onload: () => {
                        URL.revokeObjectURL(objectUrl);
                        resolve(true);
                    },
                    onerror: (error) => {
                        URL.revokeObjectURL(objectUrl);
                        reject(error);
                    },
                    ontimeout: () => {
                        URL.revokeObjectURL(objectUrl);
                        reject(new Error('Download timeout'));
                    },
                });
            });

            return true;
        };

        const downloadCurrentNoteImages = async () => {
            if (isSaving) {
                return;
            }

            const note = extractNoteInfo();
            const items = isImageNote(note) ? buildDirectImageItems(note) : extractFallbackImageItemsFromDom();
            if (items.length === 0) {
                showToast(TOAST_NO_IMAGE);
                return;
            }

            isSaving = true;
            updateButton();

            try {
                const baseName = getNoteBaseName({
                    title: document.title,
                    url: window.location.href,
                });

                for (const item of items) {
                    const originalBlob = await fetchBlob(item.url);
                    const converted = await convertImageBlob(originalBlob, DEFAULT_IMAGE_FORMAT);
                    const fallbackExt = getExtensionFromUrl(item.url) || 'webp';
                    const ext = converted.ext || fallbackExt;
                    const fileName =
                        items.length === 1
                            ? `${baseName}.${ext}`
                            : `${baseName}_${item.index}.${ext}`;
                    await saveBlobToConfiguredPath(converted.blob, fileName);
                }

                showToast(TOAST_SAVE_DONE(items.length));
            } catch (error) {
                console.error('XHS image save failed:', error);
                showToast(TOAST_SAVE_FAILED);
            } finally {
                isSaving = false;
                updateButton();
            }
        };

        const button = document.createElement('button');
        button.type = 'button';
        button.style.cssText = `
            position: fixed;
            top: 50%;
            right: 1rem;
            transform: translateY(-50%);
            display: none;
            align-items: center;
            justify-content: center;
            min-width: 96px;
            padding: 12px 16px;
            border: none;
            border-radius: 999px;
            background: rgba(255, 36, 66, 0.94);
            color: #ffffff;
            font-size: 14px;
            font-weight: 600;
            line-height: 1;
            cursor: pointer;
            z-index: 2147483647;
            box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
            transition: transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
        `;

        button.addEventListener('mouseenter', () => {
            if (!button.disabled) {
                button.style.transform = 'translateY(-50%) translateX(-2px)';
                button.style.boxShadow = '0 16px 34px rgba(0, 0, 0, 0.22)';
            }
        });

        button.addEventListener('mouseleave', () => {
            button.style.transform = 'translateY(-50%)';
            button.style.boxShadow = '0 12px 30px rgba(0, 0, 0, 0.18)';
        });

        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await downloadCurrentNoteImages();
        });

        const updateButton = () => {
            const note = extractNoteInfo();
            button.textContent = isSaving ? BUTTON_TEXT_SAVING : BUTTON_TEXT;
            button.disabled = isSaving;
            button.style.opacity = isSaving ? '0.88' : '1';
            button.style.cursor = isSaving ? 'wait' : 'pointer';
            button.style.display = shouldShowFixedSaveButton(window.location.href, note)
                ? 'flex'
                : 'none';
        };

        const mountButton = () => {
            if (document.body && !button.isConnected) {
                document.body.appendChild(button);
            }
        };

        mountButton();
        updateButton();
        window.setInterval(() => {
            mountButton();
            updateButton();
        }, 500);
    })();
}
