// Port of terrain.zig `Elevation.at` (elevation_nauvis) — the full moon
// elevation composition + water threshold. Seven single BasisNoiseGens
// (seed1 = 900,99584,700,1000,1100,500,600) are packed into shared table
// buffers, selected by a generator index `gi`.
//
// Sub-noise terms are f32-exact vs the CPU (proven in Phase 1). The OUTER
// composition arithmetic is f64 on the CPU and f32 here, so expect ~1e-4 drift
// — the meaningful check is the water mask (elevation < 0). starting_lake is
// skipped when slake_n == 0 (SE moons have no lakes).

struct EParams {
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
    width : u32,
    height : u32,
    slake_n : u32,
};

@group(0) @binding(0) var<uniform>              P          : EParams;
@group(0) @binding(1) var<storage, read>        perm1      : array<u32>;  // 7*256
@group(0) @binding(2) var<storage, read>        perm2      : array<u32>;  // 7*256
@group(0) @binding(3) var<storage, read>        grad       : array<f32>;  // 7*512
@group(0) @binding(4) var<storage, read>        seed_bytes : array<u32>;  // 7 (padded)
@group(0) @binding(5) var<storage, read_write>  out        : array<f32>;

// basis_noise for generator gi, offset added in tile space: X = (x+offx)*scale.
fn basisG(gi : u32, x : f32, y : f32, scale : f32, offx : f32, offy : f32) -> f32 {
    let po = gi * 256u;
    let go = gi * 512u;
    let sb = seed_bytes[gi];
    let X = (x + offx) * scale;
    let Y = (y + offy) * scale;
    let ix = i32(floor(X));
    let iy = i32(floor(Y));
    let fx = X - f32(ix);
    let fy = Y - f32(iy);
    var sum : f32 = 0.0;
    for (var cy : i32 = 0; cy <= 1; cy = cy + 1) {
        for (var cx : i32 = 0; cx <= 1; cx = cx + 1) {
            let p1 = perm1[po + ((bitcast<u32>(iy + cy)) & 255u)];
            let p2 = perm2[po + ((bitcast<u32>(ix + cx)) & 255u)];
            let idx = (p1 ^ sb ^ p2);
            let dx = fx - f32(cx);
            let dy = fy - f32(cy);
            let d2 = dx * dx + dy * dy;
            if (d2 < 1.0) {
                let w = 1.0 - d2;
                sum = sum + (grad[go + 2u * idx] * dx + grad[go + 2u * idx + 1u] * dy) * w * w * w;
            }
        }
    }
    return sum;
}

// multioctave_noise (offset 0), amplitude grows by ampmul each octave.
fn multioctaveG(gi : u32, x : f32, y : f32, octaves : u32, ampmul : f32, is : f32) -> f32 {
    var value : f32 = 0.0;
    var amplitude : f32 = 1.0;
    var coordmul : f32 = 1.0;
    var sumsq : f32 = 0.0;
    var k : f32 = 0.0;
    for (var i : u32 = 0u; i < octaves; i = i + 1u) {
        let x_arg = (k * 17.17) / is + x * coordmul;
        let y_arg = y * coordmul;
        value = value + basisG(gi, x_arg, y_arg, is, 0.0, 0.0) * amplitude;
        sumsq = sumsq + amplitude * amplitude;
        coordmul = coordmul * 0.5;
        amplitude = amplitude * ampmul;
        k = k + 1.0;
    }
    return value / sqrt(sumsq);
}

// variable_persistence_multioctave_noise (Horner accumulation, tile-space offset).
fn variablePersistenceG(gi : u32, x : f32, y : f32, octaves : u32, is : f32, os : f32, offx : f32, offy : f32, persistence : f32) -> f32 {
    var is_k = is * 0.5;
    var acc : f32 = 0.0;
    for (var k : u32 = 0u; k < octaves; k = k + 1u) {
        acc = acc * persistence + basisG(gi, x, y, is_k, offx, offy);
        is_k = is_k * 0.5;
    }
    return acc * os * pow(2.0, f32(octaves));
}

fn elevationAt(x : f32, y : f32) -> f32 {
    let nauvis_hills = abs(multioctaveG(0u, x, y, 4u, 2.0, P.is_hills));
    let cliff_level = clamp(0.65 + basisG(1u, x, y, P.is_cliff, 0.0, 0.0) * P.os_cliff, 0.15, 1.15);
    let plateaus = 0.5 + clamp((nauvis_hills - cliff_level) * 10.0, -0.5, 0.5);
    let hills_plateaus = 0.1 * nauvis_hills + 0.8 * plateaus;

    let bb = abs(multioctaveG(2u, x, y, 4u, 2.0, P.is_bridge));
    let bridges = 1.0 - 0.1 * bb - 0.9 * max(0.0, -0.1 + bb);

    let nauvis_macro = multioctaveG(3u, x, y, 2u, 1.0 / 0.6, P.is_macro1) * max(0.0, multioctaveG(4u, x, y, 1u, 1.0 / 0.6, P.is_macro2));

    let persist = clamp(variablePersistenceG(5u, x, y, 5u, P.is_pers, P.os_pers, P.offx_pers, 0.0, 0.7) + 0.55, 0.5, 0.65);
    let detail = variablePersistenceG(6u, x, y, 5u, P.is_detail, P.os_detail, P.offx_detail, 0.0, persist);

    let dist = sqrt(x * x + y * y);
    let smm = clamp(dist * P.nsm / 2000.0, 0.0, 1.0);
    let cliff = hills_plateaus;
    let nauvis_main = 20.0 * (mix(0.5 * cliff - 0.6, 1.9 * cliff + 1.6, 0.1 + 0.5 * bridges) + 0.25 * detail + 3.0 * nauvis_macro * smm);
    let starting_island = nauvis_main + 20.0 * (2.5 - dist * P.seg / 200.0);
    let wlc = max(nauvis_main - P.water_level * 2.0, starting_island);
    // slake_n == 0 (moons): starting_lake = +inf, min() is a no-op.
    return wlc;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    if (gid.x >= P.width || gid.y >= P.height) { return; }
    let x = P.origin_x + f32(gid.x);
    let y = P.origin_y + f32(gid.y);
    out[gid.y * P.width + gid.x] = elevationAt(x, y);
}
