export const preferenceLimit = 240;
export const preferenceContextLimit = 4;
export const installationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const preferenceTextPattern = /^[^\u0000-\u001f\u007f]+$/;

const commonWords = new Set(['about', 'like', 'make', 'more', 'less', 'much', 'prefer', 'please', 'some', 'song', 'sound', 'that', 'this', 'want', 'with', 'would']);

function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? [])].filter(word => !commonWords.has(word));
}

export function relevantPreferences(prompt: string, newestFirst: readonly string[]): string[] {
  const keywords = new Set(terms(prompt));
  const ranked = newestFirst.map(text => ({ text, matches: terms(text).filter(word => keywords.has(word)).length }))
    .sort((a, b) => b.matches - a.matches);
  // Broad mood prompts may share no words with technical preferences.
  const relevant = ranked[0]?.matches ? ranked.filter(item => item.matches > 0) : ranked;
  return relevant.slice(0, preferenceContextLimit).map(item => item.text);
}

export function explicitPreference(prompt: string): string | undefined {
  const text = prompt.trim();
  if (/^remember that\s+\S/i.test(text)) return text.replace(/^remember that\s+/i, '');
  if (/^i usually prefer\s+\S/i.test(text)) return text;
}
