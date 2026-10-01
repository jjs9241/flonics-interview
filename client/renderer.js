// WebGL2 MPR 렌더러. 화면 픽셀마다 단면 위의 환자 좌표를 계산하고,
// 3D 텍스처를 trilinear 로 샘플링한다.
//
// 고해상도(L0) 블록이 아직 없는 곳은 저해상도(L2) 텍스처로 대신 그린다.
// 어느 블록이 도착했는지는 블록 격자 크기의 mask 텍스처로 셰이더에 알린다.

const VERT = `#version 300 es
void main() {
  // 정점 버퍼 없이 화면을 덮는 삼각형 하나
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler3D uFine;
uniform sampler3D uCoarse;
uniform sampler3D uMask;
uniform vec2 uRes;
uniform vec3 uCenter, uU, uV;
uniform float uFov;
uniform mat3 uW2I;
uniform vec3 uOrigin, uDims, uGrid, uCoarseScale;
uniform float uBrick, uLo, uHi;
uniform bool uHasFine, uHasCoarse, uShowCoarse;
out vec4 outColor;

void main() {
  vec2 f = gl_FragCoord.xy / uRes;
  vec3 p = uCenter + uU * ((f.x - 0.5) * uFov) + uV * ((0.5 - f.y) * uFov);
  vec3 ijk = uW2I * (p - uOrigin);
  if (any(lessThan(ijk, vec3(-0.5))) || any(greaterThan(ijk, uDims - 0.5))) {
    outColor = vec4(0.07, 0.07, 0.08, 1.0);
    return;
  }
  vec3 brick = floor(clamp(ijk, vec3(0.0), uDims - 1.0) / uBrick);
  bool fine = uHasFine && texture(uMask, (brick + 0.5) / uGrid).r > 0.5;
  float value;
  if (fine) value = texture(uFine, (ijk + 0.5) / uDims).r;
  else if (uHasCoarse) value = texture(uCoarse, (ijk + 0.5) / uCoarseScale).r;
  else { outColor = vec4(0.12, 0.12, 0.14, 1.0); return; }

  vec3 c = vec3(clamp((value - uLo) / (uHi - uLo), 0.0, 1.0));
  if (uShowCoarse && !fine) c = mix(c, vec3(1.0, 0.55, 0.1), 0.22);  // 아직 저해상도인 영역
  outColor = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: false });
    if (!gl) throw new Error("WebGL2 를 지원하지 않는 브라우저");
    this.gl = gl;
    this.canvas = canvas;
    // float 텍스처의 선형 필터링은 확장이 있어야 한다. 없으면 최근접으로.
    this.filter = gl.getExtension("OES_texture_float_linear") ? gl.LINEAR : gl.NEAREST;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(prog, i).name;
      this.loc[name] = gl.getUniformLocation(prog, name);
    }
    this.vao = gl.createVertexArray();
    this.bytes = 0; // 할당한 텍스처 메모리
  }

  createVolume(dims, format = "R32F") {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    const internal = gl[format];
    gl.texStorage3D(gl.TEXTURE_3D, 1, internal, dims[0], dims[1], dims[2]);
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

  draw(p) {
    const gl = this.gl, L = this.loc;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.prog);
    const bind = (unit, tex, name) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_3D, tex ?? null);
      gl.uniform1i(L[name], unit);
    };
    bind(0, p.fine, "uFine");
    bind(1, p.coarse, "uCoarse");
    bind(2, p.mask, "uMask");
    gl.uniform2f(L.uRes, width, height);
    gl.uniform3fv(L.uCenter, p.center);
    gl.uniform3fv(L.uU, p.u);
    gl.uniform3fv(L.uV, p.v);
    gl.uniform1f(L.uFov, p.fov);
    gl.uniformMatrix3fv(L.uW2I, false, p.w2i);
    gl.uniform3fv(L.uOrigin, p.origin);
    gl.uniform3fv(L.uDims, p.dims);
    gl.uniform3fv(L.uGrid, p.grid);
    gl.uniform3fv(L.uCoarseScale, p.coarseScale);
    gl.uniform1f(L.uBrick, p.brick);
    gl.uniform1f(L.uLo, p.lo);
    gl.uniform1f(L.uHi, p.hi);
    gl.uniform1i(L.uHasFine, p.fine ? 1 : 0);
    gl.uniform1i(L.uHasCoarse, p.coarse ? 1 : 0);
    gl.uniform1i(L.uShowCoarse, p.showCoarse ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
