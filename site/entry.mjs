import { chooseLanguage, preferenceKey } from './locale.mjs';

let preference;
try { preference = localStorage.getItem(preferenceKey); } catch { /* Storage is optional. */ }
const language = chooseLanguage(preference, navigator.languages?.length ? navigator.languages : [navigator.language]);
// Only the neutral entry page runs this script. Localized URLs never redirect.
location.replace(`/${language}/${location.search}${location.hash}`);
