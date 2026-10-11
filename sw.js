const CACHE_NAME = 'pdf-mechanic-v5'; // Version updated
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './site.webmanifest',
  './favicon.svg',           // Added (as discussed)
  './favicon-48x48.png',     // Added (as discussed)
  './favicon-32x32.png',
  './favicon-16x16.png',
  './android-icon-192.png',
  './android-icon-512.png',
  './apple-touch-icon.png',
  
  // PDF Tools (Full List)
  './compressor.html',
  './merger.html',
  './splitter.html',
  './pdf-editor.html',
  './rotate-pdf.html',
  './esign-pdf.html',
  './ocr.html',
  './add-page-numbers.html',
  './delete-pages.html',
  './merge-bank-statements.html',
  './reorder-pages.html',
  './watermark.html',
  
  // Converters
  './pdf-to-word.html',
  './word-to-pdf.html',
  './images-to-pdf.html',
  './pdf-to-images.html',
  './excel-to-pdf.html',
  './html-to-pdf.html',
  './pdf-to-excel.html',

  // Image Tools
  './image-compressor.html',
  './resize-for-govt-jobs.html',
  
  // Guides & Info
  './guides.html',
  './how-to-merge-pdf.html',
  './reduce-pdf-size.html',
  './pdf-security-explained.html',
  './privacy.html',
  './terms.html',

  // Specific Landing Pages (Folders)
  './pdf-to-word-no-upload/',
  './merge-pdf-offline-android/',
  './image-to-text-offline/',
  './compress-pdf-100kb/',
  './free-ocr-tool/',

  // --- External CDNs (Essential for Offline Functionality) ---
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  'https://unpkg.com/pdf-lib/dist/pdf-lib.min.js'
];

// Install Event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching all assets including tools and libraries');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate Event: Delete old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

// Fetch Event: Serve from Cache, then Network with offline fallback
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
