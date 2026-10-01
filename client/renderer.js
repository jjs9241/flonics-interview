// WebGL2 렌더러. 같은 볼륨 샘플링 코드를 두 화면에서 쓴다.
//
//   MPR 화면  — 화면 픽셀마다 단면 위의 환자 좌표를 계산해 샘플링 (단면을 정면으로)
//   3D 화면   — 볼륨 박스, 받은 블록, 단면 다각형을 원근 투영으로 그린다.
//               단면 다각형은 정점의 환자 좌표를 보간해 같은 방식으로 샘플링한다
//
// 고해상도(L0) 블록이 아직 없는 곳은 저해상도(L2) 텍스처로 대신 그린다.
// 어느 블록이 도착했는지는 블록 격자 크기의 mask 텍스처로 셰이더에 알린다.

const SAMPLE = `
precision highp float;
precision highp sampler3D;
uniform sampler3D uFine;
uniform sampler3D uCoarse;
uniform sampler3D uMask;
uniform mat3 uW2I;
uniform vec3 uOrigin, uDims, uGrid, uCoarseScale;
uniform float uBrick, uLo, uHi;
uniform bool uHasFine, uHasCoarse, uShowCoarse;

// 환자 좌표 p 의 밝기. 볼륨 밖이면 a = 0
vec4 shade(vec3 p) {
  vec3 ijk = uW2I * (p - uOrigin);
  if (any(lessThan(ijk, vec3(-0.5))) || any(greaterThan(ijk, uDims - 0.5))) return vec4(0.0);
  vec3 brick = floor(clamp(ijk, vec3(0.0), uDims - 1.0) / uBrick);
  bool fine = uHasFine && texture(uMask, (brick + 0.5) / uGrid).r > 0.5;
  float value;
  if (fine) value = texture(uFine, (ijk + 0.5) / uDims).r;
  else if (uHasCoarse) value = texture(uCoarse, (ijk + 0.5) / uCoarseScale).r;
  else return vec4(0.12, 0.12, 0.14, 1.0);
  vec3 c = vec3(clamp((value - uLo) / (uHi - uLo), 0.0, 1.0));
  if (uShowCoarse && !fine) c = mix(c, vec3(1.0, 0.55, 0.1), 0.22);  // 아직 저해상도인 영역
  return vec4(c, 1.0);
}`;

const MPR_VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);  // 화면을 덮는 삼각형
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const MPR_FRAG = `#version 300 es
${SAMPLE}
uniform vec4 uViewport;
uniform vec3 uCenter, uU, uV;
uniform float uFov;
out vec4 outColor;
void main() {
  vec2 f = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
  vec3 p = uCenter + uU * ((f.x - 0.5) * uFov) + uV * ((0.5 - f.y) * uFov);
  vec4 c = shade(p);
  outColor = c.a > 0.0 ? c : vec4(0.07, 0.07, 0.08, 1.0);
}`;

const SLICE3D_VERT = `#version 300 es
in vec3 aPos;
uniform mat4 uMVP;
out vec3 vWorld;
void main() { vWorld = aPos; gl_Position = uMVP * vec4(aPos, 1.0); }`;

const SLICE3D_FRAG = `#version 300 es
${SAMPLE}
in vec3 vWorld;
out vec4 outColor;
void main() {
  vec4 c = shade(vWorld);
  outColor = vec4(c.a > 0.0 ? c.rgb : vec3(0.1), 0.92);
}`;

const LINE_VERT = `#version 300 es
in vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;

const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

function program(gl, vs, fs) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    loc[name] = gl.getUniformLocation(p, name);
  }
  return { p, loc };
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: true });
    if (!gl) throw new Error("WebGL2 를 지원하지 않는 브라우저");
    this.gl = gl;
    this.canvas = canvas;
    // float 텍스처의 선형 필터링은 확장이 있어야 한다. 없으면 최근접으로.
    this.filter = gl.getExtension("OES_texture_float_linear") ? gl.LINEAR : gl.NEAREST;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.mpr = program(gl, MPR_VERT, MPR_FRAG);
    this.slice3d = program(gl, SLICE3D_VERT, SLICE3D_FRAG);
    this.line = program(gl, LINE_VERT, LINE_FRAG);
    this.emptyVao = gl.createVertexArray();
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.bytes = 0; // 할당한 텍스처 메모리
  }

  createVolume(dims, format = "R32F") {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl[format], dims[0], dims[1], dims[2]);
    const filter = format === "R32F" ? this.filter : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
      gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    this.bytes += dims[0] * dims[1] * dims[2] * (format === "R32F" ? 4 : 1);
    return tex;
  }

  /** 3D 텍스처의 일부 영역만 갱신한다 (texSubImage3D) */
  upload(tex, offset, size, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    const isFloat = data instanceof Float32Array;
    gl.texSubImage3D(gl.TEXTURE_3D, 0, ...offset, ...size, gl.RED, isFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, data);
  }

  deleteVolume(tex) {
    if (tex) this.gl.deleteTexture(tex);
  }

  /** 픽셀 단위 viewport [x, y(아래 기준), w, h] 를 잡고 배경을 지운다 */
  begin(vp, color) {
    const gl = this.gl;
    gl.viewport(...vp);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(...vp);
    gl.clearColor(...color);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  bindVolume({ p, loc }, v) {
    const gl = this.gl;
    const bind = (unit, tex, name) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_3D, tex ?? null);
      gl.uniform1i(loc[name], unit);
    };
    gl.useProgram(p);
    bind(0, v.fine, "uFine");
    bind(1, v.coarse, "uCoarse");
    bind(2, v.mask, "uMask");
    gl.uniformMatrix3fv(loc.uW2I, false, v.w2i);
    gl.uniform3fv(loc.uOrigin, v.origin);
    gl.uniform3fv(loc.uDims, v.dims);
    gl.uniform3fv(loc.uGrid, v.grid);
    gl.uniform3fv(loc.uCoarseScale, v.coarseScale);
    gl.uniform1f(loc.uBrick, v.brick);
    gl.uniform1f(loc.uLo, v.lo);
    gl.uniform1f(loc.uHi, v.hi);
    gl.uniform1i(loc.uHasFine, v.fine ? 1 : 0);
    gl.uniform1i(loc.uHasCoarse, v.coarse ? 1 : 0);
    gl.uniform1i(loc.uShowCoarse, v.showCoarse ? 1 : 0);
  }

  /** 단면을 정면으로 */
  drawMPR(vp, vol, view) {
    const gl = this.gl;
    this.begin(vp, [0.07, 0.07, 0.08, 1]);
    this.bindVolume(this.mpr, vol);
    const L = this.mpr.loc;
    gl.uniform4fv(L.uViewport, vp);
    gl.uniform3fv(L.uCenter, view.center);
    gl.uniform3fv(L.uU, view.u);
    gl.uniform3fv(L.uV, view.v);
    gl.uniform1f(L.uFov, view.fov);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * 3D 위치 화면.
   * @param scene { mvp, polygon: [p...], box: [p...](선분 쌍), bricks: [p...](선분 쌍) }
   */
  draw3D(vp, vol, scene) {
    const gl = this.gl;
    this.begin(vp, [0.1, 0.105, 0.12, 1]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);

    const lines = (points, color) => {
      if (!points.length) return;
      gl.useProgram(this.line.p);
      gl.uniformMatrix4fv(this.line.loc.uMVP, false, scene.mvp);
      gl.uniform4fv(this.line.loc.uColor, color);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points.flat()), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, points.length);
    };

    lines(scene.bricks, [1.0, 0.55, 0.1, 0.18]); // 받은 고해상도 블록
    if (scene.polygon.length >= 3) {
      this.bindVolume(this.slice3d, vol);
      gl.uniformMatrix4fv(this.slice3d.loc.uMVP, false, scene.mvp);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(scene.polygon.flat()), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, scene.polygon.length);
      const outline = scene.polygon.flatMap((p, i) => [p, scene.polygon[(i + 1) % scene.polygon.length]]);
      lines(outline, [0.36, 0.75, 1.0, 1.0]); // 단면 윤곽
    }
    lines(scene.box, [0.75, 0.78, 0.85, 0.7]); // 볼륨 박스
    for (const [seg, color] of scene.axes) lines(seg, color); // 환자 방향 축
    gl.disable(gl.BLEND);
  }
}
