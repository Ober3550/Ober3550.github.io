// nauvis.wgsl — single-dispatch base-Nauvis tile kernel (f32 engine semantics).
//
// One invocation per tile does the WHOLE terrain path:
//   elevation_nauvis -> base moisture_nauvis / aux_nauvis -> 19-land-tile
//   autoplace competition (expression_in_range + noise_layer_noise) with
//   water/deepwater water_base -> winning palette tile index (u32 outIdx).
// Gen tables (perm/grad/seed byte per BasisNoiseGen) are uploaded packed by gi;
// the order must match gpu-worker.js's GEN list (no dedupe, fixed slots).
//
// Modes: 0 elevation (outF = f32 e) | 1 fields (outF = aux, outF2 = m)
//        2 tiles (outIdx = palette index: 0 water, 1 deepwater, 2..20 land)

struct Params {
    origin_x : f32,
    origin_y : f32,
    nsm : f32,
    seg : f32,
    water_level : f32,
    is_hills : f32,
    is_cliff : f32,
    os_cliff : f32,
    is_bridge : f32,
    is_macro1 : f32,
    is_macro2 : f32,
    is_detail : f32,
    os_detail : f32,
    offx_detail : f32,
    is_pers : f32,
    os_pers : f32,
    offx_pers : f32,
    lake_x : f32,
    lake_y : f32,
    _pad : f32,
    width : u32,
    height : u32,
    mode : u32,
};

@group(0) @binding(0) var<uniform>             P      : Params;
@group(0) @binding(1) var<storage, read>       perm1  : array<u32>;
@group(0) @binding(2) var<storage, read>       perm2  : array<u32>;
@group(0) @binding(3) var<storage, read>       grad   : array<f32>;
@group(0) @binding(4) var<storage, read>       sbytes : array<u32>;
@group(0) @binding(5) var<storage, read>       rules  : array<f32>; // 12 f32 per land tile
@group(0) @binding(6) var<storage, read_write> outF   : array<f32>;
@group(0) @binding(7) var<storage, read_write> outF2  : array<f32>;
@group(0) @binding(8) var<storage, read_write> outIdx : array<u32>;

// ── gen slots (fixed, matches worker GEN list) ─────────────────────────────
const GI_HILLS : u32 = 0u;   // (map_seed,  900)
const GI_CLIFF : u32 = 1u;   // (map_seed, 99584)
const GI_BRIDGE: u32 = 2u;   // (map_seed,  700)
const GI_MACRO1: u32 = 3u;   // (map_seed, 1000)
const GI_MACRO2: u32 = 4u;   // (map_seed, 1100)
const GI_PERS  : u32 = 5u;   // (map_seed,  500)
const GI_DET   : u32 = 6u;   // (map_seed,  600)
const GI_FP    : u32 = 7u;   // (map_seed, 1800)
const GI_MQ    : u32 = 8u;   // moisture quick, octave k -> (map_seed+k, 6)
const GI_AQ    : u32 = 12u;  // aux quick, octave k -> (map_seed+k, 7)
const GI_SLK   : u32 = 16u;  // lake quick, octave k -> (map_seed+k, 14)
const GI_T0    : u32 = 20u;  // 19 land-tile noise gens (seeds 36,37,38,13,6..12,19..22,30..33)

const NLAND : u32 = 19u;

// rule layout per land tile: 12 floats
//  0..3  loa lom hia him      4..7 alt loa lom hia him
//  8 alt-active(0/1)          9 shore-active(0/1)     10 gen index (unused) 11 pad
fn ruleBase(t : u32) -> u32 { return t * 12u; }

fn basisG(gi : u32, x : f32, y : f32, scale : f32, offx : f32, offy : f32) -> f32 {
    let po = gi * 256u;
    let go = gi * 512u;
    let sb = sbytes[gi];
    let X = (x + offx) * scale;
    let Y = (y + offy) * scale;
    let ix = i32(floor(X));
    let iy = i32(floor(Y));
    let fx = X - f32(ix);
    let fy = Y - f32(iy);
    var sum : f32 = 0.0;
    for (var cy : i32 = 0; cy <= 1; cy = cy + 1) {
        for (var cx : i32 = 0; cx <= 1; cx = cx + 1) {
            let p1 = perm1[po + (bitcast<u32>(iy + cy) & 255u)];
            let p2 = perm2[po + (bitcast<u32>(ix + cx) & 255u)];
            let g2 = (p1 ^ sb ^ p2);
            let dx = fx - f32(cx);
            let dy = fy - f32(cy);
            let d2 = dx * dx + dy * dy;
            if (d2 < 1.0) {
                let w = 1.0 - d2;
                sum = sum + (grad[go + 2u * g2] * dx + grad[go + 2u * g2 + 1u] * dy) * w * w * w;
            }
        }
    }
    return sum;
}

fn multioctaveG(gi : u32, x : f32, y : f32, octaves : u32, ampmul : f32, is : f32) -> f32 {
    var value : f32 = 0.0;
    var amplitude : f32 = 1.0;
    var coordmul : f32 = 1.0;
    var sumsq : f32 = 0.0;
    var k : f32 = 0.0;
    for (var i : u32 = 0u; i < octaves; i = i + 1u) {
        let xa = (k * 17.17) / is + x * coordmul;
        let ya = y * coordmul;
        value = value + basisG(gi, xa, ya, is, 0.0, 0.0) * amplitude;
        sumsq = sumsq + amplitude * amplitude;
        coordmul = coordmul * 0.5;
        amplitude = amplitude * ampmul;
        k = k + 1.0;
    }
    return value / sqrt(sumsq);
}

fn quickMO(gi0 : u32, x : f32, y : f32, octaves : u32, is : f32, os : f32,
           oism : f32, oosm : f32, offx : f32) -> f32 {
    var acc : f32 = 0.0;
    var ins = is;
    var outs = os;
    for (var k : u32 = 0u; k < octaves; k = k + 1u) {
        acc = acc + basisG(gi0 + k, x, y, ins, offx, 0.0) * outs;
        ins = ins * oism;
        outs = outs * oosm;
    }
    return acc;
}

fn variablePersistenceG(gi : u32, x : f32, y : f32, octaves : u32, is : f32,
                        os : f32, offx : f32, persistence : f32) -> f32 {
    var is_k = is * 0.5;
    var acc : f32 = 0.0;
    for (var k : u32 = 0u; k < octaves; k = k + 1u) {
        acc = acc * persistence + basisG(gi, x, y, is_k, offx, 0.0);
        is_k = is_k * 0.5;
    }
    return acc * os * pow(2.0, f32(octaves));
}

// ── elevation ──────────────────────────────────────────────────────────────
fn hillsCliff(x : f32, y : f32) -> vec2<f32> {
    let hills = abs(multioctaveG(GI_HILLS, x, y, 4u, 2.0, P.is_hills));
    let cliff_level = clamp(0.65 + basisG(GI_CLIFF, x, y, P.is_cliff, 0.0, 0.0) * P.os_cliff, 0.15, 1.15);
    return vec2(hills, cliff_level);
}

fn elevationAt(x : f32, y : f32, lakeDist : f32, lakeNoise : f32) -> f32 {
    let hc = hillsCliff(x, y);
    let plateaus = 0.5 + clamp((hc.x - hc.y) * 10.0, -0.5, 0.5);
    let hp = 0.1 * hc.x + 0.8 * plateaus;
    let bb = abs(multioctaveG(GI_BRIDGE, x, y, 4u, 2.0, P.is_bridge));
    let bridges = 1.0 - 0.1 * bb - 0.9 * max(0.0, -0.1 + bb);
    let macroN = multioctaveG(GI_MACRO1, x, y, 2u, 1.0 / 0.6, P.is_macro1) *
                max(0.0, multioctaveG(GI_MACRO2, x, y, 1u, 1.0 / 0.6, P.is_macro2));
    let persist = clamp(variablePersistenceG(GI_PERS, x, y, 5u, P.is_pers, P.os_pers, P.offx_pers, 0.7) + 0.55, 0.5, 0.65);
    let detail = variablePersistenceG(GI_DET, x, y, 5u, P.is_detail, P.os_detail, P.offx_detail, persist);
    let dist = sqrt(x * x + y * y);
    let smm = clamp(dist * P.nsm / 2000.0, 0.0, 1.0);
    let main = 20.0 * (mix(0.5 * hp - 0.6, 1.9 * hp + 1.6, 0.1 + 0.5 * bridges) +
                       0.25 * detail + 3.0 * macroN * smm);
    let island = main + 20.0 * (2.5 - dist * P.seg / 200.0);
    let wlc = max(main - P.water_level * 2.0, island);
    let lakeBowl = 20.0 * (-3.0 + (lakeDist + lakeNoise) / 8.0) / 8.0;
    return min(wlc, lakeBowl);
}

// ── base fields ────────────────────────────────────────────────────────────
fn treesCutout(x : f32, y : f32) -> f32 {
    let nsm = P.nsm;
    let bridge = abs(multioctaveG(GI_BRIDGE, x, y, 4u, 2.0, nsm / 150.0));
    let hills = abs(multioctaveG(GI_HILLS, x, y, 4u, 2.0, nsm / 90.0));
    let fp = abs(multioctaveG(GI_FP, x, y, 4u, 2.0, nsm / 100.0));
    return min((bridge - 0.07) * 5.0, min((hills - 0.1) * 3.0, (fp - 0.07) * 3.0));
}
fn plateausAt(x : f32, y : f32) -> f32 {
    let hc = hillsCliff(x, y);
    return 0.5 + clamp((hc.x - hc.y) * 10.0, -0.5, 0.5);
}
fn moistureAt(x : f32, y : f32) -> f32 {
    let pl = plateausAt(x, y);
    let mq = quickMO(GI_MQ, x, y, 4u, 1.0 / 256.0, 0.125, 1.0 / 3.0, 1.5, 30000.0);
    let main = clamp(0.4 + mq - 0.08 * (pl - 0.6), 0.0, 1.0);
    let cut = treesCutout(x, y);
    return max(min(main, 0.45), main - 0.2 * max(0.0, 1.0 - cut * 1.5));
}
fn auxAt(x : f32, y : f32) -> f32 {
    let pl = plateausAt(x, y);
    let aq = quickMO(GI_AQ, x, y, 4u, 1.0 / 2048.0, 0.25, 3.0, 0.5, 20000.0);
    return clamp(0.5 + 0.06 * (pl - 0.4) + aq, 0.0, 1.0);
}

// ── expression_in_range(20,1,...) + tile competition ───────────────────────
fn tent(v : f32, lo : f32, hi : f32) -> f32 {
    let half = (hi - lo) * 0.5;
    let center = (lo + hi) * 0.5;
    return min((half - abs(v - center)) * 20.0, 1.0);
}
fn bandEir(aux : f32, m : f32, b : u32) -> f32 {
    let loa = rules[b]; let lom = rules[b + 1u]; let hia = rules[b + 2u]; let him = rules[b + 3u];
    return min(tent(aux, loa, hia), tent(m, lom, him));
}
fn tent5(v : f32, lo : f32, hi : f32) -> f32 {
    let half = (hi - lo) * 0.5;
    let center = (lo + hi) * 0.5;
    return (half - abs(v - center)) * 5.0;
}
fn tileProb(t : u32, aux : f32, m : f32, e : f32) -> f32 {
    let b = ruleBase(t);
    var v = bandEir(aux, m, b);
    if (rules[b + 8u] > 0.0) {
        v = max(v, min(tent(aux, rules[b + 4u], rules[b + 6u]), tent(m, rules[b + 5u], rules[b + 7u])));
    }
    if (rules[b + 9u] > 0.0) {
        // sand-1 shoreline: expression_in_range(5, inf, elevation, aux, -1.5,0.5,1.5,1)
        let shore = min(tent5(e, -1.5, 1.5), tent5(aux, 0.5, 1.0));
        v = max(v, shore);
    }
    return v;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    if (P.mode == 9u) { // debug: sentinel before the width guard
        if (gid.x == 0u && gid.y == 0u) { outF[0] = 12345.0; outF2[0] = 6789.0; outIdx[0] = 777u; }
        return;
    }
    if (gid.x >= P.width || gid.y >= P.height) { return; }
    let x = P.origin_x + f32(gid.x);
    let y = P.origin_y + f32(gid.y);
    let i = gid.y * P.width + gid.x;
    let d = sqrt((x - P.lake_x) * (x - P.lake_x) + (y - P.lake_y) * (y - P.lake_y));
    // lake noise (quick 4 oct, is 1/64 -> *2, os 6.4 -> *0.68)
    var ln : f32 = 0.0;
    var ins : f32 = 1.0 / 64.0;
    var outs : f32 = 6.4;
    for (var k : u32 = 0u; k < 4u; k = k + 1u) {
        ln = ln + basisG(GI_SLK + k, x, y, ins, 0.0, 0.0) * outs;
        ins = ins * 2.0;
        outs = outs * 0.68;
    }
    let e = elevationAt(x, y, d, ln);
    if (P.mode == 0u) { outF[i] = e; return; }
    let m = moistureAt(x, y);
    let a = auxAt(x, y);
    if (P.mode == 1u) { outF[i] = a; outF2[i] = m; return; }
    // tiles: water_base + 19-land argmax
    var best : f32 = -100000.0;
    var bestIdx : u32 = 0u;
    if (e < 0.0) { best = 100.0 * min(-e, 1.0); }
    if (e < -2.0) { let d2 = 200.0 * min(-2.0 - e, 1.0); if (d2 > best) { best = d2; bestIdx = 1u; } }
    for (var t : u32 = 0u; t < NLAND; t = t + 1u) {
        var p = tileProb(t, a, m, e);
        // per-tile noise_layer (4 oct, 0.7 persist, is 1/6, os 2/3)
        p = p + multioctaveG(GI_T0 + t, x, y, 4u, 1.0 / 0.7, 1.0 / 6.0) * (2.0 / 3.0);
        if (p > best) { best = p; bestIdx = 2u + t; }
    }
    outIdx[i] = bestIdx;
}
