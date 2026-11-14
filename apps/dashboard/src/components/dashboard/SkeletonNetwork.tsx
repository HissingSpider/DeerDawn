// Lightweight ghost constellation — the single, coherent loader for the context
// graph. Used both while the (code-split) ContextNetwork chunk downloads and
// while its data fetches, so the user never sees a loader swap. Kept in its own
// tiny module so the home page can render it as the dynamic-import fallback
// without pulling in the heavy graph component.

const SK_NODES = [
  { x: .5, y: .45, r: 8 }, { x: .3, y: .35, r: 4 }, { x: .7, y: .35, r: 5 }, { x: .25, y: .55, r: 4 },
  { x: .5, y: .65, r: 5 }, { x: .75, y: .55, r: 4 }, { x: .6, y: .28, r: 4 }, { x: .38, y: .62, r: 4 },
];
const SK_EDGES: [number, number][] = [[0, 1], [0, 2], [0, 4], [1, 3], [2, 5], [1, 6], [4, 7]];

export function SkeletonNetwork() {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <svg width="100%" height="100%" style={{ display: 'block' }}>
        {SK_EDGES.map(([a, b], i) => {
          const na = SK_NODES[a], nb = SK_NODES[b];
          return <line key={i} x1={`${na.x * 100}%`} y1={`${na.y * 100}%`} x2={`${nb.x * 100}%`} y2={`${nb.y * 100}%`} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />;
        })}
        {SK_NODES.map((nd, i) => (
          <circle key={i} cx={`${nd.x * 100}%`} cy={`${nd.y * 100}%`} r={nd.r}
            fill="rgba(255,255,255,0.05)" style={{ animation: `dd-sk-pulse 1.8s ease-in-out ${i * .15}s infinite` }} />
        ))}
      </svg>
      <style>{`@keyframes dd-sk-pulse{0%,100%{opacity:.3}50%{opacity:.8}}`}</style>
    </div>
  );
}
