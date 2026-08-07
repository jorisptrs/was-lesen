import type { PaceStats } from "../lib/tallyCsv";

/** A compact range chart of members' reading paces (pages / 2 weeks): one row per member from
 * their low to high, sorted slowest-first, with the group median marked. Shows the spread so the
 * group can see the lower bound without adopting it. */
export function PaceGraph({ stats }: { stats: PaceStats }) {
  const rows = [...stats.perMember].sort((a, b) => a.low - b.low || a.high - b.high);
  const W = 328;
  const nameW = 74;
  const padR = 10;
  const rowH = 18;
  const topH = 13; // room for the median label above the plot
  const axisH = 15;
  const plotW = W - nameW - padR;
  const niceMax = Math.max(50, Math.ceil(stats.max / 50) * 50);
  const x = (v: number) => nameW + (v / niceMax) * plotW;
  const bodyH = rows.length * rowH;
  const H = topH + bodyH + axisH;
  const short = (n: string) => (n.length > 11 ? `${n.slice(0, 10)}…` : n);
  const medianX = x(stats.median);
  const medianAnchor = medianX > nameW + plotW * 0.7 ? "end" : "middle";

  return (
    <svg className="pace-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Reading pace by member">
      <line className="pg-median" x1={medianX} x2={medianX} y1={topH} y2={topH + bodyH} />
      <text className="pg-axis pg-median-lbl" x={medianX} y={topH - 4} textAnchor={medianAnchor}>
        median {stats.median}
      </text>
      {rows.map((m, i) => {
        const y = topH + i * rowH + rowH / 2;
        return (
          <g key={m.name}>
            <text className="pg-name" x={nameW - 6} y={y} textAnchor="end" dominantBaseline="central">
              {short(m.name)}
            </text>
            <line className="pg-track" x1={nameW} x2={x(niceMax)} y1={y} y2={y} />
            <line className="pg-range" x1={x(m.low)} x2={x(m.high)} y1={y} y2={y} />
            <circle className="pg-dot" cx={x(m.low)} cy={y} r={2.4} />
            {m.high !== m.low && <circle className="pg-dot" cx={x(m.high)} cy={y} r={2.4} />}
          </g>
        );
      })}
      <text className="pg-axis" x={nameW} y={H - 3} textAnchor="start">
        0
      </text>
      <text className="pg-axis" x={x(niceMax)} y={H - 3} textAnchor="end">
        {niceMax} p/2wk
      </text>
    </svg>
  );
}
