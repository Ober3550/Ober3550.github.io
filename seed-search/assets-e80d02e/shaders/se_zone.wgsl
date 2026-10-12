// se_zone.wgsl - Space Exploration zone surface kernel (stage 1: elevation).
// Per invocation: SE elevation_nauvis (Elevation.at, NO starting lake - moons
// have none) -> f32 elevation, using the CPU-derived per-zone water controls
// (nsm/seg/water_level from surfaceParams: water_frequency/size).
// Later stages add ZoneTerrain temp/moist/aux + the alien-biomes classifier.
//
// Gen tables packed by gi (order must match the worker's SE registry):
//   0 (map_seed,900) 1 (map_seed,99584) 2 (map_seed,700) 3 (map_seed,1000)
//   4 (map_seed,1100) 5 (map_seed,500) 6 (map_seed,600)
// Modes: 0 elevation (outF = f32 e), 1 water mask (outIdx: 0 land 1 water
// 2 deep), 2 reserved.

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
    moisture_freq : f32,
    moisture_bias : f32,
    aux_freq : f32,
    aux_bias : f32,
    cold_size : f32,
    hot_size : f32,
    cold_freq : f32,
    hot_freq : f32,
    water_gate : f32,
    width : u32,
    height : u32,
    mode : u32,
};

@group(0) @binding(0) var<uniform>             P     : Params;
@group(0) @binding(1) var<storage, read>       perm1 : array<u32>;
@group(0) @binding(2) var<storage, read>       perm2 : array<u32>;
@group(0) @binding(3) var<storage, read>       grad  : array<f32>;
@group(0) @binding(4) var<storage, read>       sbytes: array<u32>;
@group(0) @binding(5) var<storage, read_write> outF  : array<f32>;
@group(0) @binding(6) var<storage, read_write> outIdx: array<u32>;
@group(0) @binding(7) var<storage, read>       rowsF : array<f32, 1872>; // 156 rows x 12
@group(0) @binding(8) var<storage, read>       rowsU : array<u32, 312>;  // flags,color

const GI_HILLS : u32 = 0u;
const GI_CLIFF : u32 = 1u;
const GI_BRIDGE: u32 = 2u;
const GI_MACRO1: u32 = 3u;
const GI_MACRO2: u32 = 4u;
const GI_PERS  : u32 = 5u;
const GI_DET   : u32 = 6u;
const GI_TQ    : u32 = 7u;   // temperature quick gens (map_seed+k, 5) x11
const GI_MQ    : u32 = 18u;  // moisture quick gens (map_seed+k, 6) x8
const GI_AQ    : u32 = 26u;  // aux quick gens      (map_seed+k, 7) x8
const GI_WATER : u32 = 34u;  // shared water noise gen (zone_seed, crc32("water"))
const GI_CRATER: u32 = 35u;  // shared crater noise gen (zone_seed, crc32("crater"))
const GI_TV    : u32 = 36u;  // per-row terrain-variation gens (zone_seed, tv_seed)

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

fn quickMO2(gi0 : u32, x : f32, y : f32, octaves : u32, is : f32, os : f32,
             oism : f32, oosm : f32, offx : f32, offy : f32) -> f32 {
    var acc : f32 = 0.0;
    var ins = is;
    var outs = os;
    for (var k : u32 = 0u; k < octaves; k = k + 1u) {
        acc = acc + basisG(gi0 + k, x, y, ins, offx, offy) * outs;
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

fn elevationAt(x : f32, y : f32) -> f32 {
    let hills = abs(multioctaveG(GI_HILLS, x, y, 4u, 2.0, P.is_hills));
    let cliff_level = clamp(0.65 + basisG(GI_CLIFF, x, y, P.is_cliff, 0.0, 0.0) * P.os_cliff, 0.15, 1.15);
    let plateaus = 0.5 + clamp((hills - cliff_level) * 10.0, -0.5, 0.5);
    let hp = 0.1 * hills + 0.8 * plateaus;
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
    return max(main - P.water_level * 2.0, island);
}

// ── ZoneTerrain fields (per-zone controls) ────────────────────────────────
// Port of terrain.zig ZoneTerrain.temperature/moisture/aux (AB formulas).
fn temperatureAt(x : f32, y : f32) -> f32 {
    let cold = P.cold_size;
    let hot = P.hot_size;
    let cf = P.cold_freq;
    let hf = P.hot_freq;
    let average = 50.0 - 125.0 * cold / 6.0 + 125.0 * hot / 6.0;
    let range = 50.0 * (clamp(cold, 0.0, 1.0) / 2.0 + cold / 10.0) + 50.0 * (clamp(hot, 0.0, 1.0) / 2.0 + hot / 10.0);
    let bfreq = (cf + hf) / 2.0;
    let mn = quickMO2(GI_TQ, x * bfreq, y * bfreq, 11u, 1.0 / 32.0, 1.0 / 20.0, 0.5, 1.4, 0.0, 40000.0);
    let base = average + range * clamp(0.25 * mn, -1.0, 1.0);
    let hn = quickMO2(GI_TQ, x * hf, y * hf, 10u, 1.0 / 8.0, 1.0 / 20.0, 0.5, 1.5, 40000.0, 0.0);
    let hotspots = (clamp(hot, 0.0, 1.0) / 2.0 + hot / 10.0) * 40.0 * clamp(-0.45 + hot / 6.0 + hn, 0.0, 4.0);
    let cn = quickMO2(GI_TQ, x * cf, y * cf, 10u, 1.0 / 30.0, 1.0 / 20.0, 0.5, 1.5, -40000.0, 0.0);
    let coldspots = (clamp(cold, 0.0, 1.0) / 2.0 + cold / 10.0) * 40.0 * clamp(-0.45 + cold / 6.0 + cn, 0.0, 4.0);
    let combined = clamp(base - coldspots + hotspots, -50.0, 110.0);
    let va = clamp(combined - 100.0, 0.0, 10.0);
    let vhn = quickMO2(GI_TQ, x, y, 6u, 1.0, 1.0 / 20.0, 0.5, 1.5, 0.0, 0.0);
    let vh = clamp(0.5 + vhn, 0.0, 10.0) * va * 4.0;
    return clamp(combined + vh, -20.0, 150.0);
}
fn moistureAt(x : f32, y : f32) -> f32 {
    let f = P.moisture_freq;
    let q = quickMO2(GI_MQ, x * f, y * f, 8u, 1.0 / 2000.0, 1.0 / 8.0, 3.0, 0.5, 30000.0, 0.0);
    return clamp(0.5 + 2.2 * P.moisture_bias + 2.5 * q, 0.0, 1.0);
}
fn auxAt(x : f32, y : f32) -> f32 {
    let f = P.aux_freq;
    let q = quickMO2(GI_AQ, x * f, y * f, 8u, 1.0 / 5000.0, 1.0 / 4.0, 3.0, 0.5, 20000.0, 0.0);
    return clamp(0.45 + 2.2 * P.aux_bias + 2.2 * q, 0.0, 1.0);
}

// ── Alien-biomes classifier (biome.zig classifyBest, f32) ───────────────
// multioctave_noise (noise.zig multioctaveNoiseOffset): single gen per slot,
// octaves coarsen coordmul*=0.5, amplitude *= 1/persistence, offsets folded in
// tile space before coordmul; result = value/sqrt(sumsq) * output_scale.
fn multiOff(gi : u32, x : f32, y : f32, octaves : u32, persistence : f32,
            ins : f32, outs : f32, ox : f32, oy : f32) -> f32 {
    let xo = x + ox;
    let yo = y + oy;
    let ampmul = 1.0 / persistence;
    var value : f32 = 0.0;
    var amplitude : f32 = 1.0;
    var coordmul : f32 = 1.0;
    var sumsq : f32 = 0.0;
    var k : f32 = 0.0;
    for (var i : u32 = 0u; i < octaves; i = i + 1u) {
        let x_arg = (k * 17.17) / ins + xo * coordmul;
        let y_arg = yo * coordmul;
        value = value + basisG(gi, x_arg, y_arg, ins, 0.0, 0.0) * amplitude;
        sumsq = sumsq + amplitude * amplitude;
        coordmul = coordmul * 0.5;
        amplitude = amplitude * ampmul;
        k = k + 1.0;
    }
    return value / sqrt(sumsq) * outs;
}

fn plateauPeak(v : f32, lo : f32, hi : f32) -> f32 {
    let range = abs(lo - hi) / 2.0;
    let center = (lo + hi) / 2.0;
    return min((range - abs(v - center)) * 20.0, 1.0);
}

// Winning land-biome packed color (0x00RRGGBB), args = t,m,a,e (f32 like the
// engine's classify f32 math). Water handled by the caller gate.
fn classifierColor(x : f32, y : f32, t : f32, m : f32, a : f32, e : f32) -> u32 {
    let water_noise = multiOff(GI_WATER, x, y, 5u, 0.75, 1.0 / 6.0 / 8.0, 0.666, 0.0, 0.0);
    let crater_noise = multiOff(GI_CRATER, x, y, 5u, 0.75, 1.0 / 6.0, 0.666, 0.0, 0.0);
    let beach = min(0.0, e / 5.0 - 1.0);
    var best : f32 = -3.0e38;
    var col : u32 = 0u;
    for (var r : u32 = 0u; r < 156u; r = r + 1u) {
        let base = r * 12u;
        var f : f32 = 1.0e38;
        let fl = rowsU[r * 2u];
        if ((fl & 1u) != 0u) { f = min(f, plateauPeak(t, rowsF[base], rowsF[base + 4u])); }
        if ((fl & 2u) != 0u) { f = min(f, plateauPeak(m, rowsF[base + 1u], rowsF[base + 5u])); }
        if ((fl & 4u) != 0u) { f = min(f, plateauPeak(a, rowsF[base + 2u], rowsF[base + 6u])); }
        if ((fl & 8u) != 0u) { f = min(f, plateauPeak(e, rowsF[base + 3u], rowsF[base + 7u])); }
        if (rowsF[base + 8u] < 0.0) { f = f + beach; }
        let wc = rowsF[base + 9u];
        if (wc != 0.0) { f = f + wc * water_noise; }
        if ((fl & 16u) != 0u) { f = f + (-0.6 - 0.7 * crater_noise); }
        f = f + 0.5 * multiOff(GI_TV + r, x, y, 6u, 0.75, 1.0 / 6.0 / 4.0, 0.666, 1000.0, 0.0);
        if (f > best) { best = f; col = rowsU[r * 2u + 1u]; }
    }
    return col;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    if (gid.x >= P.width || gid.y >= P.height) { return; }
    let x = P.origin_x + f32(gid.x);
    let y = P.origin_y + f32(gid.y);
    let i = gid.y * P.width + gid.x;
    let has_water = P.water_gate > 0.5;
    var e : f32 = 1.0;
    if (has_water) { e = elevationAt(x, y); }
    if (P.mode == 5u) {
        if (has_water && e < 0.0) {
            if (e < -5.0) { outIdx[i] = 0x00264049u; } // deepwater
            else { outIdx[i] = 0x0033535Fu; }          // water
            return;
        }
        outIdx[i] = classifierColor(x, y, temperatureAt(x, y), moistureAt(x, y), auxAt(x, y), e);
        return;
    }
    if (P.mode == 0u) { outF[i] = e; return; }
    if (P.mode == 2u) { outF[i] = temperatureAt(x, y); return; }
    if (P.mode == 3u) { outF[i] = moistureAt(x, y); return; }
    if (P.mode == 4u) { outF[i] = auxAt(x, y); return; }
    var m : u32 = 0u;
    if (e < 0.0) { m = 1u; }
    if (e < -2.0) { m = 2u; }
    outIdx[i] = m;
}
