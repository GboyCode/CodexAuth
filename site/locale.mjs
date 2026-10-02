export const preferenceKey = 'codexauth-site-language';

// Respect explicit preference, then browser languages in priority order.
// IP country is deliberately not used: VPN exits do not identify a language.
export function chooseLanguage(preference, languages = []) {
  if (preference === 'zh' || preference === 'en') return preference;
  for (const locale of languages) {
    const language = String(locale).toLowerCase().split(/[-_]/)[0];
    if (language === 'zh' || language === 'en') return language;
  }
  return 'en';
}
