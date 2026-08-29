"use strict";
/* ===========================================================================
   ΝΥΞ — The Breathing Dark
   A real-time incompressible Navier–Stokes solver (Stam stable fluids), lit as
   moonlit night-smoke. The simulation is colorless physics; every drop of
   beauty is the compositing pass. Single file, zero dependencies, WebGL2.

   Architecture (per frame, order is load-bearing):
     advect velocity → curl → vorticity confinement → splat(mouse) →
     divergence → pressure warm-start decay → Jacobi×N → gradient subtract →
     advect dye → composite (moon + moonlit smoke + curl-pooled violet glow)

   Observability: window.__nyx exposes live framebuffer status, shader logs,
   fps, and sampleScreen() so failures are LOUD, never a silent black canvas.
   =========================================================================== */

const NYX = (() => {

/* ----------------------------- fatal handler ----------------------------- */
const telemetry = {
  api: null, exts: {}, formats: {}, fbo: {}, shaders: {}, error: null,
  fps: 0, frames: 0, tier: 0, simRes: null, dyeRes: null, splats: 0,
};
window.__nyx = telemetry;

function fatal(stage, err) {
  telemetry.error = `[${stage}] ${err && err.message ? err.message : err}`;
  const panel = document.getElementById("fatal");
  const body = document.getElementById("fatal-body");
  body.textContent =
    `stage : ${stage}\n` +
    `error : ${err && err.stack ? err.stack : err}\n\n` +
    `api   : ${telemetry.api}\n` +
    `exts  : ${JSON.stringify(telemetry.exts)}\n` +
    `format: ${JSON.stringify(telemetry.formats)}\n` +
    `fbo   : ${JSON.stringify(telemetry.fbo)}\n` +
    `shader: ${JSON.stringify(telemetry.shaders)}`;
  panel.style.display = "block";
  console.error("[nyx] FATAL", stage, err);
  throw err;
}

/* ------------------------------ gl context ------------------------------- */
const canvas = document.getElementById("c");
const params = { alpha: false, depth: false, stencil: false, antialias: false,
                 preserveDrawingBuffer: false, powerPreference: "high-performance" };
const gl = canvas.getContext("webgl2", params);
if (!gl) fatal("context", new Error("WebGL2 unavailable in this browser."));
telemetry.api = "webgl2";

const extCBF = gl.getExtension("EXT_color_buffer_float");
const extLin = gl.getExtension("OES_texture_float_linear");
telemetry.exts = { color_buffer_float: !!extCBF, texture_float_linear: !!extLin };
if (!extCBF) fatal("extension", new Error("EXT_color_buffer_float required (no float render targets)."));
// half-float textures are core-filterable in WebGL2, so LINEAR is fine for 16F.

/* ------------------------- format support probe -------------------------- */
function supportsRT(internalFormat, format, type) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
  return ok;
}
function getFormat(internalFormat, format, type) {
  if (!supportsRT(internalFormat, format, type)) {
    if (internalFormat === gl.R16F)  return getFormat(gl.RG16F, gl.RG, type);
    if (internalFormat === gl.RG16F) return getFormat(gl.RGBA16F, gl.RGBA, type);
    return null;
  }
  return { internalFormat, format };
}
const HF = gl.HALF_FLOAT;
const fmtRGBA = getFormat(gl.RGBA16F, gl.RGBA, HF);
const fmtRG   = getFormat(gl.RG16F,   gl.RG,   HF);
const fmtR    = getFormat(gl.R16F,    gl.RED,  HF);
if (!fmtRGBA || !fmtRG || !fmtR) fatal("format", new Error("No renderable half-float format."));
telemetry.formats = {
  rgba: fmtRGBA.internalFormat === gl.RGBA16F ? "RGBA16F" : "fallback",
  rg:   fmtRG.internalFormat === gl.RG16F ? "RG16F" : "RGBA16F(fallback)",
  r:    fmtR.internalFormat === gl.R16F ? "R16F" : (fmtR.internalFormat === gl.RG16F ? "RG16F(fallback)" : "RGBA16F(fallback)"),
};

/* ----------------------------- shader plumbing --------------------------- */
function compile(type, src, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
  telemetry.shaders[name] = ok ? "ok" : "FAIL";
  if (!ok) {
    const log = gl.getShaderInfoLog(sh);
    fatal("compile:" + name, new Error(log + "\n--- source ---\n" + numberSrc(src)));
  }
  return sh;
}
function numberSrc(src) {
  return src.split("\n").map((l, i) => String(i + 1).padStart(3, " ") + " | " + l).join("\n");
}
function program(vsSrc, fsSrc, name) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc, name + ".vs"));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc, name + ".fs"));
  gl.bindAttribLocation(p, 0, "aPosition");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    fatal("link:" + name, new Error(gl.getProgramInfoLog(p)));
  }
  // cache uniform locations
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { program: p, uniforms, name,
    bind() { gl.useProgram(p); return this; } };
}

/* ------------------------------ geometry --------------------------------- */
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, -1,1, 1,1, 1,-1]), gl.STATIC_DRAW);
const idx = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2, 0,2,3]), gl.STATIC_DRAW);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.enableVertexAttribArray(0);

function blit(target) {
  if (target == null) {
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  } else {
    gl.viewport(0, 0, target.width, target.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  }
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
}

/* ------------------------------ FBO helpers ------------------------------ */
function createFBO(w, h, fmt, filter) {
  gl.activeTexture(gl.TEXTURE0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, w, h, 0, fmt.format, HF, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return {
    tex, fbo, width: w, height: h, texelX: 1 / w, texelY: 1 / h, status,
    attach(unit) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); return unit; },
  };
}
function createDoubleFBO(w, h, fmt, filter) {
  let fbo1 = createFBO(w, h, fmt, filter);
  let fbo2 = createFBO(w, h, fmt, filter);
  return {
    width: w, height: h, texelX: 1 / w, texelY: 1 / h,
    get read() { return fbo1; }, set read(v) { fbo1 = v; },
    get write() { return fbo2; }, set write(v) { fbo2 = v; },
    swap() { const t = fbo1; fbo1 = fbo2; fbo2 = t; },
  };
}
function checkFBO(name, fbo) {
  const ok = fbo.status === gl.FRAMEBUFFER_COMPLETE;
  telemetry.fbo[name] = ok ? "complete" : ("0x" + fbo.status.toString(16));
  if (!ok) fatal("fbo:" + name, new Error("framebuffer incomplete: 0x" + fbo.status.toString(16)));
}

/* ------------------------------ resolution ------------------------------- */
function getResolution(target) {
  const dpr = gl.drawingBufferWidth / gl.drawingBufferHeight;
  let aspect = dpr >= 1 ? dpr : 1 / dpr;
  const min = Math.round(target);
  const max = Math.round(target * aspect);
  return gl.drawingBufferWidth > gl.drawingBufferHeight
    ? { width: max, height: min } : { width: min, height: max };
}

/* ------------------------------- shaders --------------------------------- */
const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPosition;
out vec2 vUv; out vec2 vL; out vec2 vR; out vec2 vT; out vec2 vB;
uniform vec2 texelSize;
void main(){
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const ADVECT = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;     // velocity texel
uniform vec2 dyeTexelSize;  // source texel
uniform float dt;
uniform float dissipation;
vec4 bilerp(sampler2D s, vec2 uv, vec2 ts){
  vec2 st = uv / ts - 0.5;
  vec2 iuv = floor(st); vec2 fuv = fract(st);
  vec4 a = texture(s, (iuv + vec2(0.5, 0.5)) * ts);
  vec4 b = texture(s, (iuv + vec2(1.5, 0.5)) * ts);
  vec4 c = texture(s, (iuv + vec2(0.5, 1.5)) * ts);
  vec4 d = texture(s, (iuv + vec2(1.5, 1.5)) * ts);
  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}
void main(){
  vec2 vel = bilerp(uVelocity, vUv, texelSize).xy;
  vec2 coord = vUv - dt * vel * texelSize;
  vec4 result = bilerp(uSource, coord, dyeTexelSize);
  float decay = 1.0 + dissipation * dt;
  outColor = result / decay;
}`;

const DIVERGENCE = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB; out vec4 outColor;
uniform sampler2D uVelocity;
void main(){
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  outColor = vec4(div, 0.0, 0.0, 1.0);
}`;

const CURL = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB; out vec4 outColor;
uniform sampler2D uVelocity;
void main(){
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  outColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}`;

const VORTICITY = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB; out vec4 outColor;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main(){
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy;
  vel += force * dt;
  vel = clamp(vel, -1000.0, 1000.0);
  // NaN/Inf guard (grafted from the attractor design's hygiene)
  if (!(dot(vel, vel) < 1.0e8)) vel = vec2(0.0);
  outColor = vec4(vel, 0.0, 1.0);
}`;

const PRESSURE = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB; out vec4 outColor;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main(){
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  outColor = vec4(pressure, 0.0, 0.0, 1.0);
}`;

const GRADIENT = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB; out vec4 outColor;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main(){
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 vel = texture(uVelocity, vUv).xy;
  vel -= vec2(R - L, T - B);
  outColor = vec4(vel, 0.0, 1.0);
}`;

const CLEAR = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uTexture;
uniform float value;
void main(){ outColor = value * texture(uTexture, vUv); }`;

const SPLAT = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main(){
  vec2 p = vUv - point.xy;
  p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color;
  vec3 base = texture(uTarget, vUv).xyz;
  outColor = vec4(base + splat, 1.0);
}`;

/* The soul: colorless physics → moonlit night. */
const DISPLAY = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uDye;
uniform sampler2D uCurl;
uniform vec2  uDyeTexel;
uniform vec2  uResolution;
uniform float uTime;
uniform float uMoonR;
uniform vec2  uMoonPos;     // aspect-corrected space (x scaled by aspect), y centered
uniform vec3  uMoonLightDir;

const vec3 VIOLET  = vec3(0.58, 0.16, 0.99);
const vec3 HOTMAG  = vec3(0.86, 0.30, 1.00);
const vec3 SILVER  = vec3(0.82, 0.87, 1.00);
const vec3 STEEL   = vec3(0.66, 0.72, 0.92);
const vec3 VOID_HI = vec3(0.028, 0.030, 0.066);
const vec3 VOID_LO = vec3(0.004, 0.004, 0.013);

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash21(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1,0)), c = hash21(i + vec2(0,1)), d = hash21(i + vec2(1,1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

void main(){
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  vec2 q = uv - 0.5; q.x *= aspect;

  // ---------------- background void ----------------
  vec3 col = mix(VOID_LO, VOID_HI, smoothstep(0.95, 0.0, length(q)));
  // a scatter of faint static stars
  vec2 sg = floor(uv * uResolution / 2.4);
  float star = step(0.9975, hash21(sg)) * (1.0 - smoothstep(uMoonR * 0.7, uMoonR * 1.6, length(q - uMoonPos)));
  col += STEEL * star * 0.5;

  // ---------------- the moon (screen-space sphere) ----------------
  vec2 m = q - uMoonPos;
  float r = length(m);
  float rr = clamp(r / uMoonR, 0.0, 1.0);
  float zc = sqrt(max(1.0 - rr * rr, 0.0));
  vec3 N = normalize(vec3(m / uMoonR, zc));
  // crater relief via fbm bump on the sphere normal (two bands: broad + fine)
  vec2 cuv = N.xy * 3.4 + 11.0;
  float e = 0.010;
  float h0 = fbm(cuv) * 0.7 + fbm(cuv * 3.1 - 4.0) * 0.3;
  float hx = fbm(cuv + vec2(e, 0.0)) * 0.7 + fbm((cuv + vec2(e, 0.0)) * 3.1 - 4.0) * 0.3;
  float hy = fbm(cuv + vec2(0.0, e)) * 0.7 + fbm((cuv + vec2(0.0, e)) * 3.1 - 4.0) * 0.3;
  vec3 bN = normalize(N + vec3((h0 - hx), (h0 - hy), 0.0) * 2.4);
  vec3 L = normalize(uMoonLightDir);
  float lambert = clamp(dot(bN, L), 0.0, 1.0);
  float phase = smoothstep(-0.06, 0.40, dot(N, L));
  float lit = lambert * phase;
  // albedo: dark maria (seas) vs bright highlands, plus a fine crater speckle
  float seas = fbm(N.xy * 1.3 + 9.0);
  float fine = fbm(N.xy * 5.5 + 2.0);
  float maria = mix(0.32, 0.96, smoothstep(0.42, 0.74, seas));
  maria *= 0.80 + 0.20 * fine;
  vec3 moonCol = SILVER * maria * (0.11 + 0.60 * lit);
  moonCol += STEEL * 0.040 * (1.0 - phase);           // earthshine on the dark side
  moonCol *= mix(0.42, 1.0, zc);                       // limb darkening
  float fres = pow(1.0 - zc, 2.8);
  moonCol += SILVER * fres * 0.40;                     // fresnel moonglow rim
  float disc = smoothstep(uMoonR, uMoonR - 2.5 / uResolution.y, r);
  col = mix(col, moonCol, disc);
  float halo = exp(-max(r - uMoonR, 0.0) * 8.5) * step(uMoonR, r);
  col += STEEL * halo * 0.10;

  // ---------------- the night-smoke (lit by the moon) ----------------
  vec3 dye = texture(uDye, uv).rgb;
  float dens = luma(dye);
  float dxl = luma(texture(uDye, uv + vec2(uDyeTexel.x, 0.0)).rgb) - luma(texture(uDye, uv - vec2(uDyeTexel.x, 0.0)).rgb);
  float dyl = luma(texture(uDye, uv + vec2(0.0, uDyeTexel.y)).rgb) - luma(texture(uDye, uv - vec2(0.0, uDyeTexel.y)).rgb);
  vec3 sn = normalize(vec3(-dxl, -dyl, 0.22));
  vec3 Ls = normalize(vec3(uMoonPos - q, 0.42));        // light from the moon's position
  float smokeLit = clamp(dot(sn, Ls) * 0.5 + 0.5, 0.0, 1.0);
  // the smoke BODY is silver — it takes its light from the moon, not its own colour
  vec3 smokeCol = mix(VOID_LO, SILVER, smokeLit) * dens * 1.25;

  // violet charge — scarce, pooled where vorticity (|curl|) is high so it catches
  // the curl bends like light on the edge of silk. This is the only saturated hue.
  float vort = abs(texture(uCurl, uv).x);
  float chroma = clamp(max(dye.b - dye.g, 0.0), 0.0, 1.0);
  float pool = smoothstep(0.08, 1.1, vort);                 // gate violet to the eddies
  vec3 glow = mix(VIOLET, HOTMAG, pool) * chroma * (0.12 + 1.5 * pool) * (0.5 + 0.8 * smokeLit);

  // mild occlusion of the moon by dense smoke, then forward-scatter backlight
  col *= 1.0 - 0.45 * disc * smoothstep(0.0, 0.6, dens);
  vec3 backlit = SILVER * disc * dens * 0.85;

  col += smokeCol + glow + backlit;

  // ---------------- post ----------------
  col = aces(col * 1.12);
  col *= 1.0 - 0.5 * smoothstep(0.45, 1.18, length(uv - 0.5));   // vignette
  float dith = hash21(gl_FragCoord.xy + fract(uTime) * vec2(13.1, 7.7));
  col += (dith - 0.5) / 255.0;                                   // kill 16F banding
  col = pow(max(col, 0.0), vec3(0.4545));
  outColor = vec4(col, 1.0);
}`;

/* ------------------------------ build programs --------------------------- */
let progAdvect, progDiv, progCurl, progVort, progPress, progGrad, progClear, progSplat, progDisplay;
try {
  progAdvect  = program(VERT, ADVECT, "advect");
  progDiv     = program(VERT, DIVERGENCE, "divergence");
  progCurl    = program(VERT, CURL, "curl");
  progVort    = program(VERT, VORTICITY, "vorticity");
  progPress   = program(VERT, PRESSURE, "pressure");
  progGrad    = program(VERT, GRADIENT, "gradient");
  progClear   = program(VERT, CLEAR, "clear");
  progSplat   = program(VERT, SPLAT, "splat");
  progDisplay = program(VERT, DISPLAY, "display");
} catch (e) { /* fatal already thrown */ }

/* ------------------------------- config ---------------------------------- */
const TIERS = [
  { sim: 256, dye: 1024, iter: 30 },   // tier 0 — full (4090 lives here)
  { sim: 192, dye: 640,  iter: 24 },   // tier 1
  { sim: 128, dye: 384,  iter: 20 },   // tier 2 — weak GPU
];
const config = {
  DENSITY_DISSIPATION: 1.2,    // the night reclaims the violet (lower = longer silk)
  VELOCITY_DISSIPATION: 0.2,
  PRESSURE: 0.8,
  CURL: 30,                    // a touch more vorticity → sharper eddies
  SPLAT_RADIUS: 0.27,          // /100 in shader
  SPLAT_FORCE: 6200,
};

let velocity, dye, divergence, curl, pressure;
function initSim(tier) {
  const t = TIERS[tier];
  const simRes = getResolution(t.sim);
  const dyeRes = getResolution(t.dye);
  telemetry.tier = tier;
  telemetry.simRes = `${simRes.width}x${simRes.height}`;
  telemetry.dyeRes = `${dyeRes.width}x${dyeRes.height}`;
  const filt = gl.LINEAR;
  velocity   = createDoubleFBO(simRes.width, simRes.height, fmtRG, filt);
  dye        = createDoubleFBO(dyeRes.width, dyeRes.height, fmtRGBA, filt);
  divergence = createFBO(simRes.width, simRes.height, fmtR, gl.NEAREST);
  curl       = createFBO(simRes.width, simRes.height, fmtR, filt);
  pressure   = createDoubleFBO(simRes.width, simRes.height, fmtR, gl.NEAREST);
  checkFBO("velocity", velocity.read); checkFBO("dye", dye.read);
  checkFBO("divergence", divergence); checkFBO("curl", curl);
  checkFBO("pressure", pressure.read);
}
config.iterations = () => TIERS[telemetry.tier].iter;

/* ------------------------------ simulation ------------------------------- */
function step(dt) {
  gl.disable(gl.BLEND);

  // advect velocity
  progAdvect.bind();
  gl.uniform2f(progAdvect.uniforms.texelSize, velocity.texelX, velocity.texelY);
  gl.uniform2f(progAdvect.uniforms.dyeTexelSize, velocity.texelX, velocity.texelY);
  gl.uniform1i(progAdvect.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(progAdvect.uniforms.uSource, velocity.read.attach(0));
  gl.uniform1f(progAdvect.uniforms.dt, dt);
  gl.uniform1f(progAdvect.uniforms.dissipation, config.VELOCITY_DISSIPATION);
  blit(velocity.write); velocity.swap();

  // curl
  progCurl.bind();
  gl.uniform2f(progCurl.uniforms.texelSize, velocity.texelX, velocity.texelY);
  gl.uniform1i(progCurl.uniforms.uVelocity, velocity.read.attach(0));
  blit(curl);

  // vorticity confinement
  progVort.bind();
  gl.uniform2f(progVort.uniforms.texelSize, velocity.texelX, velocity.texelY);
  gl.uniform1i(progVort.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(progVort.uniforms.uCurl, curl.attach(1));
  gl.uniform1f(progVort.uniforms.curl, config.CURL);
  gl.uniform1f(progVort.uniforms.dt, dt);
  blit(velocity.write); velocity.swap();

  // divergence
  progDiv.bind();
  gl.uniform2f(progDiv.uniforms.texelSize, velocity.texelX, velocity.texelY);
  gl.uniform1i(progDiv.uniforms.uVelocity, velocity.read.attach(0));
  blit(divergence);

  // pressure warm-start decay
  progClear.bind();
  gl.uniform1i(progClear.uniforms.uTexture, pressure.read.attach(0));
  gl.uniform1f(progClear.uniforms.value, config.PRESSURE);
  blit(pressure.write); pressure.swap();

  // Jacobi pressure solve
  progPress.bind();
  gl.uniform2f(progPress.uniforms.texelSize, velocity.texelX, velocity.texelY);
  gl.uniform1i(progPress.uniforms.uDivergence, divergence.attach(0));
  const iters = config.iterations();
  for (let i = 0; i < iters; i++) {
    gl.uniform1i(progPress.uniforms.uPressure, pressure.read.attach(1));
    blit(pressure.write); pressure.swap();
  }

  // gradient subtract
  progGrad.bind();
  gl.uniform2f(progGrad.uniforms.texelSize, velocity.texelX, velocity.texelY);
  gl.uniform1i(progGrad.uniforms.uPressure, pressure.read.attach(0));
  gl.uniform1i(progGrad.uniforms.uVelocity, velocity.read.attach(1));
  blit(velocity.write); velocity.swap();

  // advect dye
  progAdvect.bind();
  gl.uniform2f(progAdvect.uniforms.texelSize, velocity.texelX, velocity.texelY);
  gl.uniform2f(progAdvect.uniforms.dyeTexelSize, dye.texelX, dye.texelY);
  gl.uniform1i(progAdvect.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(progAdvect.uniforms.uSource, dye.read.attach(1));
  gl.uniform1f(progAdvect.uniforms.dt, dt);
  gl.uniform1f(progAdvect.uniforms.dissipation, config.DENSITY_DISSIPATION);
  blit(dye.write); dye.swap();
}

function splat(x, y, dx, dy, color) {
  const aspect = canvas.width / canvas.height;
  let radius = config.SPLAT_RADIUS / 100.0;
  if (aspect > 1) radius *= aspect;

  progSplat.bind();
  gl.uniform1f(progSplat.uniforms.aspectRatio, aspect);
  gl.uniform2f(progSplat.uniforms.point, x, y);
  gl.uniform1f(progSplat.uniforms.radius, radius);
  // velocity
  gl.uniform1i(progSplat.uniforms.uTarget, velocity.read.attach(0));
  gl.uniform3f(progSplat.uniforms.color, dx, dy, 0.0);
  blit(velocity.write); velocity.swap();
  // dye
  gl.uniform1i(progSplat.uniforms.uTarget, dye.read.attach(0));
  gl.uniform3f(progSplat.uniforms.color, color[0], color[1], color[2]);
  blit(dye.write); dye.swap();
  telemetry.splats++;
}

/* ------------------------------ interaction ------------------------------ */
const pointer = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, down: false, moved: false };
let lastInteract = 0;
let clock = 0;

function violetForSpeed(speed) {
  // slow → deep indigo-violet ; fast → a warmer violet. NEVER hot pink — the dye is
  // dim and cool; the moonlight makes the body silver, the curl-glow adds the charge.
  const t = Math.min(speed * 5.5, 1.0);
  const r = 0.26 + 0.26 * t;
  const g = 0.09 + 0.05 * t;
  const b = 0.82;
  const k = 0.34 + 0.30 * t;   // modest intensity — let lighting do the work
  return [r * k, g * k, b * k];
}
function pointerToSim(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { x: (clientX - rect.left) / rect.width, y: 1.0 - (clientY - rect.top) / rect.height };
}
function dismissTitle() {
  const t = document.getElementById("title");
  if (t && !t.classList.contains("gone")) t.classList.add("gone");
}
function onMove(clientX, clientY) {
  const p = pointerToSim(clientX, clientY);
  pointer.px = pointer.x; pointer.py = pointer.y;
  pointer.x = p.x; pointer.y = p.y; pointer.moved = true;
  lastInteract = clock;
}
canvas.addEventListener("pointerdown", (ev) => {
  const p = pointerToSim(ev.clientX, ev.clientY);
  pointer.x = pointer.px = p.x; pointer.y = pointer.py = p.y;   // no first-frame velocity nuke
  pointer.down = true; lastInteract = clock; dismissTitle();
  // a single radial puff on click
  splat(p.x, p.y, 0, 0, violetForSpeed(0.2));
});
window.addEventListener("pointerup", () => { pointer.down = false; });
canvas.addEventListener("pointermove", (ev) => { onMove(ev.clientX, ev.clientY); dismissTitle(); });

function applyPointer(dt) {
  const norm = Math.min(dt * 60.0, 2.0);   // framerate-independent dye injection
  if (pointer.moved) {
    const dx = (pointer.x - pointer.px) * config.SPLAT_FORCE;
    const dy = (pointer.y - pointer.py) * config.SPLAT_FORCE;
    const speed = Math.hypot(pointer.x - pointer.px, pointer.y - pointer.py);
    if (Math.abs(dx) + Math.abs(dy) > 0.1) {
      const c = violetForSpeed(speed);
      splat(pointer.x, pointer.y, dx, dy, [c[0] * norm, c[1] * norm, c[2] * norm]);
    }
    pointer.moved = false;
  } else if (pointer.down) {
    // held but still → a quiet wellspring of night
    const c = violetForSpeed(0.12);
    splat(pointer.x, pointer.y, 0, 0, [c[0] * norm, c[1] * norm, c[2] * norm]);
  }
}

/* idle autopilot — a Lissajous breath so a wall display is never static.
   Two decorrelated emitters (never synchronized), injection normalized to a
   60fps-equivalent so the field looks identical at 30, 60 or 240 fps. */
function autopilot(dt) {
  const norm = Math.min(dt * 60.0, 2.0);
  const t = clock;
  const f = config.SPLAT_FORCE * 0.8 * norm;
  // lung 1
  const ax = 0.5 + 0.32 * Math.sin(t * 0.27) * Math.cos(t * 0.11);
  const ay = 0.44 + 0.28 * Math.sin(t * 0.19 + 1.3);
  const apx = 0.5 + 0.32 * Math.sin((t - 0.05) * 0.27) * Math.cos((t - 0.05) * 0.11);
  const apy = 0.44 + 0.28 * Math.sin((t - 0.05) * 0.19 + 1.3);
  let c = violetForSpeed(Math.hypot(ax - apx, ay - apy) * 0.5);
  splat(ax, ay, (ax - apx) * f, (ay - apy) * f, [c[0] * norm, c[1] * norm, c[2] * norm]);
  // lung 2 — slower, decorrelated, weaker
  const bx = 0.5 + 0.27 * Math.cos(t * 0.16 + 2.1);
  const by = 0.5 + 0.29 * Math.sin(t * 0.23 + 0.6) * Math.cos(t * 0.13);
  const bpx = 0.5 + 0.27 * Math.cos((t - 0.05) * 0.16 + 2.1);
  const bpy = 0.5 + 0.29 * Math.sin((t - 0.05) * 0.23 + 0.6) * Math.cos((t - 0.05) * 0.13);
  c = violetForSpeed(Math.hypot(bx - bpx, by - bpy) * 0.4);
  splat(bx, by, (bx - bpx) * f * 0.7, (by - bpy) * f * 0.7, [c[0] * norm * 0.7, c[1] * norm * 0.7, c[2] * norm * 0.7]);
}

/* ------------------------------- render ---------------------------------- */
function render() {
  const aspect = canvas.width / canvas.height;
  progDisplay.bind();
  gl.uniform1i(progDisplay.uniforms.uDye, dye.read.attach(0));
  gl.uniform1i(progDisplay.uniforms.uCurl, curl.attach(1));
  gl.uniform2f(progDisplay.uniforms.uDyeTexel, dye.texelX, dye.texelY);
  gl.uniform2f(progDisplay.uniforms.uResolution, canvas.width, canvas.height);
  gl.uniform1f(progDisplay.uniforms.uTime, clock);
  gl.uniform1f(progDisplay.uniforms.uMoonR, 0.225);
  gl.uniform2f(progDisplay.uniforms.uMoonPos, 0.0, 0.12);
  // a gibbous-to-full moon, side-lit so craters cast raking shadow; slow breath
  const lx = 0.40 * Math.sin(clock * 0.06);
  const ly = 0.30 + 0.07 * Math.sin(clock * 0.043);
  gl.uniform3f(progDisplay.uniforms.uMoonLightDir, lx, ly, 0.80);
  blit(null);
}

/* ------------------------------- resize ---------------------------------- */
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    return true;
  }
  return false;
}

/* ------------------------------ HUD / keys ------------------------------- */
const hud = document.getElementById("hud");
let hudOn = /(\bdebug\b|#debug)/.test(location.hash);
if (hudOn) hud.style.display = "block";
// #demo — force the idle autopilot on continuously and clear the title card
// (deterministic active field for headless verification capture).
// On the site the canvas is ambient, not a toy: always breathe, never wait for a pointer.
const FORCE_AUTOPILOT = true;
window.addEventListener("keydown", (e) => {
  if (e.key === "h" || e.key === "H") { hudOn = !hudOn; hud.style.display = hudOn ? "block" : "none"; }
  if (e.key === "r" || e.key === "R") { initSim(telemetry.tier); }   // reseed/clear the void
});
function updateHUD() {
  if (!hudOn) return;
  const f = telemetry;
  hud.innerHTML =
    `<b>ΝΥΞ</b> · the breathing dark<br>` +
    `fps&nbsp;&nbsp;<b>${f.fps.toFixed(0)}</b> &nbsp; tier <b>${f.tier}</b><br>` +
    `sim&nbsp;&nbsp;${f.simRes} &nbsp; dye ${f.dyeRes}<br>` +
    `iter&nbsp;${config.iterations()} &nbsp; splats ${f.splats}<br>` +
    `fmt&nbsp;&nbsp;rg:<span class="${f.formats.rg.includes('fallback')?'warn':'ok'}">${f.formats.rg}</span> ` +
    `r:<span class="${f.formats.r.includes('fallback')?'warn':'ok'}">${f.formats.r}</span><br>` +
    `lum&nbsp;&nbsp;${(f._lum||0).toFixed(4)}`;
}

/* read a small region of the rendered canvas → average luminance.
   This is the "is it actually non-black" probe my verify loop reads. */
const samplePixels = new Uint8Array(4 * 32 * 32);
telemetry.sampleScreen = function () {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const x = Math.floor(gl.drawingBufferWidth / 2 - 16);
  const y = Math.floor(gl.drawingBufferHeight / 2 - 16);
  gl.readPixels(x, y, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, samplePixels);
  let sum = 0, max = 0;
  for (let i = 0; i < samplePixels.length; i += 4) {
    const l = 0.299 * samplePixels[i] + 0.587 * samplePixels[i + 1] + 0.114 * samplePixels[i + 2];
    sum += l; if (l > max) max = l;
  }
  const avg = sum / (32 * 32) / 255;
  telemetry._lum = avg;
  const s = { avg, max: max / 255, glError: gl.getError() };
  telemetry.lastSample = s;     // captured in-loop (valid back-buffer timing)
  return s;
};

/* ------------------------------- main loop ------------------------------- */
let lastTime = 0, fpsEMA = 60, frameMsEMA = 16, tierLocked = false;
function frame(now) {
  if (!lastTime) lastTime = now;
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  dt = Math.min(dt, 1 / 30);        // clamp — tab refocus must not explode the integrator
  clock += dt;
  telemetry.frames++;

  if (resize()) { /* canvas size changed; sim res is independent, no realloc needed */ }

  // adaptive quality: step down a tier if we're consistently slow (first ~4s)
  frameMsEMA = frameMsEMA * 0.92 + (dt * 1000) * 0.08;
  fpsEMA = fpsEMA * 0.92 + (1 / Math.max(dt, 1e-3)) * 0.08;
  telemetry.fps = fpsEMA;
  if (!tierLocked && telemetry.frames > 90) {
    if (frameMsEMA > 22 && telemetry.tier < TIERS.length - 1) {
      initSim(telemetry.tier + 1);
    } else {
      tierLocked = true;
    }
  }

  // input or idle breath
  if (FORCE_AUTOPILOT || clock - lastInteract > 5.0) autopilot(dt);
  applyPointer(dt);

  // step in REAL time (clamped) so the sim runs at the same wall-clock speed on a
  // 60Hz or a 240Hz display — a fixed per-frame dt would make smoke dissipate 4x
  // faster on a high-refresh monitor. Clamp ≤1/60 keeps the explicit forces stable.
  const SIM_DT = Math.min(dt, 1 / 60);
  step(SIM_DT);
  render();

  if (telemetry.frames % 12 === 0) telemetry.sampleScreen();
  updateHUD();
  if (NYX_NIGHT.running) requestAnimationFrame(frame);
}


/* ---- ambient-mode gate -------------------------------------------------
   The solver is a background, not the point of the page. It stops entirely
   when the tab is hidden or the hero has scrolled away, and resets its clock
   on resume so the integrator never receives a multi-second dt. --------- */
const NYX_NIGHT = {
  running: true,
  pause() { this.running = false; },
  resume() {
    if (this.running) return;
    this.running = true; lastTime = 0;
    requestAnimationFrame(frame);
  },
};
window.nyxNight = NYX_NIGHT;
document.addEventListener("visibilitychange", () => {
  document.hidden ? NYX_NIGHT.pause() : NYX_NIGHT.resume();
});

/* ------------------------------- bootstrap ------------------------------- */
function boot() {
  try {
    resize();
    initSim(0);
    if (FORCE_AUTOPILOT) dismissTitle();
    // an opening exhale — a soft rotating bloom (tangential swirl, not an explosion)
    // so the piece is alive from frame 1 without blowing smoke to every edge.
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2, r = 0.10;
      splat(0.5 + Math.cos(a) * r, 0.46 + Math.sin(a) * r,
            -Math.sin(a) * 650, Math.cos(a) * 650, violetForSpeed(0.25));
    }
    requestAnimationFrame(frame);
    console.log("[nyx] alive — tier", telemetry.tier, telemetry.simRes, telemetry.dyeRes, telemetry.formats);
  } catch (e) {
    fatal("boot", e);
  }
}
boot();
return telemetry;
})();
