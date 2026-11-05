import { LANGUAGE_CODES, type LanguageCode, languageName } from "@ads/contracts";

export function LanguageSelect({
  label,
  value,
  onChange,
  options = LANGUAGE_CODES,
}: {
  label: string;
  value: LanguageCode;
  onChange: (lang: LanguageCode) => void;
  options?: readonly LanguageCode[];
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as LanguageCode)}>
        {options.map((code) => (
          <option key={code} value={code}>
            {languageName(code)}
          </option>
        ))}
      </select>
    </label>
  );
}
