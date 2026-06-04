export const ambientFragmentShader = /* glsl */ `
precision highp float;

uniform float uMeshScale;
uniform float uTime;
uniform float uAudioBands[8];
uniform float uAudioLevel;
uniform float uAudioReactivity;
uniform vec2 uResolution;
uniform vec3 uBackgroundColor;
uniform vec3 uBlobColors[8];
uniform vec4 uBlobShapes[8];
uniform vec4 uBlobTransforms[8];
uniform vec4 uMeshParams;
uniform float uIdleWarp;
uniform float uMotionBlur;

varying vec2 vUv;

float hash21(vec2 p) {
  p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float valueNoise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x1 = mix(a, b, u.x);
  float x2 = mix(c, d, u.x);
  return mix(x1, x2, u.y);
}

vec2 rotate2d(vec2 uv, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return mat2(c, -s, s, c) * uv;
}

vec2 paperPosition(float index, float t) {
  float a = index * 0.37;
  float b = 0.6 + fract(index / 3.0) * 0.9;
  float c = 0.8 + fract((index + 1.0) / 4.0);
  float x = sin(t * b + a);
  float y = cos(t * c + a * 1.5);
  return 0.5 + 0.5 * vec2(x, y);
}

vec2 anchorPosition(vec4 shape, vec4 transform, float index, float t) {
  vec2 paperDrift = paperPosition(index, t) - 0.5;
  vec2 slowDrift = vec2(
    sin(t * (0.42 + index * 0.08) + transform.y),
    cos(t * (0.35 + index * 0.11) + transform.z)
  );
  float motion = 0.018 + shape.z * 0.07;
  return shape.xy + paperDrift * motion + slowDrift * motion * 0.38;
}

float anchorWeight(vec2 uv, vec4 shape, vec4 transform, float index, float t, float mixerGrain) {
  vec2 pos = anchorPosition(shape, transform, index, t) + vec2(mixerGrain);
  vec2 p = uv - pos;
  p = rotate2d(p, transform.y);
  p.x += transform.z * p.y * abs(p.y) * 1.4;

  float taperScale = max(0.25, 1.0 + p.y * transform.w * 1.3);
  p.x /= taperScale;
  p.x /= max(transform.x, 0.12);

  float influence = max(shape.z, 0.025);
  float dist = length(p) / influence;
  dist = pow(dist, mix(2.2, 3.8, clamp(shape.w, 0.0, 1.0)));
  return shape.w / (dist + 1e-3);
}

float audioEnergy(float x, float t) {
  float energy = 0.0;

  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float centerX = (fi + 0.5) / 9.0;
    float voice =
      0.52 + 0.48 * sin(t * (1.55 + fi * 0.08) + fi * 1.7) *
      sin(t * 0.72 + fi * 0.91);
    float radiusX = 0.072 + 0.018 * sin(t + fi);
    float dx = x - centerX;
    energy += exp(-(dx * dx) / (radiusX * radiusX)) * voice;
  }

  float edgeFade = smoothstep(0.0, 0.12, x) * smoothstep(1.0, 0.88, x);
  float proceduralEnergy = clamp(energy * edgeFade, 0.0, 1.0);
  float audioDrive = clamp(uAudioReactivity / 50.0, 0.0, 1.0);
  return clamp(proceduralEnergy * (clamp(uIdleWarp, 0.0, 5.0) + uAudioLevel * 1.15 * audioDrive), 0.0, 1.0);
}

vec3 meshColor(vec2 sampleUv, float t) {
  vec2 aspect = vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  vec2 uv = (sampleUv - 0.5) * aspect / max(uMeshScale, 0.05) + 0.5;
  vec2 grainUV = uv * 1000.0;

  float waveEnergy = audioEnergy(sampleUv.x, t);
  float waveLeft = audioEnergy(clamp(sampleUv.x - 0.012, 0.0, 1.0), t);
  float waveRight = audioEnergy(clamp(sampleUv.x + 0.012, 0.0, 1.0), t);
  float waveSlope = waveRight - waveLeft;
  float audioDrive = clamp(uAudioReactivity / 50.0, 0.0, 1.0);
  float audioPulse = smoothstep(0.03, 0.68, uAudioLevel) * audioDrive;
  float flow =
    sin(sampleUv.x * 5.2 + sampleUv.y * 3.4 - t * 1.1) * 0.5 +
    sin(sampleUv.x * 9.0 - sampleUv.y * 4.6 + t * 0.75) * 0.25;
  uv.y = 0.5 + (uv.y - 0.5) / (1.0 + waveEnergy * (0.38 + uAudioLevel * 0.82 * audioDrive));
  uv.x += waveSlope * (0.045 + uAudioLevel * 0.1 * audioDrive);
  uv.x += flow * audioPulse * 0.024;
  uv.y += waveEnergy * (0.014 + uAudioLevel * 0.038 * audioDrive) * sin(sampleUv.x * 9.0 - t * 1.4);
  uv.y += cos(sampleUv.x * 4.4 + sampleUv.y * 5.8 + t * 0.9) * audioPulse * 0.017;

  float grain = valueNoise(grainUV);
  float mixerGrain = 0.4 * uMeshParams.z * (grain - 0.5);

  float radius = smoothstep(0.0, 1.0, length(uv - 0.5));
  float center = 1.0 - radius;

  for (int i = 1; i <= 2; i++) {
    float fi = float(i);
    uv.x += uMeshParams.x * center / fi
      * sin(t + fi * 0.4 * smoothstep(0.0, 1.0, uv.y))
      * cos(0.2 * t + fi * 2.4 * smoothstep(0.0, 1.0, uv.y));
    uv.y += uMeshParams.x * center / fi
      * cos(t + fi * 2.0 * smoothstep(0.0, 1.0, uv.x));
  }

  vec2 uvRotated = uv - 0.5;
  float swirlAngle = 3.0 * uMeshParams.y * radius;
  uvRotated = rotate2d(uvRotated, -swirlAngle) + 0.5;

  vec3 color = vec3(0.0);
  float totalWeight = 0.0;

  float backgroundDist = length(uvRotated - (paperPosition(3.0, t) + vec2(mixerGrain)));
  backgroundDist = pow(backgroundDist, 3.5);
  float backgroundWeight = 0.86 / (backgroundDist + 1e-3);

  backgroundWeight *= 1.0 - waveEnergy * 0.12;

  color += uBackgroundColor * backgroundWeight;
  totalWeight += backgroundWeight;

  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    float band = clamp(uAudioBands[i], 0.0, 1.0);
    float bandShape = pow(band, 0.62);
    vec4 shape = uBlobShapes[i];
    vec4 transform = uBlobTransforms[i];
    shape.z *= 0.86 + bandShape * 0.82 * audioDrive;
    shape.w *= 0.72 + bandShape * 0.78 * audioDrive;
    transform.x *= 1.0 + bandShape * 0.24 * audioDrive;
    transform.w += (bandShape - 0.5) * 0.13 * audioDrive;

    float anchor = anchorWeight(uvRotated, shape, transform, fi, t, mixerGrain);
    anchor *= 0.66 + bandShape * 0.88 * audioDrive;
    color += uBlobColors[i] * anchor;
    totalWeight += anchor;
  }

  color /= max(1e-4, totalWeight);

  float grainOverlay = valueNoise(rotate2d(grainUV, 1.0) + vec2(3.0));
  grainOverlay = mix(grainOverlay, valueNoise(rotate2d(grainUV, 2.0) + vec2(-1.0)), 0.5);
  grainOverlay = pow(grainOverlay, 1.3);

  float grainOverlayValue = grainOverlay * 2.0 - 1.0;
  vec3 grainOverlayColor = vec3(step(0.0, grainOverlayValue));
  float grainOverlayStrength = uMeshParams.w * abs(grainOverlayValue);
  grainOverlayStrength = pow(grainOverlayStrength, 0.8);
  color = mix(color, grainOverlayColor, 0.35 * grainOverlayStrength);
  color = mix(color, color * (1.0 + waveEnergy * 0.12), audioPulse * 0.24);

  return color;
}

void main() {
  const float firstFrameOffset = 41.5;
  float t = 0.5 * (uTime + firstFrameOffset);
  float blur = clamp(uMotionBlur, 0.0, 1.0);
  vec3 color = vec3(0.0);

  if (blur <= 0.001) {
    color = meshColor(vUv, t);
  } else {
    float totalWeight = 0.0;
    float blurRadius = 0.09 * blur;

    for (int i = 0; i < 9; i++) {
      float offsetIndex = float(i) - 4.0;
      float sampleWeight = 1.0 - abs(offsetIndex) / 5.0;
      vec2 sampleUv = vUv + vec2(offsetIndex * blurRadius * 0.25, 0.0);

      color += meshColor(sampleUv, t) * sampleWeight;
      totalWeight += sampleWeight;
    }

    color /= max(1e-4, totalWeight);
  }

  color += (hash21(gl_FragCoord.xy + uTime) - 0.5) / 256.0;

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
