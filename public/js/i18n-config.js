// Multi-language support using i18next
// Supports: English (en), Dutch (nl), German (de), French (fr), Spanish (es), Arabic (ar)

const SUPPORTED_LANGUAGES = {
  en: { name: 'English', flag: '🇬🇧', dir: 'ltr' },
  nl: { name: 'Nederlands', flag: '🇳🇱', dir: 'ltr' },
  de: { name: 'Deutsch', flag: '🇩🇪', dir: 'ltr' },
  fr: { name: 'Français', flag: '🇫🇷', dir: 'ltr' },
  es: { name: 'Español', flag: '🇪🇸', dir: 'ltr' },
  ar: { name: 'العربية', flag: '🇸🇦', dir: 'rtl' }
};

const DEFAULT_LANGUAGE = 'nl'; // Dutch as default

// Initialize i18next
async function initI18n() {
  // Get saved language or detect from browser
  const savedLang = localStorage.getItem('preferredLanguage');
  const browserLang = navigator.language.split('-')[0];
  const initialLang = savedLang || (SUPPORTED_LANGUAGES[browserLang] ? browserLang : DEFAULT_LANGUAGE);

  // Initialize i18next with backend to load translation files
  await i18next
    .use(i18nextHttpBackend)
    .init({
      lng: initialLang,
      fallbackLng: 'en',
      debug: false,
      backend: {
        loadPath: '/locales/{{lng}}.json'
      },
      interpolation: {
        escapeValue: false // Not needed for plain JavaScript
      }
    });

  // Set HTML direction for RTL languages
  updateDirection(initialLang);

  // Update the page content
  updateContent();

  // Setup language switcher if it exists
  setupLanguageSwitcher();

  console.log('i18next initialized with language:', initialLang);
}

// Update page content with translations
function updateContent() {
  // Translate all elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    const translation = i18next.t(key);

    // Handle different element types
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      if (element.placeholder !== undefined) {
        element.placeholder = translation;
      }
    } else {
      element.textContent = translation;
    }
  });

  // Translate elements with data-i18n-html (allows HTML in translations)
  document.querySelectorAll('[data-i18n-html]').forEach(element => {
    const key = element.getAttribute('data-i18n-html');
    element.innerHTML = i18next.t(key);
  });

  // Translate placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
    const key = element.getAttribute('data-i18n-placeholder');
    element.placeholder = i18next.t(key);
  });

  // Translate attributes (like button values, alt text)
  document.querySelectorAll('[data-i18n-attr]').forEach(element => {
    const attrConfig = element.getAttribute('data-i18n-attr');
    const [attr, key] = attrConfig.split(':');
    element.setAttribute(attr, i18next.t(key));
  });
}

// Update HTML direction (RTL for Arabic)
function updateDirection(lang) {
  const direction = SUPPORTED_LANGUAGES[lang].dir;
  document.documentElement.setAttribute('dir', direction);
  document.documentElement.setAttribute('lang', lang);

  // Add/remove RTL class for styling
  if (direction === 'rtl') {
    document.body.classList.add('rtl');
    addRTLStyles();
  } else {
    document.body.classList.remove('rtl');
    removeRTLStyles();
  }
}

// Add RTL-specific styles dynamically
function addRTLStyles() {
  // Check if RTL styles already exist
  if (document.getElementById('rtl-styles')) return;

  const style = document.createElement('style');
  style.id = 'rtl-styles';
  style.textContent = `
    /* RTL spacing fixes for navigation */
    body.rtl nav .space-x-6 > * + * {
      margin-left: 0 !important;
      margin-right: 1.5rem !important;
    }

    /* RTL fixes for buttons and inline elements */
    body.rtl .flex.gap-4 > * + * {
      margin-right: 1rem !important;
    }

    /* RTL language switcher spacing */
    body.rtl #language-button .flag-spacing {
      margin-right: 0 !important;
      margin-left: 0.5rem !important;
    }

    body.rtl #language-button .arrow-spacing {
      margin-left: 0 !important;
      margin-right: 0.5rem !important;
    }

    /* RTL dropdown spacing */
    body.rtl #language-dropdown button .flag-spacing {
      margin-right: 0 !important;
      margin-left: 0.75rem !important;
    }

    body.rtl #language-dropdown button .check-spacing {
      margin-left: 0 !important;
      margin-right: auto !important;
    }

    /* RTL mobile menu spacing */
    body.rtl #mobile-menu .space-y-2 > * {
      margin-right: 0.5rem !important;
    }
  `;
  document.head.appendChild(style);
}

// Remove RTL-specific styles
function removeRTLStyles() {
  const style = document.getElementById('rtl-styles');
  if (style) {
    style.remove();
  }
}

// Change language
async function changeLanguage(lang) {
  if (!SUPPORTED_LANGUAGES[lang]) {
    console.error('Unsupported language:', lang);
    return;
  }

  await i18next.changeLanguage(lang);
  localStorage.setItem('preferredLanguage', lang);
  updateDirection(lang);
  updateContent();

  // Update language switcher display
  updateLanguageSwitcherDisplay(lang);

  console.log('Language changed to:', lang);
}

// Setup language switcher dropdown
function setupLanguageSwitcher() {
  const switcher = document.getElementById('language-switcher');
  if (!switcher) return;

  const currentLang = i18next.language;
  const currentLangInfo = SUPPORTED_LANGUAGES[currentLang];

  // Create switcher HTML
  switcher.innerHTML = `
    <div class="relative inline-block text-left">
      <button type="button"
              id="language-button"
              class="inline-flex items-center justify-center w-full px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
        <span class="mr-2 flag-spacing">${currentLangInfo.flag}</span>
        <span>${currentLangInfo.name}</span>
        <svg class="w-5 h-5 ml-2 -mr-1 arrow-spacing" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
      </button>
      <div id="language-dropdown"
           class="hidden absolute right-0 z-10 mt-2 w-56 origin-top-right rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
        <div class="py-1">
          ${Object.entries(SUPPORTED_LANGUAGES).map(([code, info]) => `
            <button
              type="button"
              onclick="changeLanguage('${code}')"
              class="flex items-center w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 ${code === currentLang ? 'bg-blue-50 font-semibold' : ''}">
              <span class="mr-3 flag-spacing">${info.flag}</span>
              <span>${info.name}</span>
              ${code === currentLang ? '<svg class="w-4 h-4 ml-auto check-spacing text-blue-600" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>' : ''}
            </button>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  // Toggle dropdown
  const button = document.getElementById('language-button');
  const dropdown = document.getElementById('language-dropdown');

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', () => {
    dropdown.classList.add('hidden');
  });
}

// Update language switcher display after language change
function updateLanguageSwitcherDisplay(lang) {
  const button = document.getElementById('language-button');
  if (!button) return;

  const langInfo = SUPPORTED_LANGUAGES[lang];
  button.innerHTML = `
    <span class="mr-2 flag-spacing">${langInfo.flag}</span>
    <span>${langInfo.name}</span>
    <svg class="w-5 h-5 ml-2 -mr-1 arrow-spacing" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
      <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
    </svg>
  `;

  // Update dropdown selection
  setupLanguageSwitcher();
}

// Make functions globally available
window.initI18n = initI18n;
window.changeLanguage = changeLanguage;
window.SUPPORTED_LANGUAGES = SUPPORTED_LANGUAGES;
