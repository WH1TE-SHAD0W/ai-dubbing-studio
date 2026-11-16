import file from "../../../../.github/feature-flags.json";

// Feature flags, read from .github/feature-flags.json when the app is built.
// Flip a value there and rebuild to turn a feature on or off.
export type Flag = keyof typeof file;

for (const [name, value] of Object.entries(file)) {
  if (typeof value !== "boolean") {
    throw new Error(`Feature flag "${name}" in .github/feature-flags.json must be true or false`);
  }
}

export function isEnabled(flag: Flag): boolean {
  return file[flag] === true;
}
