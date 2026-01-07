const CACHE_NAME = 'pdf-mechanic-v2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './site.webmanifest',
  './android-icon-192.png',
  './android-icon-512.png',
  './apple-touch-icon.png',
  './favicon-32x32.png',
  './favicon-16x16.png',
  
  // PDF Tools
  './compressor.html',
  './merger.html',
  './splitter.html',
  './pdf-editor.html',
  './rotate-pdf.html',
  './esign-pdf.html',
  './ocr.html',
  
  // Converters
  './pdf-to-word.html',
  './word-to-pdf.html',
  './images-to-pdf.html',
  './pdf-to-images.html',
  './excel-to-pdf.html',
  './html-to-pdf.html',
  
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
  './compress-pdf-100kb/'
];

// Install Event: Cache files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache');
        return cache.addAll(ASSETS_TO_CACHE);
      })
  );
});

// Activate Event: Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('Deleting old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

// Fetch Event: Serve from cache if available, otherwise fetch from network
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Cache hit - return response
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
  );
});