/**
 * shaderMode.js — Visual Preset Post-Processing
 *
 * Applies full-screen shader effects to the Cesium scene:
 * - Mode 1 (Normal): Pass-through, no effect
 * - Mode 2 (CRT): Barrel distortion, chromatic aberration, scanlines, phosphor green
 * - Mode 3 (NVG): Luminance, green phosphor, animated grain, vignette
 * - Mode 4 (FLIR): Thermal LUT (black→purple→red→yellow→white), WHOT/BHOT polarity
 *
 * Keys 1–4 switch modes. HUD sliders control bloom, sensitivity, pixelation,
 * sharpen. Transitions use 400ms ease-in-out.
 */

import * as Cesium from 'cesium';

// ── Shared mutable state — uniform callbacks read from here ──────────────────
const _s = {
  mode: 1,          // 1=Normal  2=CRT  3=NVG  4=FLIR
  sensitivity: 1.2, // 0.0 – 2.0
  pixelation: 1.0,  // 1 – 16
  sharpen: 0.0,     // 0.0 | 1.0
  whot: 1.0,        // 1.0=white-hot  0.0=black-hot  (FLIR polarity)
  time: 0.0,        // seconds since enable — drives animated grain/noise
  intensity: { crt: 0.0, nvg: 0.0, flir: 0.0 }, // animated blend 0→1
};

// ── GLSL: CRT ─────────────────────────────────────────────────────────────────
const CRT_GLSL = `
uniform sampler2D colorTexture;
uniform float u_pixelation;
uniform float u_sharpen;
uniform float u_intensity;

in vec2 v_textureCoordinates;
out vec4 fragColor;

void main() {
  vec2 res = czm_viewport.zw;
  vec2 uv  = v_textureCoordinates;

  // --- Pixelation ---
  if (u_pixelation > 1.5) {
    vec2 bs = vec2(u_pixelation) / res;
    uv = floor(uv / bs) * bs + bs * 0.5;
  }

  // --- Barrel distortion ---
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + 0.12 * dot(c, c);
  vec2 d = c * 0.5 + 0.5;

  // Out-of-bounds → black border
  if (d.x < 0.0 || d.x > 1.0 || d.y < 0.0 || d.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // --- Chromatic aberration ---
  float ab = 0.003;
  float r  = texture(colorTexture, d + vec2(ab, 0.0)).r;
  float g  = texture(colorTexture, d).g;
  float b  = texture(colorTexture, d - vec2(ab, 0.0)).b;
  vec3 col = vec3(r, g, b);

  // --- Sharpen ---
  if (u_sharpen > 0.5) {
    vec2 px   = 1.0 / res;
    vec3 blur = (
      texture(colorTexture, d + vec2(-px.x, 0.0)).rgb +
      texture(colorTexture, d + vec2( px.x, 0.0)).rgb +
      texture(colorTexture, d + vec2(0.0, -px.y)).rgb +
      texture(colorTexture, d + vec2(0.0,  px.y)).rgb
    ) * 0.25;
    col = clamp(col + (col - blur) * 1.5, 0.0, 1.0);
  }

  // --- Horizontal scanlines (darken every other row) ---
  float scanline = mod(gl_FragCoord.y, 2.0) < 1.0 ? 0.72 : 1.0;
  col *= scanline;

  // --- Phosphor green tint ---
  col *= vec3(0.82, 1.0, 0.78);

  // --- Vignette ---
  vec2 v = d * 2.0 - 1.0;
  col *= clamp(1.0 - dot(v, v) * 0.42, 0.0, 1.0);

  vec4 orig = texture(colorTexture, v_textureCoordinates);
  fragColor = mix(orig, vec4(clamp(col, 0.0, 1.0), 1.0), u_intensity);
}
`;

// ── GLSL: NVG (Night Vision) ──────────────────────────────────────────────────
const NVG_GLSL = `
uniform sampler2D colorTexture;
uniform float u_sensitivity;
uniform float u_pixelation;
uniform float u_sharpen;
uniform float u_time;
uniform float u_intensity;

in vec2 v_textureCoordinates;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 res = czm_viewport.zw;
  vec2 uv  = v_textureCoordinates;

  // --- Pixelation ---
  if (u_pixelation > 1.5) {
    vec2 bs = vec2(u_pixelation) / res;
    uv = floor(uv / bs) * bs + bs * 0.5;
  }

  vec4 scene = texture(colorTexture, uv);

  // --- Luminance + sensitivity ---
  float lum = dot(scene.rgb, vec3(0.299, 0.587, 0.114));
  lum = clamp(lum * u_sensitivity, 0.0, 1.0);

  // --- Sharpen ---
  if (u_sharpen > 0.5) {
    vec2 px      = 1.0 / res;
    vec3 lumCoef = vec3(0.299, 0.587, 0.114);
    float blurL  = (
      dot(texture(colorTexture, uv + vec2(-px.x, 0.0)).rgb, lumCoef) +
      dot(texture(colorTexture, uv + vec2( px.x, 0.0)).rgb, lumCoef) +
      dot(texture(colorTexture, uv + vec2(0.0, -px.y)).rgb, lumCoef) +
      dot(texture(colorTexture, uv + vec2(0.0,  px.y)).rgb, lumCoef)
    ) * 0.25;
    lum = clamp(lum + (lum - blurL) * 1.8, 0.0, 1.0);
  }

  // --- Animated grain ---
  float grain = hash(uv * 311.0 + vec2(u_time * 0.0037, u_time * 0.0041)) * 0.07 - 0.035;
  lum = clamp(lum + grain, 0.0, 1.0);

  // --- Green phosphor ---
  vec3 nvg = vec3(lum * 0.18, lum, lum * 0.12);

  // --- Vignette ---
  vec2 v = uv * 2.0 - 1.0;
  nvg *= clamp(1.0 - dot(v, v) * 0.38, 0.0, 1.0);

  vec4 orig = texture(colorTexture, uv);
  fragColor = mix(orig, vec4(nvg, 1.0), u_intensity);
}
`;

// ── GLSL: FLIR Thermal ────────────────────────────────────────────────────────
const FLIR_GLSL = `
uniform sampler2D colorTexture;
uniform float u_sensitivity;
uniform float u_pixelation;
uniform float u_whot;
uniform float u_time;
uniform float u_intensity;

in vec2 v_textureCoordinates;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// black -> purple -> red -> yellow -> white
vec3 thermalLUT(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.25) return mix(vec3(0.00, 0.00, 0.00), vec3(0.38, 0.00, 0.62), t * 4.0);
  if (t < 0.50) return mix(vec3(0.38, 0.00, 0.62), vec3(0.92, 0.08, 0.00), (t - 0.25) * 4.0);
  if (t < 0.75) return mix(vec3(0.92, 0.08, 0.00), vec3(1.00, 0.90, 0.00), (t - 0.50) * 4.0);
  return               mix(vec3(1.00, 0.90, 0.00), vec3(1.00, 1.00, 1.00), (t - 0.75) * 4.0);
}

void main() {
  vec2 res = czm_viewport.zw;
  vec2 uv  = v_textureCoordinates;

  // --- Thermal sensor resolution (always at least 2 px) ---
  float pix = max(u_pixelation, 2.0);
  vec2 bs   = vec2(pix) / res;
  vec2 pixUV = floor(uv / bs) * bs + bs * 0.5;

  // --- 3×3 blur (thermal sensor softness) ---
  vec4 scene = vec4(0.0);
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      scene += texture(colorTexture, pixUV + vec2(float(x), float(y)) * bs * 0.5);
    }
  }
  scene /= 9.0;

  float lum = dot(scene.rgb, vec3(0.299, 0.587, 0.114));
  lum = clamp(lum * u_sensitivity, 0.0, 1.0);

  // --- WHOT / BHOT polarity ---
  if (u_whot < 0.5) lum = 1.0 - lum;

  // --- Chromatic thermal noise ---
  float noise = (hash(uv * 277.0 + vec2(u_time * 0.0019, u_time * 0.0023)) - 0.5) * 0.05;
  lum = clamp(lum + noise, 0.0, 1.0);

  vec4 orig = texture(colorTexture, uv);
  fragColor = mix(orig, vec4(thermalLUT(lum), 1.0), u_intensity);
}
`;

// ── LayerModule ───────────────────────────────────────────────────────────────
const ShaderModeLayer = {
  id: 'shaderMode',
  label: 'Visual Mode',
  enabled: true,

  // Internal handles
  _stages: { crt: null, nvg: null, flir: null },
  _keyHandler: null,
  _preRenderHandler: null,
  _transitionRaf: null,
  _startMs: 0,

  // Public API — HUD sliders write here via setUniform()
  get mode() { return _s.mode; },
  get sensitivity() { return _s.sensitivity; },
  get pixelation() { return _s.pixelation; },
  get sharpen() { return _s.sharpen > 0.5; },
  get whot() { return _s.whot > 0.5; },

  // ── init ──────────────────────────────────────────────────────────────────
  init(viewer) {
    // Uniform callback factories — evaluated per frame by CesiumJS
    const mkUniforms = (extras = {}) => ({
      u_sensitivity: () => _s.sensitivity,
      u_pixelation:  () => _s.pixelation,
      u_sharpen:     () => _s.sharpen,
      u_time:        () => _s.time,
      ...extras,
    });

    this._stages.crt = new Cesium.PostProcessStage({
      name: 'ea_crt',
      fragmentShader: CRT_GLSL,
      uniforms: {
        u_pixelation: () => _s.pixelation,
        u_sharpen:    () => _s.sharpen,
        u_intensity:  () => _s.intensity.crt,
      },
    });

    this._stages.nvg = new Cesium.PostProcessStage({
      name: 'ea_nvg',
      fragmentShader: NVG_GLSL,
      uniforms: mkUniforms({ u_intensity: () => _s.intensity.nvg }),
    });

    this._stages.flir = new Cesium.PostProcessStage({
      name: 'ea_flir',
      fragmentShader: FLIR_GLSL,
      uniforms: {
        u_sensitivity: () => _s.sensitivity,
        u_pixelation:  () => _s.pixelation,
        u_whot:        () => _s.whot,
        u_time:        () => _s.time,
        u_intensity:   () => _s.intensity.flir,
      },
    });

    // Add all stages to CesiumJS (disabled until a mode is selected)
    viewer.scene.postProcessStages.add(this._stages.crt);
    viewer.scene.postProcessStages.add(this._stages.nvg);
    viewer.scene.postProcessStages.add(this._stages.flir);

    this._stages.crt.enabled  = false;
    this._stages.nvg.enabled  = false;
    this._stages.flir.enabled = false;

    // Per-frame time update for animated grain/noise
    this._startMs = performance.now();
    this._preRenderHandler = () => {
      _s.time = (performance.now() - this._startMs) * 0.001;
    };
    viewer.scene.preRender.addEventListener(this._preRenderHandler);

    // Keys 1–4: mode switching
    this._keyHandler = (e) => {
      if (e.target && e.target.tagName === 'INPUT') return; // don't steal slider focus
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 4) this.setMode(viewer, n);
    };
    document.addEventListener('keydown', this._keyHandler);

    console.log('[ShaderMode] Initialized — keys 1=Normal 2=CRT 3=NVG 4=FLIR');
  },

  // ── enable / disable ──────────────────────────────────────────────────────
  enable(viewer) {
    this.setMode(viewer, _s.mode);
  },

  disable(viewer) {
    this._stages.crt.enabled  = false;
    this._stages.nvg.enabled  = false;
    this._stages.flir.enabled = false;
    viewer.scene.postProcessStages.bloom.enabled = false;
  },

  // ── refresh (data-poll tick — no-op for shaders) ──────────────────────────
  refresh() {},

  // ── setMode ───────────────────────────────────────────────────────────────
  setMode(viewer, mode) {
    _s.mode = mode;

    // Cancel any in-progress transition
    if (this._transitionRaf) {
      cancelAnimationFrame(this._transitionRaf);
      this._transitionRaf = null;
    }

    const DURATION = 400; // ms
    const keys = ['crt', 'nvg', 'flir'];
    const modeToKey = { 2: 'crt', 3: 'nvg', 4: 'flir' };
    const inKey = modeToKey[mode] || null;

    // Configure bloom for the incoming mode
    const bloom = viewer.scene.postProcessStages.bloom;
    if (mode === 2) {
      bloom.enabled = true;
      bloom.uniforms.glowOnly   = false;
      bloom.uniforms.contrast   = 50;
      bloom.uniforms.brightness = -0.2;
      bloom.uniforms.delta      = 1.0;
      bloom.uniforms.sigma      = 2.0;
      bloom.uniforms.stepSize   = 1.0;
    } else if (mode === 3) {
      bloom.enabled = true;
      bloom.uniforms.glowOnly   = false;
      bloom.uniforms.contrast   = 80;
      bloom.uniforms.brightness = -0.1;
      bloom.uniforms.delta      = 0.9;
      bloom.uniforms.sigma      = 3.0;
      bloom.uniforms.stepSize   = 1.0;
    }

    // Enable incoming stage at its current intensity (starts at 0 if was off)
    if (inKey) this._stages[inKey].enabled = true;

    // Snapshot starting intensities for interpolation
    const startIntensity = { crt: _s.intensity.crt, nvg: _s.intensity.nvg, flir: _s.intensity.flir };
    const startTime = performance.now();

    const tick = () => {
      const t = Math.min((performance.now() - startTime) / DURATION, 1.0);
      // Ease in-out
      const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      keys.forEach(k => {
        const target = k === inKey ? 1.0 : 0.0;
        _s.intensity[k] = startIntensity[k] + (target - startIntensity[k]) * e;
        if (_s.intensity[k] < 0.001 && target === 0.0) {
          _s.intensity[k] = 0.0;
          this._stages[k].enabled = false;
        }
      });

      if (t < 1.0) {
        this._transitionRaf = requestAnimationFrame(tick);
      } else {
        this._transitionRaf = null;
        keys.forEach(k => {
          _s.intensity[k] = k === inKey ? 1.0 : 0.0;
          if (k !== inKey) this._stages[k].enabled = false;
        });
        // Disable bloom only after fade-out is complete for normal/FLIR
        if (mode === 1 || mode === 4) bloom.enabled = false;
      }
    };

    this._transitionRaf = requestAnimationFrame(tick);

    const labels = ['', 'Normal', 'CRT', 'NVG', 'FLIR'];
    console.log(`[ShaderMode] → ${labels[mode]}`);
    window.dispatchEvent(new CustomEvent('ea:modeChange', { detail: { mode, label: labels[mode] } }));
  },

  // ── setUniform — called by HUD sliders ────────────────────────────────────
  /**
   * @param {'sensitivity'|'pixelation'|'bloom'|'sharpen'|'whot'} key
   * @param {number|boolean} value
   */
  setUniform(viewer, key, value) {
    switch (key) {
      case 'sensitivity':
        _s.sensitivity = Math.max(0, Math.min(2, value));
        break;
      case 'pixelation':
        _s.pixelation = Math.max(1, Math.min(16, value));
        break;
      case 'sharpen':
        _s.sharpen = value ? 1.0 : 0.0;
        break;
      case 'whot':
        _s.whot = value ? 1.0 : 0.0;
        break;
      case 'bloom': {
        // Map slider 0–3 → bloom sigma/contrast
        const bloom = viewer.scene.postProcessStages.bloom;
        if (bloom.enabled) {
          bloom.uniforms.sigma = Math.max(0.5, value);
          bloom.uniforms.contrast = 50 + value * 20;
        }
        break;
      }
    }
  },
};

export default ShaderModeLayer;
