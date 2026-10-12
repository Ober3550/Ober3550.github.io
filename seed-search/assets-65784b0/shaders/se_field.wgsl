// se_field.wgsl — SE asteroid-field kernel (asteroid.zig port).
// Asteroid fields are a 2/3-tile argmax, not the alien-biomes classifier:
//   se-space (11,13,15) background vs se-asteroid (80,80,80) patches, where
//   asteroid wins iff  -1 + min(y/size, -y/size) + |billows| > 0  with
//   billows = multioctave_noise(x/5, y/5, 4, persist 0.7, seed1=1, is 1/6).
//   out_of_map (0,0,0) beyond the field disk: 10000*(dist-planet_radius)
//   > (1/freq - 100)*1000 (= 900000 for freq=1/1000).
// Modes: 0 tile index (0 space, 1 asteroid, 2 out_of_map), 1 packed colour.

struct FParams {
    origin_x : f32,
    origin_y : f32,
    planetR : f32,
    width : u32,
    height : u32,
    mode : u32,
};

@group(0) @binding(0) var<uniform>             P     : FParams;
@group(0) @binding(1) var<storage, read>       perm1 : array<u32>;
@group(0) @binding(2) var<storage, read>       perm2 : array<u32>;
@group(0) @binding(3) var<storage, read>       grad  : array<f32>;
@group(0) @binding(4) var<storage, read>       sbytes: array<u32>;
@group(0) @binding(5) var<storage, read_write> outIdx: array<u32>;

fn basisG(x : f32, y : f32, scale : f32) -> f32 {
    let X = x * scale;
    let Y = y * scale;
    let ix = i32(floor(X));
    let iy = i32(floor(Y));
    let fx = X - f32(ix);
    let fy = Y - f32(iy);
    var sum : f32 = 0.0;
    for (var cy : i32 = 0; cy <= 1; cy = cy + 1) {
        for (var cx : i32 = 0; cx <= 1; cx = cx + 1) {
            let p1 = perm1[(bitcast<u32>(iy + cy) & 255u)];
            let p2 = perm2[(bitcast<u32>(ix + cx) & 255u)];
            let g2 = (p1 ^ sbytes[0u] ^ p2);
            let dx = fx - f32(cx);
            let dy = fy - f32(cy);
            let d2 = dx * dx + dy * dy;
            if (d2 < 1.0) {
                let w = 1.0 - d2;
                sum = sum + (grad[2u * g2] * dx + grad[2u * g2 + 1u] * dy) * w * w * w;
            }
        }
    }
    return sum;
}

// multioctave_noise (noise.zig): one gen, coordmul *= 0.5, amplitude *= 1/pers.
fn billowsAt(x5 : f32, y5 : f32) -> f32 {
    var value : f32 = 0.0;
    var amplitude : f32 = 1.0;
    var coordmul : f32 = 1.0;
    var sumsq : f32 = 0.0;
    var k : f32 = 0.0;
    let ampmul = 1.0 / 0.7;
    let is = 1.0 / 6.0;
    for (var i : u32 = 0u; i < 4u; i = i + 1u) {
        let xa = (k * 17.17) / is + x5 * coordmul;
        let ya = y5 * coordmul;
        value = value + basisG(xa, ya, is) * amplitude;
        sumsq = sumsq + amplitude * amplitude;
        coordmul = coordmul * 0.5;
        amplitude = amplitude * ampmul;
        k = k + 1.0;
    }
    return value / sqrt(sumsq);
}

fn tileAt(x : f32, y : f32) -> u32 {
    let dist = sqrt(x * x + y * y);
    if (10000.0 * (dist - P.planetR) > 900000.0) { return 2u; }
    let billows = abs(billowsAt(x / 5.0, y / 5.0));
    let ridge = min(y / 10000.0, -y / 10000.0);
    if (-1.0 + ridge + billows > 0.0) { return 1u; }
    return 0u;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    if (gid.x >= P.width || gid.y >= P.height) { return; }
    let x = P.origin_x + f32(gid.x);
    let y = P.origin_y + f32(gid.y);
    let i = gid.y * P.width + gid.x;
    let t = tileAt(x, y);
    if (P.mode == 0u) { outIdx[i] = t; return; }
    if (t == 1u) { outIdx[i] = 0x00505050u; return; }  // se-asteroid
    if (t == 2u) { outIdx[i] = 0x00000000u; return; }  // out_of_map
    outIdx[i] = 0x000B0D0Fu;                            // se-space
}
