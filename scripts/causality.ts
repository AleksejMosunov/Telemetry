import { readFileSync, writeFileSync } from 'fs';
import { parseAimCsv, ch } from '../src/core/parse';
import { makeProjector, project } from '../src/core/geo';
import { splitLaps, cleanLaps, buildCenterline, detectCorners } from '../src/core/track';
import { makeGrid } from '../src/core/align';
import { buildLapTrace } from '../src/core/analysis';

const DIR = '/Users/macbook/Documents/karting/telemetry/csv';
const A = parseAimCsv(readFileSync(`${DIR}/1.csv`, 'utf8'), 'A');
const B = parseAimCsv(readFileSync(`${DIR}/2.csv`, 'utf8'), 'B');
const lapsA = cleanLaps(splitLaps(A)), lapsB = cleanLaps(splitLaps(B));
const bestA = lapsA.reduce((a, b) => (a.time <= b.time ? a : b));
const latA = ch(A, 'GPS Latitude'), lonA = ch(A, 'GPS Longitude');
const proj = makeProjector(latA[bestA.i0], lonA[bestA.i0]);
const bx: number[] = [], by: number[] = [];
for (let i = bestA.i0; i < bestA.i1; i++) { const [x, y] = project(proj, latA[i], lonA[i]); bx.push(x); by.push(y); }
const cl = buildCenterline(bx, by, proj, 1.0, 6);
const grid = makeGrid(cl.length, 1.0);
const corners = detectCorners(cl);

const corr = (x: number[], y: number[]) => {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy);
};

console.log('=== ПРИЧИННОСТЬ: связь подруливаний и времени круга ВНУТРИ одного стинта ===');
for (const [name, S, laps] of [['A', A, lapsA], ['B', B, lapsB]] as const) {
  const yr = ch(S, 'YawRate');
  const revs: number[] = [], times: number[] = [];
  for (const l of laps) {
    const n = l.i1 - l.i0; const y = new Float64Array(n);
    for (let k = 0; k < n; k++) { let a = 0, c = 0; for (let j = -2; j <= 2; j++) { const i = l.i0 + k + j; if (i >= l.i0 && i < l.i1) { a += yr[i]; c++; } } y[k] = a / c; }
    let r = 0;
    for (let k = 2; k < n; k++) { const d1 = y[k-1]-y[k-2], d2 = y[k]-y[k-1]; if (d1*d2 < 0 && Math.abs(d2) > 3) r++; }
    revs.push(r); times.push(l.time);
  }
  const r = corr(revs, times);
  console.log(`  ${name}: корреляция(подруливания, время круга) = ${r.toFixed(3)}   n=${laps.length}`);
}
const TA = lapsA.map(l => buildLapTrace(A, l, cl, grid));
const TB = lapsB.map(l => buildLapTrace(B, l, cl, grid));
for (const [name, T, laps] of [['A', TA, lapsA], ['B', TB, lapsB]] as const) {
  console.log(`  ${name}: корреляция(длина траектории, время круга) = ${corr(T.map(t=>t.pathLength), laps.map(l=>l.time)).toFixed(3)}`);
}

// --- SVG карта трассы для визуальной проверки нарезки ---
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (let i = 0; i < cl.n; i++) { minX=Math.min(minX,cl.x[i]); maxX=Math.max(maxX,cl.x[i]); minY=Math.min(minY,cl.y[i]); maxY=Math.max(maxY,cl.y[i]); }
const pad = 40, W = 900;
const sc = (W - 2*pad) / (maxX - minX);
const H = Math.round((maxY - minY) * sc + 2*pad);
const px = (x:number)=> pad + (x-minX)*sc;
const py = (y:number)=> H - pad - (y-minY)*sc;

const medV = (T:any[], i:number)=>{ const c=T.map((t:any)=>t.v[i%grid.length]).sort((a:number,b:number)=>a-b); return c[c.length>>1]; };
let vmin=1e9, vmax=-1e9;
for (let i=0;i<cl.n;i++){ const v=medV(TA,i); vmin=Math.min(vmin,v); vmax=Math.max(vmax,v); }
const col = (v:number)=>{ const f=(v-vmin)/(vmax-vmin); const h=240*(1-f)+0; return `hsl(${(1-f)*250},85%,${45+f*10}%)`; };

let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#0f1115"/>
<style>text{font-family:ui-sans-serif,system-ui,sans-serif}</style>`;
for (let i=0;i<cl.n;i++){
  const j=(i+1)%cl.n;
  svg += `<line x1="${px(cl.x[i]).toFixed(1)}" y1="${py(cl.y[i]).toFixed(1)}" x2="${px(cl.x[j]).toFixed(1)}" y2="${py(cl.y[j]).toFixed(1)}" stroke="${col(medV(TA,i))}" stroke-width="9" stroke-linecap="round"/>`;
}
for (const c of corners) {
  const i = Math.round(c.sApex) % cl.n;
  const nx = px(cl.x[i]), ny = py(cl.y[i]);
  const dx = cl.x[i]-(minX+maxX)/2, dy = cl.y[i]-(minY+maxY)/2;
  const L = Math.hypot(dx,dy)||1;
  const ox = nx + dx/L*30, oy = ny - dy/L*30;
  svg += `<line x1="${nx.toFixed(0)}" y1="${ny.toFixed(0)}" x2="${ox.toFixed(0)}" y2="${oy.toFixed(0)}" stroke="#5b6472" stroke-width="1.5"/>`;
  svg += `<circle cx="${ox.toFixed(0)}" cy="${oy.toFixed(0)}" r="13" fill="#171a21" stroke="#8b96a8" stroke-width="1.5"/>`;
  svg += `<text x="${ox.toFixed(0)}" y="${(oy+4).toFixed(0)}" fill="#e8ecf3" font-size="12" font-weight="600" text-anchor="middle">${c.id}</text>`;
}
const i0 = 0;
svg += `<circle cx="${px(cl.x[i0])}" cy="${py(cl.y[i0])}" r="7" fill="#fff"/>`;
svg += `<text x="${px(cl.x[i0])+12}" y="${py(cl.y[i0])-8}" fill="#fff" font-size="13" font-weight="700">СТАРТ/ФИНИШ</text>`;
svg += `<text x="${pad}" y="26" fill="#8b96a8" font-size="13">Трасса из GPS · ${cl.length.toFixed(0)} м · ${corners.length} поворотов · цвет = медианная скорость (${vmin.toFixed(0)}–${vmax.toFixed(0)} км/ч)</text>`;
svg += `</svg>`;
writeFileSync('/Users/macbook/Documents/karting/telemetry/track_check.svg', svg);
console.log('\nКарта трассы → track_check.svg');

console.log('\n=== ЗВЕНО ЦЕПИ: подруливания → длина траектории? ===');
for (const [name, S, laps, T] of [['A', A, lapsA, TA], ['B', B, lapsB, TB]] as const) {
  const yr = ch(S, 'YawRate'); const revs: number[] = [];
  for (const l of laps) {
    const n = l.i1 - l.i0; const y = new Float64Array(n);
    for (let k = 0; k < n; k++) { let a=0,c=0; for (let j=-2;j<=2;j++){const i=l.i0+k+j; if(i>=l.i0&&i<l.i1){a+=yr[i];c++;}} y[k]=a/c; }
    let r = 0;
    for (let k=2;k<n;k++){const d1=y[k-1]-y[k-2],d2=y[k]-y[k-1]; if(d1*d2<0&&Math.abs(d2)>3) r++;}
    revs.push(r);
  }
  console.log(`  ${name}: корреляция(подруливания, длина траектории) = ${corr(revs, (T as any[]).map(t=>t.pathLength)).toFixed(3)}`);
}
