/**
 * Where in the LGU a project is, as far as its title says.
 *
 * The budget documents list a project under a DPWH office, not a barangay.
 * The only location they give is the title ("…, Barangay Tunasan, Muntinlupa
 * City"). So a project is listed under every barangay its title names. That
 * is a reading of the title, not a survey: a project that names no barangay
 * (a river, a national road, a subdivision) stays under "no barangay named"
 * rather than being guessed into one.
 *
 * Rules, in order:
 * - A barangay counts when its name (or an alias) stands as its own word.
 *   That includes a river or school named after it ("Tunasan River"). Inside
 *   a hyphenated road name ("Zapote-Alabang Rd") it does not count: that
 *   names a road between two places, not the place the work is in.
 * - Longer names win, so "Ayala Alabang" is not also counted as "Alabang".
 * - A title that names no barangay but names a neighbour the DPWH office also
 *   serves ("…, Las Piñas City") is grouped under that neighbour.
 * - The office's own name ("Las Piñas Muntinlupa District Engineering
 *   Office") is not a location, so it is set aside before looking.
 *
 * Pure: no browser or Vite APIs, so `scripts/` imports it too.
 */
import type { PortalConfig } from '../config';

export const NO_BARANGAY = 'none';
export const neighbourKey = (label: string) => `near:${label}`;

export interface Area {
  /** Barangays of this LGU the title names, in the config's order. */
  barangays: string[];
  /** A neighbouring LGU the title names, when it names no barangay. */
  neighbour: string | null;
}

/** Lowercase, no accents, punctuation kept: "Las Piñas" → "las pinas". */
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Letters and digits only: "Las Pi ñ as" → "laspinas", so stray spaces in a scanned title still match. */
const squash = (s: string) => plain(s).replace(/[^a-z0-9]/g, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ROAD = /[a-z]+(\s*-\s*[a-z]+)+\s+(rd|road|expressway|highway)\b/g;

export type AreaReader = (title: string) => Area;

/** Build the reader once per config; it is called for every row. */
export function areaReader(config: PortalConfig): AreaReader {
  const { barangays = [], neighbours = [], offices = [] } = config.scope;
  // Longest first, so "Ayala Alabang" is taken before "Alabang" can match inside it.
  const names = barangays
    .flatMap((b) => [b.name, ...(b.aliases ?? [])].map((n) => ({ barangay: b.name, n: plain(n.trim()) })))
    .filter((x) => x.n)
    .sort((a, b) => b.n.length - a.n.length)
    // Its own word, and not one half of a hyphenated name.
    .map((x) => ({ barangay: x.barangay, re: new RegExp(`(?<![a-z0-9-])${escapeRe(x.n).replace(/ /g, '[\\s-]+')}(?![a-z0-9]|-[a-z])`, 'g') }));
  const order = new Map(barangays.map((b, i) => [b.name, i]));
  const near = neighbours.map((n) => ({ label: n.label, names: (n.names ?? [n.label]).map(squash).filter(Boolean) }));
  // "Las Piñas Muntinlupa District Engineering Office" and "Las Piñas-Muntinlupa DEO" alike.
  const officeRes = offices.map((o) => {
    const words = plain(o).replace(/ district engineering office$/, '').split(/[\s-]+/).map(escapeRe);
    return new RegExp(`${words.join('[\\s-]+')}[\\s-]+(district engineering office|deo)`, 'g');
  });

  return (title) => {
    // "BarangayTunasan" is a typo the documents make; give the name its own word.
    let text = plain(title).replace(/\b(barangay|brgy\.?)(?=[a-z])/g, '$1 ');
    for (const re of officeRes) text = text.replace(re, ' ');
    // "Zapote-Alabang Rd", "Alabang - Muntinlupa Rd": a road named for its two ends.
    text = text.replace(ROAD, ' ');
    const found = new Set<string>();
    for (const { barangay, re } of names) {
      text = text.replace(re, () => {
        found.add(barangay);
        return ' | ';
      });
    }
    if (found.size) {
      return { barangays: [...found].sort((a, b) => order.get(a)! - order.get(b)!), neighbour: null };
    }
    const squashed = squash(text);
    return { barangays: [], neighbour: near.find((n) => n.names.some((x) => squashed.includes(x)))?.label ?? null };
  };
}

/** The filter keys a row answers to: each barangay, or its neighbour, or "none". */
export function areaKeys(area: Area): string[] {
  if (area.barangays.length) return area.barangays;
  return [area.neighbour ? neighbourKey(area.neighbour) : NO_BARANGAY];
}
