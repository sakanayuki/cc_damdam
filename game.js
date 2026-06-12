import * as THREE from "./vendor/three.module.min.js";

// ===== ゲーム定数 =====
const START_MEDALS = 20;
const PLAY_COST = 1;
const RUN_SPEED = 2.6;        // プレイヤーの走る速さ (unit/s)
const HOOP_SPACING = 4.0;     // ゴールの間隔
const HOOP_Z = -1.3;          // ゴール（壁面）のZ位置
const RIM_OFFSET = 0.42;      // バックボードからリングまでの距離
const PLAYER_Z = 2.3;
const RIM_MIN_Y = 2.0;        // ゴールの高さはランダム
const RIM_MAX_Y = 3.3;

// ゴールの点数候補と成功確率（点数が低いほど入りやすい）
const SCORE_TABLE = [
  { score: 1,  prob: 0.85 },
  { score: 2,  prob: 0.65 },
  { score: 3,  prob: 0.50 },
  { score: 5,  prob: 0.35 },
  { score: 10, prob: 0.20 },
  { score: 20, prob: 0.10 },
  { score: 30, prob: 0.05 },
];

// バックボードの配色バリエーション（アーケード風のポップな色）
const BOARD_STYLES = [
  { frame: "#2f6fd0", panel: "#ffffff", num: "#e8342a", post: "#2da89a" },
  { frame: "#f5a800", panel: "#ffffff", num: "#2f6fd0", post: "#46b04a" },
  { frame: "#e8342a", panel: "#fff3c0", num: "#2da84a", post: "#2da89a" },
  { frame: "#ff7a1a", panel: "#ffffff", num: "#7a3cc0", post: "#46b04a" },
  { frame: "#46b04a", panel: "#ffffff", num: "#e8342a", post: "#f5a800" },
];

const STATE = { READY: "ready", PLAYING: "playing", SHOOTING: "shooting", RESULT: "result" };

// ===== DOM =====
const canvas = document.getElementById("game");
const overlay = document.getElementById("overlay");
const overlayMessage = document.getElementById("overlay-message");
const overlaySub = document.getElementById("overlay-sub");
const overlayButton = document.getElementById("overlay-button");
const shootButton = document.getElementById("shoot-button");
const medalCountEl = document.getElementById("medal-count");
const floatLayer = document.getElementById("float-layer");

// ===== ゲーム状態 =====
let state = STATE.READY;
let medals = START_MEDALS;
let shot = null;
let resultTimer = 0;
let resultSuccess = false;
let resultScore = 0;
let hoops = [];
let nextHoopX = 5;

// ===== サウンド (WebAudio・外部アセット不要) =====
let audioCtx = null;
function playTone(freq, duration, type = "square", volume = 0.08) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) { /* サウンド非対応環境では無音で続行 */ }
}
const soundDribble = () => playTone(140, 0.07, "sine", 0.05);
const soundShoot = () => playTone(600, 0.15, "triangle");
function soundSuccess() {
  playTone(660, 0.12);
  setTimeout(() => playTone(880, 0.12), 120);
  setTimeout(() => playTone(1320, 0.25), 240);
}
function soundFail() {
  playTone(220, 0.2, "sawtooth");
  setTimeout(() => playTone(160, 0.35, "sawtooth"), 200);
}
const soundCoin = (i) => playTone(990 + (i % 3) * 110, 0.07, "square", 0.05);

// ===== Three.js セットアップ =====
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(canvas.width, canvas.height, false);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd8ef);

const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 100);

const hemi = new THREE.HemisphereLight(0xffffff, 0x99bbcc, 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -8;
sun.shadow.camera.right = 8;
sun.shadow.camera.top = 8;
sun.shadow.camera.bottom = -4;
scene.add(sun);
scene.add(sun.target);

// ===== Canvasテクスチャ生成ヘルパー =====
function makeTexture(w, h, draw, repeatX = 1, repeatY = 1) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  draw(cv.getContext("2d"), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeatX !== 1 || repeatY !== 1) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
  }
  return tex;
}

// ===== 背景（床・フェンス・空・装飾） =====
const SCROLL_GROUP_WIDTH = 60; // カメラ追従でループさせる背景の幅

// 体育館の木の床
const floorTex = makeTexture(256, 256, (c) => {
  c.fillStyle = "#d99a4e";
  c.fillRect(0, 0, 256, 256);
  c.strokeStyle = "#b97b35";
  c.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    c.beginPath(); c.moveTo(i * 64, 0); c.lineTo(i * 64, 256); c.stroke();
  }
  c.strokeStyle = "rgba(185,123,53,0.45)";
  c.lineWidth = 1.5;
  for (let y = 0; y < 256; y += 32) {
    const off = (y / 32) % 2 ? 32 : 0;
    for (let x = off; x < 256; x += 64) {
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + 0, y + 32); c.stroke();
    }
  }
}, SCROLL_GROUP_WIDTH / 2.4, 5);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(SCROLL_GROUP_WIDTH, 12),
  new THREE.MeshLambertMaterial({ map: floorTex })
);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0, 3);
floor.receiveShadow = true;
scene.add(floor);

// 壁下部（緑の腰壁）
const baseWall = new THREE.Mesh(
  new THREE.PlaneGeometry(SCROLL_GROUP_WIDTH, 1.0),
  new THREE.MeshLambertMaterial({ color: 0x3f9e7d })
);
baseWall.position.set(0, 0.5, HOOP_Z - 0.25);
scene.add(baseWall);

// 金網フェンス
const fenceTex = makeTexture(128, 128, (c) => {
  c.clearRect(0, 0, 128, 128);
  c.strokeStyle = "rgba(220,228,235,0.9)";
  c.lineWidth = 5;
  for (let i = -2; i <= 4; i++) {
    c.beginPath(); c.moveTo(i * 64 - 32, -8); c.lineTo(i * 64 + 96, 136); c.stroke();
    c.beginPath(); c.moveTo(i * 64 + 96, -8); c.lineTo(i * 64 - 32, 136); c.stroke();
  }
}, SCROLL_GROUP_WIDTH / 1.2, 3.4);
const fence = new THREE.Mesh(
  new THREE.PlaneGeometry(SCROLL_GROUP_WIDTH, 4.0),
  new THREE.MeshBasicMaterial({ map: fenceTex, transparent: true })
);
fence.position.set(0, 3.0, HOOP_Z - 0.26);
scene.add(fence);

// フェンスの向こうの遠景（空と街）
const skyTex = makeTexture(512, 256, (c) => {
  const g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#7ec8ee");
  g.addColorStop(0.75, "#cdeaf7");
  g.addColorStop(0.78, "#a8c4d8");
  g.addColorStop(1, "#8fb0c6");
  c.fillStyle = g;
  c.fillRect(0, 0, 512, 256);
  // 雲（うっすら）
  c.fillStyle = "rgba(255,255,255,0.45)";
  for (const [x, y, r] of [[80, 70, 16], [104, 64, 21], [128, 71, 14], [330, 105, 13], [350, 99, 18], [370, 106, 12]]) {
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  // 遠くのビル
  c.fillStyle = "#9db8cc";
  c.fillRect(30, 150, 60, 60); c.fillRect(150, 130, 45, 80);
  c.fillRect(260, 160, 80, 50); c.fillRect(420, 140, 50, 70);
}, 3, 1);
const sky = new THREE.Mesh(
  new THREE.PlaneGeometry(SCROLL_GROUP_WIDTH * 1.6, 14),
  new THREE.MeshBasicMaterial({ map: skyTex })
);
sky.position.set(0, 6.0, HOOP_Z - 6);
scene.add(sky);

// フェンス上の万国旗（ペナント）
const pennantTex = makeTexture(256, 64, (c) => {
  c.clearRect(0, 0, 256, 64);
  c.strokeStyle = "#eee";
  c.lineWidth = 3;
  c.beginPath(); c.moveTo(0, 8); c.lineTo(256, 8); c.stroke();
  const colors = ["#e8342a", "#f5a800", "#2f6fd0", "#46b04a"];
  for (let i = 0; i < 4; i++) {
    c.fillStyle = colors[i];
    c.beginPath();
    c.moveTo(i * 64 + 8, 8); c.lineTo(i * 64 + 56, 8); c.lineTo(i * 64 + 32, 58);
    c.closePath(); c.fill();
  }
}, SCROLL_GROUP_WIDTH / 1.6, 1);
const pennants = new THREE.Mesh(
  new THREE.PlaneGeometry(SCROLL_GROUP_WIDTH, 0.45),
  new THREE.MeshBasicMaterial({ map: pennantTex, transparent: true })
);
pennants.position.set(0, 5.1, HOOP_Z - 0.2);
scene.add(pennants);

const scrollers = [
  { mesh: floor, tex: floorTex, worldPerRepeat: 2.4 },
  { mesh: fence, tex: fenceTex, worldPerRepeat: 1.2 },
  { mesh: pennants, tex: pennantTex, worldPerRepeat: 1.6 },
];

// ===== バスケットゴール =====
function makeNet(rTop, rBottom, height) {
  const pts = [];
  const seg = 10;
  for (let i = 0; i < seg; i++) {
    const a1 = (i / seg) * Math.PI * 2;
    const a2 = ((i + 0.5) / seg) * Math.PI * 2;
    const a3 = ((i + 1) / seg) * Math.PI * 2;
    const top1 = new THREE.Vector3(Math.cos(a1) * rTop, 0, Math.sin(a1) * rTop);
    const bot = new THREE.Vector3(Math.cos(a2) * rBottom, -height, Math.sin(a2) * rBottom);
    const top2 = new THREE.Vector3(Math.cos(a3) * rTop, 0, Math.sin(a3) * rTop);
    pts.push(top1, bot, bot, top2);
    // 底のリング
    const b2 = new THREE.Vector3(Math.cos(((i + 1.5) / seg) * Math.PI * 2) * rBottom, -height, Math.sin(((i + 1.5) / seg) * Math.PI * 2) * rBottom);
    pts.push(bot, b2);
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
}

function createHoop(x) {
  const entry = SCORE_TABLE[Math.floor(Math.random() * SCORE_TABLE.length)];
  const style = BOARD_STYLES[Math.floor(Math.random() * BOARD_STYLES.length)];
  const rimY = RIM_MIN_Y + Math.random() * (RIM_MAX_Y - RIM_MIN_Y);
  const group = new THREE.Group();
  group.position.set(x, 0, HOOP_Z);

  const boardY = rimY + 0.5;

  // 支柱
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.09, boardY, 12),
    new THREE.MeshToonMaterial({ color: style.post })
  );
  post.position.set(0, boardY / 2, -0.12);
  group.add(post);

  // バックボード（色付きフレーム＋白パネル＋点数）
  const boardTex = makeTexture(256, 200, (c) => {
    const r = 26;
    c.fillStyle = style.frame;
    c.beginPath();
    c.roundRect(0, 0, 256, 200, r);
    c.fill();
    c.fillStyle = style.panel;
    c.beginPath();
    c.roundRect(18, 64, 220, 118, 14);
    c.fill();
    // 点数表示
    c.fillStyle = "#fff";
    c.beginPath();
    c.roundRect(68, 6, 120, 56, 8);
    c.fill();
    c.fillStyle = style.num;
    c.font = "bold 52px sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(String(entry.score), 128, 36);
    // 白パネル内の的（四角）
    c.strokeStyle = style.frame;
    c.lineWidth = 7;
    c.strokeRect(88, 100, 80, 62);
  });
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(1.35, 1.05, 0.07),
    [
      new THREE.MeshToonMaterial({ color: style.frame }),
      new THREE.MeshToonMaterial({ color: style.frame }),
      new THREE.MeshToonMaterial({ color: style.frame }),
      new THREE.MeshToonMaterial({ color: style.frame }),
      new THREE.MeshToonMaterial({ map: boardTex }), // 正面（カメラ側）
      new THREE.MeshToonMaterial({ color: style.frame }),
    ]
  );
  board.position.set(0, boardY, 0);
  group.add(board);

  // リング
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.3, 0.035, 10, 24),
    new THREE.MeshToonMaterial({ color: 0xff5a1a })
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.set(0, rimY, RIM_OFFSET);
  group.add(rim);

  // リングとボードの接続
  const bracket = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.05, 0.34),
    new THREE.MeshToonMaterial({ color: 0xff5a1a })
  );
  bracket.position.set(0, rimY, 0.2);
  group.add(bracket);

  // ネット
  const net = makeNet(0.3, 0.17, 0.42);
  net.position.set(0, rimY, RIM_OFFSET);
  group.add(net);

  scene.add(group);
  return { x, score: entry.score, prob: entry.prob, rimY, group, boardMats: board.material, flashTime: 0 };
}

function ensureHoops(camX) {
  while (nextHoopX < camX + 14) {
    hoops.push(createHoop(nextHoopX));
    nextHoopX += HOOP_SPACING;
  }
  hoops = hoops.filter((h) => {
    if (h.x < camX - 12) {
      scene.remove(h.group);
      h.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      });
      return false;
    }
    return true;
  });
}

// ===== プレイヤーキャラクター（後ろ姿の女の子） =====
const COL = {
  skin: 0xffd9b3,
  hair: 0x3b7de0,
  jersey: 0xff7a1a,
  jerseyTrim: 0xffffff,
  shorts: 0xe8342a,
  shoes: 0xffffff,
};

function toon(color) {
  return new THREE.MeshToonMaterial({ color });
}

function buildPlayer() {
  const g = new THREE.Group();
  const parts = {};

  // 脚（付け根で回転させて走らせる）
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(side * 0.11, 0.62, 0);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.42, 4, 10), toon(COL.skin));
    thigh.position.y = -0.26;
    thigh.castShadow = true;
    leg.add(thigh);
    const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), toon(COL.shoes));
    shoe.scale.set(1, 0.75, 1.45);
    shoe.position.set(0, -0.55, 0.04);
    shoe.castShadow = true;
    leg.add(shoe);
    g.add(leg);
    parts[side === -1 ? "legL" : "legR"] = leg;
  }

  // 上半身ごと揺らすためのグループ
  const upper = new THREE.Group();
  upper.position.y = 0.62;
  g.add(upper);
  parts.upper = upper;

  // ショートパンツ
  const shorts = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.23, 0.22, 14), toon(COL.shorts));
  shorts.position.y = 0.06;
  shorts.castShadow = true;
  upper.add(shorts);

  // ユニフォーム（胴体）
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.3, 6, 14), toon(COL.jersey));
  torso.position.y = 0.36;
  torso.castShadow = true;
  upper.add(torso);

  // 背番号（背中＝カメラ側）
  const numTex = makeTexture(128, 128, (c) => {
    c.clearRect(0, 0, 128, 128);
    c.fillStyle = "#fff";
    c.font = "bold 86px sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("7", 64, 70);
  });
  // ルートが rotation.y=PI で反転しているので、背中（カメラ側）はローカル -Z
  const number = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, 0.22),
    new THREE.MeshBasicMaterial({ map: numTex, transparent: true })
  );
  number.position.set(0, 0.42, -0.185);
  number.rotation.y = Math.PI;
  upper.add(number);

  // 腕（肩で回転）
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.24, 0.52, 0);
    const sleeve = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), toon(COL.jersey));
    arm.add(sleeve);
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.34, 4, 10), toon(COL.skin));
    limb.position.y = -0.22;
    limb.castShadow = true;
    arm.add(limb);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), toon(COL.skin));
    hand.position.y = -0.42;
    arm.add(hand);
    upper.add(arm);
    parts[side === -1 ? "armL" : "armR"] = arm;
  }

  // 頭（後ろ姿なので髪がメイン）
  const headGroup = new THREE.Group();
  headGroup.position.y = 0.78;
  upper.add(headGroup);
  parts.head = headGroup;

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 18, 16), toon(COL.skin));
  head.position.y = 0.14;
  head.castShadow = true;
  headGroup.add(head);

  // 髪：後頭部（ローカル -Z = カメラ側）を覆う
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.225, 18, 16), toon(COL.hair));
  hair.position.set(0, 0.17, -0.035);
  hair.scale.set(1, 1, 0.95);
  hair.castShadow = true;
  headGroup.add(hair);
  // 耳の横の髪
  for (const side of [-1, 1]) {
    const tuft = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), toon(COL.hair));
    tuft.position.set(side * 0.18, 0.06, -0.03);
    tuft.scale.set(0.8, 1.3, 0.8);
    headGroup.add(tuft);
  }
  // ヘアバンド
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.035, 8, 20), toon(0xffd700));
  band.rotation.x = Math.PI / 2 + 0.35;
  band.position.set(0, 0.26, 0.0);
  headGroup.add(band);

  // ポニーテール（揺れる・カメラ側に垂れる）
  const tail = new THREE.Group();
  tail.position.set(0, 0.3, -0.16);
  headGroup.add(tail);
  parts.tail = tail;
  const tailSizes = [0.095, 0.08, 0.06];
  for (let i = 0; i < 3; i++) {
    const seg = new THREE.Mesh(new THREE.SphereGeometry(tailSizes[i], 12, 10), toon(COL.hair));
    seg.position.set(0, -0.02 - i * 0.13, -(0.05 + i * 0.04));
    seg.castShadow = true;
    tail.add(seg);
  }

  g.position.set(0, 0, PLAYER_Z);
  g.scale.setScalar(1.15);
  g.rotation.y = Math.PI; // 奥（ゴール側）を向く
  scene.add(g);
  parts.root = g;
  return parts;
}

const player = buildPlayer();

// ===== ボール =====
const ballTex = makeTexture(128, 64, (c) => {
  c.fillStyle = "#e87722";
  c.fillRect(0, 0, 128, 64);
  c.strokeStyle = "#7a3a10";
  c.lineWidth = 3;
  for (const x of [0, 32, 64, 96, 128]) {
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 64); c.stroke();
  }
  c.beginPath(); c.moveTo(0, 32); c.lineTo(128, 32); c.stroke();
});
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(0.15, 18, 14),
  new THREE.MeshToonMaterial({ map: ballTex })
);
ball.castShadow = true;
scene.add(ball);

// ===== フローティングテキスト（DOMオーバーレイ） =====
function showFloatText(text, worldPos, color = "#ffd700") {
  const v = worldPos.clone().project(camera);
  const el = document.createElement("div");
  el.className = "float-text";
  el.textContent = text;
  el.style.color = color;
  el.style.left = `${(v.x * 0.5 + 0.5) * 100}%`;
  el.style.top = `${(-v.y * 0.5 + 0.5) * 100}%`;
  el.style.opacity = "1";
  floatLayer.appendChild(el);
  requestAnimationFrame(() => {
    el.style.top = `${(-v.y * 0.5 + 0.5) * 100 - 18}%`;
    el.style.opacity = "0";
  });
  setTimeout(() => el.remove(), 1500);
}

// ===== プレイ制御 =====
function updateMedalDisplay() {
  medalCountEl.textContent = `メダル: ${medals}枚`;
}

function startPlay() {
  if (medals < PLAY_COST) return;
  medals -= PLAY_COST;
  updateMedalDisplay();
  state = STATE.PLAYING;
  shot = null;
  overlay.classList.add("hidden");
  shootButton.disabled = false;
}

function shoot() {
  if (state !== STATE.PLAYING) return;
  let nearest = null;
  let bestDist = Infinity;
  for (const h of hoops) {
    const d = Math.abs(h.x - player.root.position.x);
    if (d < bestDist) { bestDist = d; nearest = h; }
  }
  if (!nearest) return;

  const success = Math.random() < nearest.prob;
  const from = new THREE.Vector3(player.root.position.x + 0.15, 1.55, PLAYER_Z - 0.1);
  const to = new THREE.Vector3(nearest.x, nearest.rimY + 0.05, HOOP_Z + RIM_OFFSET);
  const peak = new THREE.Vector3(
    (from.x + to.x) / 2,
    Math.max(from.y, to.y) + 1.6,
    (from.z + to.z) / 2
  );
  shot = {
    t: 0,
    duration: 1.0,
    from, to, peak,
    success,
    hoop: nearest,
    phase: "fly", // fly → (drop | bounce) → done
    phaseT: 0,
    vel: null,
  };
  state = STATE.SHOOTING;
  shootButton.disabled = true;
  soundShoot();
}

function resolveShot() {
  resultSuccess = shot.success;
  resultScore = shot.hoop.score;
  resultTimer = 2.0;
  state = STATE.RESULT;

  if (resultSuccess) {
    shot.hoop.flashTime = 1.2;
    soundSuccess();
    showFloatText(`+${resultScore}枚！`, new THREE.Vector3(shot.hoop.x, shot.hoop.rimY + 1.4, HOOP_Z), "#ffd700");
    for (let i = 0; i < resultScore; i++) {
      setTimeout(() => {
        medals += 1;
        updateMedalDisplay();
        soundCoin(i);
      }, 350 + i * Math.max(40, 600 / resultScore));
    }
  } else {
    soundFail();
    showFloatText("ざんねん…", new THREE.Vector3(player.root.position.x, 2.2, PLAYER_Z), "#ffffff");
  }
}

function showResultOverlay() {
  state = STATE.READY;
  if (medals >= PLAY_COST) {
    overlayMessage.textContent = resultSuccess ? "ナイスシュート！" : "ミス！";
    overlayMessage.style.color = resultSuccess ? "#ffd700" : "#fff";
    overlaySub.textContent = resultSuccess
      ? `${resultScore}点ゴール！ メダル${resultScore}枚ゲット！`
      : "メダルは増えませんでした…";
    overlayButton.textContent = "もう一度遊ぶ（メダル1枚）";
    overlayButton.classList.remove("hidden");
  } else {
    overlayMessage.textContent = "今日はおしまい";
    overlayMessage.style.color = "#fff";
    overlaySub.textContent = "メダルがなくなりました。また遊んでね！";
    overlayButton.classList.add("hidden");
  }
  overlay.classList.remove("hidden");
}

// ===== アニメーション =====
let runPhase = 0;
let lastDribbleY = 0;

function quadBezier(a, b, c, t, out) {
  const s = 1 - t;
  out.set(
    s * s * a.x + 2 * s * t * b.x + t * t * c.x,
    s * s * a.y + 2 * s * t * b.y + t * t * c.y,
    s * s * a.z + 2 * s * t * b.z + t * t * c.z
  );
  return out;
}
const _v = new THREE.Vector3();

function poseRun(dt, moving) {
  if (moving) runPhase += dt * 9;
  const s = Math.sin(runPhase);
  const c = Math.cos(runPhase);
  player.legL.rotation.x = s * 0.75;
  player.legR.rotation.x = -s * 0.75;
  player.armL.rotation.x = -s * 0.55;
  player.armL.rotation.z = 0.12;
  // 右腕はドリブル
  player.armR.rotation.x = 0.5 + Math.abs(s) * 0.55;
  player.armR.rotation.z = -0.15;
  player.upper.position.y = 0.62 + Math.abs(c) * 0.045;
  player.upper.rotation.x = 0.08;
  player.head.rotation.x = 0;
  player.tail.rotation.x = -0.25 - s * 0.18;
  player.root.position.y = 0;

  // ドリブルするボール（右手側で弾む）
  const bounce = Math.abs(Math.sin(runPhase * 1.0));
  const ballY = 0.16 + bounce * 0.85;
  ball.position.set(player.root.position.x - 0.34, ballY, PLAYER_Z - 0.05);
  if (lastDribbleY > 0.25 && ballY <= 0.25) soundDribble();
  lastDribbleY = ballY;
}

function poseShoot() {
  player.legL.rotation.x = -0.25;
  player.legR.rotation.x = 0.35;
  player.armL.rotation.x = Math.PI - 0.35;
  player.armR.rotation.x = Math.PI - 0.25;
  player.armL.rotation.z = -0.2;
  player.armR.rotation.z = 0.2;
  player.upper.rotation.x = -0.06;
  player.tail.rotation.x = 0.15;
  // 小さくジャンプ
  const t = Math.min(shot.t / 0.45, 1);
  player.root.position.y = Math.sin(t * Math.PI) * 0.3;
}

function poseHappy(time) {
  const hop = Math.abs(Math.sin(time * 6));
  player.root.position.y = hop * 0.35;
  player.legL.rotation.x = -0.2;
  player.legR.rotation.x = -0.2;
  const wave = Math.sin(time * 10) * 0.25;
  player.armL.rotation.x = Math.PI - 0.3 + wave;
  player.armR.rotation.x = Math.PI - 0.3 - wave;
  player.armL.rotation.z = -0.5;
  player.armR.rotation.z = 0.5;
  player.upper.rotation.x = -0.1;
  player.head.rotation.x = -0.15;
  player.tail.rotation.x = 0.3 + hop * 0.3;
}

function poseSad(time) {
  player.root.position.y = 0;
  player.legL.rotation.x = 0.12;
  player.legR.rotation.x = 0.12;
  player.armL.rotation.x = 0.15;
  player.armR.rotation.x = 0.15;
  player.armL.rotation.z = 0.35;
  player.armR.rotation.z = -0.35;
  player.upper.rotation.x = 0.45;       // がっくり前かがみ
  player.head.rotation.x = 0.35;        // うなだれる
  player.tail.rotation.x = -0.5 + Math.sin(time * 2) * 0.05;
}

// ===== メインループ =====
const clock = new THREE.Clock();
let elapsed = 0;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  if (state === STATE.PLAYING) {
    player.root.position.x += RUN_SPEED * dt;
    poseRun(dt, true);
  } else if (state === STATE.READY) {
    poseRun(dt, true); // その場でドリブルして待つ
  } else if (state === STATE.SHOOTING) {
    shot.t += dt;
    poseShoot();
    if (shot.phase === "fly") {
      const t = Math.min(shot.t / shot.duration, 1);
      quadBezier(shot.from, shot.peak, shot.to, t, _v);
      ball.position.copy(_v);
      ball.rotation.x -= dt * 8;
      if (t >= 1) {
        if (shot.success) {
          shot.phase = "drop";
          shot.phaseT = 0;
        } else {
          shot.phase = "bounce";
          shot.phaseT = 0;
          const dir = Math.random() < 0.5 ? -1 : 1;
          shot.vel = new THREE.Vector3(dir * (1 + Math.random() * 1.5), 2 + Math.random(), 2 + Math.random() * 1.5);
          playTone(330, 0.1, "square", 0.07); // リングに当たる音
        }
      }
    } else if (shot.phase === "drop") {
      // リングを通ってネットの中を落ちる
      shot.phaseT += dt;
      ball.position.x = shot.to.x;
      ball.position.z = shot.to.z;
      ball.position.y = shot.to.y - shot.phaseT * 2.2;
      if (ball.position.y < shot.hoop.rimY - 0.9) resolveShot();
    } else if (shot.phase === "bounce") {
      // リングに弾かれて落ちる
      shot.phaseT += dt;
      shot.vel.y -= 9.8 * dt;
      ball.position.addScaledVector(shot.vel, dt);
      ball.rotation.x -= dt * 10;
      if (ball.position.y < 0.15) {
        ball.position.y = 0.15;
        resolveShot();
      }
    }
  } else if (state === STATE.RESULT) {
    resultTimer -= dt;
    if (resultSuccess) {
      poseHappy(elapsed);
      // 落ちたボールは床でバウンドして転がる
      if (ball.position.y > 0.16) {
        ball.position.y = Math.max(0.16, ball.position.y - dt * 2.2);
      }
    } else {
      poseSad(elapsed);
    }
    // ゴール成功時のバックボード点滅
    if (shot && shot.hoop.flashTime > 0) {
      shot.hoop.flashTime -= dt;
      const on = Math.floor(shot.hoop.flashTime * 8) % 2 === 0;
      shot.hoop.group.children.forEach((child) => {
        if (child.material && child.material.emissive !== undefined) {
          child.material.emissive.setHex(on ? 0x554400 : 0x000000);
        } else if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.emissive && m.emissive.setHex(on ? 0x554400 : 0x000000));
        }
      });
    }
    if (resultTimer <= 0) showResultOverlay();
  }

  // カメラ追従
  const camX = player.root.position.x + 1.1;
  camera.position.set(camX, 2.35, 7.2);
  camera.lookAt(camX, 2.3, 0);
  sun.position.set(camX + 3, 8, 6);
  sun.target.position.set(camX, 0, 0);

  // 背景はカメラに追従し、テクスチャオフセットでスクロールを表現
  for (const s of scrollers) {
    s.mesh.position.x = camX;
    s.tex.offset.x = camX / (SCROLL_GROUP_WIDTH / s.tex.repeat.x);
  }
  sky.position.x = camX;
  skyTex.offset.x = camX * 0.012; // 遠景はゆっくり流れる（視差）
  baseWall.position.x = camX;

  ensureHoops(camX);
  renderer.render(scene, camera);
}

// ===== 入力 =====
overlayButton.addEventListener("click", startPlay);
shootButton.addEventListener("click", shoot);
canvas.addEventListener("pointerdown", shoot);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    if (state === STATE.PLAYING) shoot();
  }
});

// ===== 初期化 =====
overlaySub.textContent = `メダル${START_MEDALS}枚でスタート！ 点数が低いゴールほど入りやすいぞ`;
updateMedalDisplay();
ensureHoops(1.1);
ball.position.set(-0.34, 0.2, PLAYER_Z);
tick();
