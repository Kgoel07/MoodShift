export const preferenceLimit = 240;
export const installationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function explicitPreference(prompt: string): string | undefined {
  const text = prompt.trim();
  if (/^remember that\s+\S/i.test(text)) return text.replace(/^remember that\s+/i, '');
  if (/^i usually prefer\s+\S/i.test(text)) return text;
}
