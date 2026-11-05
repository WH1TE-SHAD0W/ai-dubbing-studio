import { z } from "zod";

// Languages the app offers as spoken or target languages. Every target language is
// a separate paid translation stream, so the list is kept short and static.
// Irish (ga) is left out: the Gemini Live Translate model doesn't support it.
export const LANGUAGES = {
  en: "English",
  sk: "Slovak",
  cs: "Czech",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pl: "Polish",
  hu: "Hungarian",
  uk: "Ukrainian",
  pt: "Portuguese",
  nl: "Dutch",
  ro: "Romanian",
  sv: "Swedish",
  tr: "Turkish",
  ar: "Arabic",
  hi: "Hindi",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
} as const;

export type LanguageCode = keyof typeof LANGUAGES;

export const LANGUAGE_CODES = Object.keys(LANGUAGES) as [LanguageCode, ...LanguageCode[]];

export const languageCodeSchema = z.enum(LANGUAGE_CODES);

export function languageName(code: LanguageCode): string {
  return LANGUAGES[code];
}
