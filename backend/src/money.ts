export function parseMoneyToFils(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(/,(?=\d{3}(?:\D|$))/g, "");
  const match = cleaned.match(/^(\d+)\.(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number(match[2]);
}

export function formatAed(fils: number): string {
  const sign = fils < 0 ? "-" : "";
  const abs = Math.abs(fils);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac} AED`;
}
