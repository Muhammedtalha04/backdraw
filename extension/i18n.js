// UI texts of the extension pages, the in-page note and the service worker, by key: English, and
// Turkish when Chrome's UI language is Turkish. A key without a Turkish text falls back to English.
// The right-click menu titles are in _locales/ instead, so Chrome can show them by itself.
(() => {
  const STRINGS = {
    en: {
      bridge: 'Bridge',
      project: 'Project',
      job: 'Job',
      connected: 'Connected',
      notConnected: 'Not connected',
      noHost: 'The local bridge was not found{error}. Make sure the setup script (install.js) has been run.',
      notSelected: 'Not selected',
      idle: 'Idle',
      useProject: 'Use the “{name}” project',
      selectFailed: 'Could not select it.',
      version: 'Version',
      footerNote: 'Images are made in a background tab; your active tab does not change.',
      collections: 'Collections',
      noCollections: 'No collections yet. Right-click an image on any page and choose "Add to Backdraw".',
      imageCountOne: '1 image',
      imageCount: '{count} images',
      back: '‹ Back',
      rename: 'Rename',
      save: 'Save',
      cancel: 'Cancel',
      deleteCollection: 'Delete collection',
      confirmDelete: 'Delete "{name}" and its {images} from disk?',
      delete: 'Delete',
      removeImage: 'Delete this image',
      confirmRemoveImage: 'Click again to delete',
      loading: 'Loading…',
      noThumb: 'no preview',
      leftover: 'Not everything could be deleted. Left in the folder: {files}',
      newTitle: 'New collection',
      nameLabel: 'Collection name',
      namePlaceholder: 'e.g. Character references',
      nameExists: 'A collection with this name exists; the image is added to it.',
      nameInvalid: 'Use 1 to 64 characters.',
      add: 'Add',
      preparing: 'Preparing the image…',
      saving: 'Saving…',
      toastAdding: 'Adding to {name}…',
      toastAdded: 'Added to {name} · {images}',
      toastDuplicate: 'Already in {name} · {images}',
      errNotConnected: 'Backdraw is not connected. Is it installed (node install.js)?',
      errNotImage: 'This is not an image Backdraw can save.',
      errTooLarge: 'The image is larger than {mb} MB.',
      errDownload: 'The image could not be downloaded ({reason}).',
      errNoSource: 'Chrome did not pass on this image\'s address (it does not for very large embedded images), so it cannot be added.',
      errExpired: 'This window has expired; right-click the image again.',
      errTimeout: 'Backdraw did not answer in time.',
    },
    tr: {
      bridge: 'Köprü',
      project: 'Proje',
      job: 'İş',
      connected: 'Bağlı',
      notConnected: 'Bağlı değil',
      noHost: 'Yerel köprü bulunamadı{error}. Kurulum betiğini (install.js) çalıştırdığından emin ol.',
      notSelected: 'Seçilmedi',
      idle: 'Boşta',
      useProject: '“{name}” projesini kullan',
      selectFailed: 'Seçilemedi.',
      version: 'Sürüm',
      footerNote: 'Görseller arka planda üretilir; aktif sekmen değişmez.',
      collections: 'Koleksiyonlar',
      noCollections: 'Henüz koleksiyon yok. Herhangi bir sayfada bir görsele sağ tıklayıp "Backdraw\'a ekle"yi seç.',
      imageCountOne: '1 görsel',
      imageCount: '{count} görsel',
      back: '‹ Geri',
      rename: 'Yeniden adlandır',
      save: 'Kaydet',
      cancel: 'Vazgeç',
      deleteCollection: 'Koleksiyonu sil',
      confirmDelete: '"{name}" ve içindeki {images} diskten silinsin mi?',
      delete: 'Sil',
      removeImage: 'Bu görseli sil',
      confirmRemoveImage: 'Silmek için tekrar tıkla',
      loading: 'Yükleniyor…',
      noThumb: 'önizleme yok',
      leftover: 'Her şey silinemedi. Klasörde kalanlar: {files}',
      newTitle: 'Yeni koleksiyon',
      nameLabel: 'Koleksiyon adı',
      namePlaceholder: 'örn. Karakter referansları',
      nameExists: 'Bu adda bir koleksiyon var; görsel ona eklenir.',
      nameInvalid: '1 ile 64 karakter arasında bir ad yaz.',
      add: 'Ekle',
      preparing: 'Görsel hazırlanıyor…',
      saving: 'Kaydediliyor…',
      toastAdding: '{name} koleksiyonuna ekleniyor…',
      toastAdded: '{name} koleksiyonuna eklendi · {images}',
      toastDuplicate: 'Zaten {name} içinde · {images}',
      errNotConnected: 'Backdraw bağlı değil. Kurulu mu (node install.js)?',
      errNotImage: 'Bu, Backdraw\'ın kaydedebileceği bir görsel değil.',
      errTooLarge: 'Görsel {mb} MB\'tan büyük.',
      errDownload: 'Görsel indirilemedi ({reason}).',
      errNoSource: 'Chrome bu görselin adresini iletmedi (çok büyük gömülü görsellerde iletmiyor), bu yüzden eklenemiyor.',
      errExpired: 'Bu pencerenin süresi doldu; görsele yeniden sağ tıkla.',
      errTimeout: 'Backdraw zamanında yanıt vermedi.',
    },
  };

  function lang() {
    try { return /^tr\b/i.test(chrome.i18n.getUILanguage()) ? 'tr' : 'en'; } catch { return 'en'; }
  }

  // {name} placeholders are filled from vars; an unknown key shows as itself.
  function translate(language, key, vars) {
    const s = (STRINGS[language] && STRINGS[language][key]) || STRINGS.en[key] || key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  }

  const t = (key, vars) => translate(lang(), key, vars);
  const images = n => t(n === 1 ? 'imageCountOne' : 'imageCount', { count: n });

  // A page names its texts with data-i18n (text), data-i18n-title and data-i18n-placeholder.
  function apply(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  }

  const api = { STRINGS, lang, translate, t, images, apply };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.i18n = api;
})();
