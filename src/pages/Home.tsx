import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { BridgeGroup, DatasetInfo, Disclaimer, GroupInfo } from '../api/types';
import { BRIDGE_GROUPS } from '../api/types';
import { shortNameOf, type DatasetKey, type PortalConfig } from '../config';
import { Await, Disclaimers, ReasonTags, StatusChip } from '../components/Bits';
import { PageHead } from '../components/Chrome';
import OfficesSection from '../components/OfficesSection';
import { areaKeys, areaReader, neighbourKey, NO_BARANGAY, type Area } from '../lib/areas';
import { projectsCsv, downloadText } from '../lib/csv';
import { count, php, phpDelta, phpFull, plural } from '../lib/format';
import { usePortal } from '../lib/portal-context';
import { summarise, type ScopedProject, type ScopeResult, type Summary } from '../lib/scope';
import { useTitle } from '../lib/use-title';

const PAGE = 25;

type Sort = 'house' | 'nep' | 'change' | 'title';
const SORTS: Record<Sort, { label: string; cmp: (a: ScopedProject, b: ScopedProject) => number }> = {
  house: { label: 'House bill amount', cmp: (a, b) => (b.house_php ?? -1) - (a.house_php ?? -1) },
  nep: { label: 'NEP amount', cmp: (a, b) => (b.nep_php ?? -1) - (a.nep_php ?? -1) },
  change: { label: 'Size of change', cmp: (a, b) => Math.abs(b.delta_php ?? 0) - Math.abs(a.delta_php ?? 0) },
  title: { label: 'Name', cmp: (a, b) => a.title.localeCompare(b.title) },
};

export default function Home() {
  const { scope, overview, config } = usePortal();
  useTitle(`Every FY 2027 project · ${shortNameOf(config)}`);
  const datasets = overview.status === 'ready' ? overview.value.data.datasets : [];
  return (
    <main className="page main">
      <Await state={scope} what="projects">
        {(s) => <Projects scope={s} datasets={datasets} />}
      </Await>
    </main>
  );
}

/** Group wording from the API (label, sub, help), falling back to the row's own label. */
type GroupWords = Pick<GroupInfo, 'label' | 'sub' | 'help'>;

function groupInfo(datasets: DatasetInfo[], rows: ScopedProject[]): Record<BridgeGroup, GroupWords> {
  const fromApi = datasets[0]?.bridge.groups;
  const out = {} as Record<BridgeGroup, GroupWords>;
  for (const g of BRIDGE_GROUPS) {
    out[g] = fromApi?.[g] ?? { label: rows.find((r) => r.bridge_group === g)?.group_label ?? g, sub: '', help: '' };
  }
  return out;
}

function Projects({ scope, datasets }: { scope: ScopeResult; datasets: DatasetInfo[] }) {
  const { config, districts } = usePortal();
  const { hash } = useLocation();

  // #offices and #projects links land on their section once it has rendered.
  useEffect(() => {
    if (!hash) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' });
  }, [hash, districts.status]);

  // The disclaimers of every response on this page: the project lists' and the districts'.
  const disclaimers = useMemo(() => {
    const byId = new Map<string, Disclaimer>(scope.disclaimers.map((d) => [d.id, d]));
    if (districts.status === 'ready') for (const env of districts.value) for (const d of env.disclaimers) if (!byId.has(d.id)) byId.set(d.id, d);
    return [...byId.values()];
  }, [scope.disclaimers, districts]);
  const name = shortNameOf(config);
  const all = scope.projects;
  const summary = useMemo(() => summarise(all), [all]);
  const groups = useMemo(() => groupInfo(datasets, all), [datasets, all]);
  // Where each project is, as far as its title says (src/lib/areas.ts).
  const areas = useMemo(() => {
    const read = areaReader(config);
    return new Map(all.map((p) => [p.key, read(p.title)]));
  }, [all, config]);
  const areaTiles = useMemo(() => tilesOf(config, all, areas), [config, all, areas]);
  // Barangays as a ranked bar chart: largest House bill amount first, those with nothing named last.
  const barangayBars = useMemo(
    () => areaTiles.filter((t) => t.kind === 'barangay').sort((x, y) => y.house_php - x.house_php || y.rows - x.rows || x.label.localeCompare(y.label)),
    [areaTiles],
  );
  const barMax = Math.max(1, ...barangayBars.map((t) => t.house_php));
  const whereParts = useMemo(() => whereOf(all, areas, areaTiles), [all, areas, areaTiles]);
  const programName = (k: DatasetKey) => datasets.find((d) => d.key === k)?.short ?? k.toUpperCase();

  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const program = (params.get('program') ?? '') as DatasetKey | '';
  const status = (params.get('status') ?? '') as BridgeGroup | '';
  const why = params.get('why') ?? '';
  const office = params.get('office') ?? '';
  const area = params.get('area') ?? '';
  const sort = (params.get('sort') as Sort) in SORTS ? (params.get('sort') as Sort) : 'house';
  const [shown, setShown] = useState(PAGE);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setShown(PAGE);
  };

  const pickArea = (key: string) => {
    setParam('area', key);
    if (key) document.getElementById('projects')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  // DPWH offices among the rows, largest first, for the Office filter.
  const offices = useMemo(() => {
    const n = new Map<string, number>();
    for (const p of all) if (p.office) n.set(p.office, (n.get(p.office) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en', { numeric: true }));
  }, [all]);

  const reasons = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of all) for (const r of p.reasons) seen.set(`${r.kind}:${r.label}`, r.kind === 'office' ? `Office: ${shortOffice(r.label)}` : `Title names ${r.label}`);
    return [...seen.entries()];
  }, [all]);

  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = all.filter((p) => {
      if (program && p.dataset !== program) return false;
      if (status && p.bridge_group !== status) return false;
      if (why && !p.reasons.some((r) => `${r.kind}:${r.label}` === why)) return false;
      if (office && p.office !== office) return false;
      if (area && !areaKeys(areas.get(p.key)!).includes(area)) return false;
      if (words.length) {
        const hay = [p.title, p.program, p.pap, p.office, p.region].join(' ').toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    return rows.sort((a, b) => SORTS[sort].cmp(a, b) || a.title.localeCompare(b.title));
  }, [all, q, program, status, why, office, area, areas, sort]);
  const filteredSummary = useMemo(() => summarise(filtered), [filtered]);
  const narrowed = filtered.length !== all.length;

  return (
    <>
      <PageHead
        eyebrow={<>FY 2027<span className="sep">·</span>NEP and House Bill 10858<span className="sep">·</span>{name}</>}
        title={`${plural(summary.rows, 'project')} for ${name} in the 2027 budget`}
      />

      <Hero summary={summary} />

      {areaTiles.length > 0 && (
        <section className="section" id="barangays" aria-labelledby="areas-h">
          <h2 id="areas-h" className="section-h">Find your barangay</h2>
          <p className="chart-sub">House bill amount of the projects that name each barangay. Tap one to see its projects.</p>
          <div className="rank" role="group" aria-label="Filter by barangay">
            {barangayBars.map((t) => {
              const active = area === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  className={`rk-row${active ? ' active' : ''}${area && !active ? ' dim' : ''}`}
                  disabled={!t.rows}
                  aria-pressed={active}
                  title={t.rows ? `${t.label}: ${phpFull(t.house_php)} in the House bill, ${plural(t.rows, 'project')}` : `No 2027 project names ${t.label}`}
                  onClick={() => pickArea(active ? '' : t.key)}
                >
                  <span className="rk-name">{t.label}</span>
                  <span className="rk-track" aria-hidden="true">
                    {t.rows > 0 && <span className="rk-fill" style={{ width: `${(t.house_php / barMax) * 100}%` }} />}
                  </span>
                  <span className="rk-value num">{t.rows ? php(t.house_php) : '—'}</span>
                  <span className="rk-count">{t.rows ? plural(t.rows, 'project') : 'none named'}</span>
                </button>
              );
            })}
          </div>

          <h3 className="chart-h">Where the {count(summary.rows)} projects are</h3>
          <Segments
            label={`Where the ${count(summary.rows)} projects are`}
            parts={whereParts.map((w) => ({
              key: w.key,
              label: w.label,
              value: w.rows,
              detail: `${plural(w.rows, 'project')} · ${php(w.house_php)} in the House bill`,
              className: `seg-${w.kind}`,
              active: w.key ? area === w.key : false,
              onClick: w.key ? () => pickArea(area === w.key ? '' : w.key) : undefined,
            }))}
          />
          <p className="fine">
            The documents give no barangay, so it is read from each project’s name; a project that names two counts in both.{' '}
            <Link to="/about">How this works</Link>
          </p>
        </section>
      )}

      <section className="section" aria-labelledby="groups-h">
        <h2 id="groups-h" className="section-h">What the House bill did to them</h2>
        <Segments
          label="Projects by what the House bill did to them"
          parts={BRIDGE_GROUPS.filter((g) => summary.groups[g].rows).map((g) => ({
            key: g,
            label: groups[g].label,
            value: summary.groups[g].rows,
            detail: `${plural(summary.groups[g].rows, 'project')} · ${groupAmount(g, summary.groups[g])}`,
            className: `g-${g}`,
            active: status === g,
            onClick: () => setParam('status', status === g ? '' : g),
          }))}
          legend={false}
        />
        <div className="groups" role="group" aria-label="Filter by status">
          {BRIDGE_GROUPS.filter((g) => summary.groups[g].rows).map((g) => {
            const cell = summary.groups[g];
            const info = groups[g];
            const active = status === g;
            return (
              <button
                key={g}
                type="button"
                className={`group-tile${active ? ' active' : ''}`}
                aria-pressed={active}
                title={info.help}
                onClick={() => setParam('status', active ? '' : g)}
              >
                <span className="group-label"><span className={`status-dot g-${g}`} aria-hidden="true" />{info.label}</span>
                <span className="group-count num">{count(cell.rows)}</span>
                <span className="group-php num">{groupAmount(g, cell)}</span>
              </button>
            );
          })}
        </div>
        <p className="fine">“House bill only” and “NEP only” are leads to check, not confirmed changes.</p>
      </section>

      <section className="section" id="projects" aria-labelledby="list-h">
        <div className="list-head">
          <h2 id="list-h" className="section-h">
            {narrowed ? `${count(filtered.length)} of ${plural(all.length, 'project')}` : `Every project (${count(all.length)})`}
          </h2>
          <button type="button" className="button button-quiet" onClick={() => downloadText(`${config.id}-fy2027-projects.csv`, projectsCsv(filtered, areas))}>
            Download CSV{narrowed ? ` (${count(filtered.length)})` : ''}
          </button>
        </div>

        <div className="toolbar">
          <label className="field field-grow">
            <span className="label">Search</span>
            <input type="search" value={q} placeholder="Barangay, road, school, office…" onChange={(e) => setParam('q', e.target.value)} />
          </label>
          {areaTiles.length > 0 && (
            <label className="field">
              <span className="label">Barangay</span>
              <select value={area} onChange={(e) => setParam('area', e.target.value)}>
                <option value="">Anywhere</option>
                {areaTiles.filter((t) => t.rows).map((t) => <option key={t.key} value={t.key}>{t.label} ({count(t.rows)})</option>)}
              </select>
            </label>
          )}
          <label className="field">
            <span className="label">Status</span>
            <select value={status} onChange={(e) => setParam('status', e.target.value)}>
              <option value="">Any status</option>
              {BRIDGE_GROUPS.filter((g) => summary.groups[g].rows).map((g) => (
                <option key={g} value={g}>{groups[g].label} ({count(summary.groups[g].rows)})</option>
              ))}
            </select>
          </label>
        </div>
        <details className="more-filters" open={Boolean(program || office || why || params.get('sort'))}>
          <summary>More filters and sorting</summary>
          <div className="toolbar">
            <label className="field">
              <span className="label">Program</span>
              <select value={program} onChange={(e) => setParam('program', e.target.value)}>
                <option value="">All programs</option>
                {(Object.keys(summary.byDataset) as DatasetKey[]).map((k) => (
                  <option key={k} value={k}>{programName(k)} ({count(summary.byDataset[k]!.rows)})</option>
                ))}
              </select>
            </label>
            {offices.length > 1 && (
              <label className="field">
                <span className="label">DPWH office</span>
                <select value={office} onChange={(e) => setParam('office', e.target.value)}>
                  <option value="">Any office</option>
                  {offices.map(([o, n]) => <option key={o} value={o}>{shortOffice(o)} ({count(n)})</option>)}
                </select>
              </label>
            )}
            {reasons.length > 1 && (
              <label className="field">
                <span className="label">Listed because</span>
                <select value={why} onChange={(e) => setParam('why', e.target.value)}>
                  <option value="">Any reason</option>
                  {reasons.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </label>
            )}
            <label className="field">
              <span className="label">Sort by</span>
              <select value={sort} onChange={(e) => setParam('sort', e.target.value === 'house' ? '' : e.target.value)}>
                {(Object.keys(SORTS) as Sort[]).map((k) => <option key={k} value={k}>{SORTS[k].label}</option>)}
              </select>
            </label>
          </div>
        </details>
        <div>
        </div>

        {narrowed && (
          <p className="filter-sums">
            These {count(filtered.length)}: NEP {php(filteredSummary.nep.php)} on {count(filteredSummary.nep.rows)}
            <span className="sep">·</span>House bill {php(filteredSummary.house.php)} on {count(filteredSummary.house.rows)}
            <span className="sep">·</span>
            <button type="button" className="link-button" onClick={() => { setParams(new URLSearchParams(), { replace: true }); setShown(PAGE); }}>
              Clear filters
            </button>
          </p>
        )}

        <ProjectTable rows={filtered.slice(0, shown)} programName={programName} areas={areas} />

        {filtered.length === 0 && <p className="state">No project matches. Try fewer words or clear the filters.</p>}
        {filtered.length > shown && (
          <div className="more">
            <span className="muted">Showing {count(shown)} of {count(filtered.length)}</span>
            <button type="button" className="button" onClick={() => setShown((n) => n + PAGE)}>Show {count(Math.min(PAGE, filtered.length - shown))} more</button>
            <button type="button" className="button button-quiet" onClick={() => setShown(filtered.length)}>Show all</button>
          </div>
        )}

        <p className="fine">
          Amounts are in pesos, as each document publishes them. A dash means that document has no such line. The NEP
          and the House bill are two versions of one budget: their totals are compared, never added.
        </p>
      </section>

      <OfficesSection />

      <Disclaimers items={disclaimers} compact />
    </>
  );
}

/** "Bohol 1st District Engineering Office" → "Bohol 1st DEO", for tight spaces. */
function shortOffice(office: string): string {
  return office.replace(/ District Engineering Office$/, ' DEO');
}

function groupAmount(g: BridgeGroup, c: { nep_php: number; house_php: number; rows: number }): string {
  if (!c.rows) return '—';
  switch (g) {
    case 'nep_only': return php(c.nep_php);
    case 'increased':
    case 'decreased':
    case 'scope_review': return phpDelta(c.house_php - c.nep_php);
    default: return php(c.house_php);
  }
}

interface AreaTile { key: string; label: string; kind: 'barangay' | 'none' | 'neighbour'; rows: number; house_php: number }

/** One tile per barangay (even with nothing named, so a reader finds theirs), then the rest. */
function tilesOf(config: PortalConfig, all: ScopedProject[], areas: Map<string, Area>): AreaTile[] {
  const barangays = config.scope.barangays ?? [];
  if (!barangays.length) return [];
  const tiles: AreaTile[] = [
    ...barangays.map((b): AreaTile => ({ key: b.name, label: b.name, kind: 'barangay', rows: 0, house_php: 0 })),
    { key: NO_BARANGAY, label: 'No barangay named', kind: 'none', rows: 0, house_php: 0 },
    ...(config.scope.neighbours ?? []).map((n): AreaTile => ({ key: neighbourKey(n.label), label: n.label, kind: 'neighbour', rows: 0, house_php: 0 })),
  ];
  const byKey = new Map(tiles.map((t) => [t.key, t]));
  for (const p of all) {
    for (const k of areaKeys(areas.get(p.key)!)) {
      const t = byKey.get(k);
      if (!t) continue;
      t.rows++;
      t.house_php += p.house_php ?? 0;
    }
  }
  return tiles.filter((t) => t.kind !== 'neighbour' || t.rows);
}

/** Barangay named, none named, or a neighbour: each project is in exactly one, so these add up. */
function whereOf(all: ScopedProject[], areas: Map<string, Area>, tiles: AreaTile[]) {
  const parts = [
    { key: '', label: 'Names a barangay', kind: 'barangay', rows: 0, house_php: 0 },
    ...tiles.filter((t) => t.kind !== 'barangay').map((t) => ({ key: t.key, label: t.label, kind: t.kind as string, rows: 0, house_php: 0 })),
  ];
  for (const p of all) {
    const a = areas.get(p.key)!;
    const part = a.barangays.length ? parts[0] : parts.find((x) => x.key === areaKeys(a)[0]);
    if (!part) continue;
    part.rows++;
    part.house_php += p.house_php ?? 0;
  }
  return parts.filter((x) => x.rows);
}

interface Part { key: string; label: string; value: number; detail: string; className: string; active?: boolean; onClick?: () => void }

/**
 * One whole split into parts, widths in proportion. A part prints its number
 * only when it is wide enough to hold it; the legend carries every number.
 */
function Segments({ label, parts, legend = true }: { label: string; parts: Part[]; legend?: boolean }) {
  const total = parts.reduce((a, x) => a + x.value, 0) || 1;
  return (
    <>
      <div className="segs" role="group" aria-label={label}>
        {parts.map((x) => {
          const share = x.value / total;
          const inner = share >= 0.06 ? <span className="num">{count(x.value)}</span> : null;
          const props = { className: `seg ${x.className}${x.active ? ' active' : ''}`, style: { flexGrow: x.value }, title: `${x.label}: ${x.detail}` };
          return x.onClick ? (
            <button key={x.key} type="button" aria-pressed={Boolean(x.active)} aria-label={`${x.label}: ${x.detail}`} onClick={x.onClick} {...props}>{inner}</button>
          ) : (
            <span key={x.key} {...props}>{inner}</span>
          );
        })}
      </div>
      {legend && (
        <ul className="seg-legend">
          {parts.map((x) => (
            <li key={x.key}>
              <span className={`seg-key ${x.className}`} aria-hidden="true" />
              <strong>{x.label}</strong> <span className="muted">{x.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The two versions side by side on one scale, and the three counts a reader asks for first. */
function Hero({ summary }: { summary: Summary }) {
  const max = Math.max(1, summary.nep.php, summary.house.php);
  const versions = [
    { key: 'nep', label: 'NEP', sub: 'the President’s budget', php: summary.nep.php, rows: summary.nep.rows },
    { key: 'house', label: 'House bill', sub: 'what the House passed', php: summary.house.php, rows: summary.house.rows },
  ];
  return (
    <div className="hero">
      <div className="hero-chart" role="img" aria-label={`NEP ${php(summary.nep.php)} on ${plural(summary.nep.rows, 'project')}; House bill ${php(summary.house.php)} on ${plural(summary.house.rows, 'project')}`}>
        {versions.map((v) => (
          <div className={`hero-row hero-${v.key}`} key={v.key} title={`${v.label}: ${phpFull(v.php)} on ${plural(v.rows, 'project')}`}>
            <span className="hero-label"><strong>{v.label}</strong><span>{v.sub}</span></span>
            <span className="hero-track"><span className="hero-fill" style={{ width: `${(v.php / max) * 100}%` }} /></span>
            <span className="hero-value num">{php(v.php)}<span>{plural(v.rows, 'project')}</span></span>
          </div>
        ))}
        <p className="fine">Two versions of one budget: compared, never added.</p>
      </div>
      <dl className="hero-stats">
        <div>
          <dt className="label">Projects</dt>
          <dd className="stat num">{count(summary.rows)}</dd>
        </div>
        <div>
          <dt className="label">In the House bill only</dt>
          <dd className="stat num stat-accent">{count(summary.groups.house_only.rows)}</dd>
          <dd className="stat-sub">{php(summary.groups.house_only.house_php)}</dd>
        </div>
        <div>
          <dt className="label">In the NEP only</dt>
          <dd className="stat num">{count(summary.groups.nep_only.rows)}</dd>
          <dd className="stat-sub">{php(summary.groups.nep_only.nep_php)}</dd>
        </div>
      </dl>
    </div>
  );
}

function ProjectTable({ rows, programName, areas }: { rows: ScopedProject[]; programName: (k: DatasetKey) => string; areas: Map<string, Area> }) {
  if (!rows.length) return null;
  return (
    <div className="table" role="table" aria-label="Projects">
      <div className="tr th" role="row">
        <span role="columnheader">Project</span>
        <span role="columnheader">Status</span>
        <span role="columnheader" className="r">NEP</span>
        <span role="columnheader" className="r">House bill</span>
        <span role="columnheader" className="r">Change</span>
      </div>
      {rows.map((p) => (
        <div className="tr" role="row" key={p.key}>
          <span role="cell" className="td-project">
            <Link to={`/projects/${p.dataset}/${encodeURIComponent(p.id)}`} className="project-title" title={p.title}>{p.title}</Link>
            <span className="project-meta">
              <span className="label">{programName(p.dataset)}</span>
              {p.office && <span>{shortOffice(p.office)}</span>}
              {p.region && <span>{p.region}</span>}
              {areas.get(p.key)?.barangays.map((b) => <span key={b} className="tag tag-area">{b}</span>)}
              {areas.get(p.key)?.neighbour && <span className="tag tag-place">{areas.get(p.key)!.neighbour}</span>}
              <ReasonTags reasons={p.reasons} />
            </span>
          </span>
          <span role="cell" className="td-status"><StatusChip group={p.bridge_group} label={p.status_label} held={p.held} /></span>
          <span role="cell" className="r num" data-label="NEP">{php(p.nep_php)}</span>
          <span role="cell" className="r num strong" data-label="House bill">{php(p.house_php)}</span>
          <span role="cell" className={`r num delta ${(p.delta_php ?? 0) > 0 ? 'up' : (p.delta_php ?? 0) < 0 ? 'down' : ''}`} data-label="Change">
            {phpDelta(p.delta_php)}
          </span>
        </div>
      ))}
    </div>
  );
}
