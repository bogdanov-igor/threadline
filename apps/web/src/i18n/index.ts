import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LANGUAGE, LANGUAGES } from './languages.ts';
import ru from './ru.json';

void i18n.use(initReactI18next).init({
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: LANGUAGES.map((l) => l.code),
  resources: { ru: { translation: ru } },
  interpolation: { escapeValue: false },
  initAsync: false,
});

export default i18n;
