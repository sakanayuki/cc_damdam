"use strict";

// ===== 定数 =====
const CANVAS_W = 800;
const CANVAS_H = 450;
const GROUND_Y = 400;
const PLAYER_X = 180;          // プレイヤーの画面上の固定X座標
const SCROLL_SPEED = 3;        // 横スクロール速度 (px/frame)
const HOOP_SPACING = 320;      // ゴールの間隔 (ワールド座標)
const RIM_Y = 170;             // リングの高さ
const START_MEDALS = 20;
const PLAY_COST = 1;

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

// ===== 状態 =====
const STATE = {
  READY: "ready",        // オーバーレイ表示中（開始前・リザルト・ゲームオーバー）
  PLAYING: "playing",    // スクロール中、シュート待ち
  SHOOTING: "shooting",  // ボール飛行中
  RESULT: "result",      // 成功/失敗の演出中
};

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const overlay = document.getElementById("overlay");
const overlayMessage = document.getElementById("overlay-message");
const overlaySub = document.getElementById("overlay-sub");
const overlayButton = document.getElementById("overlay-button");
const shootButton = document.getElementById("shoot-button");
const medalCountEl = document.getElementById("medal-count");

let state = STATE.READY;
let medals = START_MEDALS;
let worldX = 0;          // スクロール量（ワールド座標の原点オフセット）
let frame = 0;
let hoops = [];          // { x(ワールド座標), score, prob, flash }
let nextHoopX = 600;

// シュート演出用
let shot = null;         // { t, duration, from, to, success, hoop, bounceVx, bounceVy }
let resultTimer = 0;
let resultSuccess = false;
let resultScore = 0;
let floatTexts = [];     // { text, x, y, life, color }

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
function soundDribble() { playTone(150, 0.08, "sine", 0.05); }
function soundShoot()   { playTone(600, 0.15, "triangle"); }
function soundSuccess() {
  playTone(660, 0.12);
  setTimeout(() => playTone(880, 0.12), 120);
  setTimeout(() => playTone(1320, 0.25), 240);
}
function soundFail() {
  playTone(220, 0.2, "sawtooth");
  setTimeout(() => playTone(160, 0.35, "sawtooth"), 200);
}
function soundCoin(i) { playTone(990 + (i % 3) * 110, 0.07, "square", 0.05); }

// ===== ゴール生成 =====
function pickScore() {
  return SCORE_TABLE[Math.floor(Math.random() * SCORE_TABLE.length)];
}

function ensureHoops() {
  // 画面右端の先までゴールを生成しておく
  while (nextHoopX < worldX + CANVAS_W + HOOP_SPACING) {
    const entry = pickScore();
    hoops.push({ x: nextHoopX, score: entry.score, prob: entry.prob, flash: 0 });
    nextHoopX += HOOP_SPACING;
  }
  // 画面左に消えたゴールを削除
  hoops = hoops.filter(h => h.x - worldX > -200);
}

// ===== プレイ制御 =====
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
  // 最も近いゴールを探す（画面上の距離で判定）
  let nearest = null;
  let bestDist = Infinity;
  for (const h of hoops) {
    const sx = h.x - worldX;
    const d = Math.abs(sx - PLAYER_X);
    if (d < bestDist) { bestDist = d; nearest = h; }
  }
  if (!nearest) return;

  const success = Math.random() < nearest.prob;
  const rimX = nearest.x - worldX; // シュート開始時点でスクロールを止めるので固定
  shot = {
    t: 0,
    duration: 55,
    from: { x: PLAYER_X + 18, y: GROUND_Y - 80 },
    to: { x: rimX, y: RIM_Y },
    success,
    hoop: nearest,
    bounceVx: (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3),
    bounceVy: -(3 + Math.random() * 3),
    bounceT: 0,
  };
  state = STATE.SHOOTING;
  shootButton.disabled = true;
  soundShoot();
}

function resolveShot() {
  resultSuccess = shot.success;
  resultScore = shot.hoop.score;
  resultTimer = 110;
  state = STATE.RESULT;

  if (resultSuccess) {
    shot.hoop.flash = 60;
    soundSuccess();
    floatTexts.push({
      text: `+${resultScore}枚！`,
      x: shot.to.x, y: RIM_Y - 30, life: 90, color: "#ffd700",
    });
    // メダルを1枚ずつ加算する演出
    for (let i = 0; i < resultScore; i++) {
      setTimeout(() => {
        medals += 1;
        updateMedalDisplay();
        soundCoin(i);
      }, 350 + i * Math.max(40, 600 / resultScore));
    }
  } else {
    soundFail();
    floatTexts.push({
      text: "ざんねん…",
      x: PLAYER_X + 60, y: GROUND_Y - 140, life: 90, color: "#fff",
    });
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

function updateMedalDisplay() {
  medalCountEl.textContent = `メダル: ${medals}枚`;
}

// ===== 描画 =====
function drawBackground() {
  // 空
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, "#4aa8e0");
  sky.addColorStop(1, "#bde4f4");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, CANVAS_W, GROUND_Y);

  // 遠景のビル（ゆっくりスクロール）
  ctx.fillStyle = "#7f9bb3";
  const bgOffset = (worldX * 0.3) % 250;
  for (let i = -1; i < 5; i++) {
    const bx = i * 250 - bgOffset;
    ctx.fillRect(bx, 220, 90, GROUND_Y - 220);
    ctx.fillRect(bx + 120, 260, 70, GROUND_Y - 260);
  }

  // コートの床
  ctx.fillStyle = "#d2914a";
  ctx.fillRect(0, GROUND_Y, CANVAS_W, CANVAS_H - GROUND_Y);
  ctx.strokeStyle = "#b5763a";
  ctx.lineWidth = 2;
  const lineOffset = worldX % 80;
  for (let i = 0; i < 12; i++) {
    const lx = i * 80 - lineOffset;
    ctx.beginPath();
    ctx.moveTo(lx, GROUND_Y);
    ctx.lineTo(lx, CANVAS_H);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(CANVAS_W, GROUND_Y);
  ctx.stroke();
}

function drawHoop(h) {
  const sx = h.x - worldX;
  if (sx < -150 || sx > CANVAS_W + 150) return;

  // 支柱
  ctx.fillStyle = "#555";
  ctx.fillRect(sx + 38, RIM_Y - 40, 10, GROUND_Y - (RIM_Y - 40));

  // バックボード
  ctx.fillStyle = h.flash > 0 && Math.floor(h.flash / 5) % 2 === 0 ? "#fff7c0" : "#f5f5f5";
  ctx.fillRect(sx + 20, RIM_Y - 75, 14, 90);
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 2;
  ctx.strokeRect(sx + 20, RIM_Y - 75, 14, 90);

  // 点数表示パネル
  ctx.fillStyle = "#e94560";
  ctx.fillRect(sx - 25, RIM_Y - 115, 80, 36);
  ctx.strokeStyle = "#fff";
  ctx.strokeRect(sx - 25, RIM_Y - 115, 80, 36);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 22px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${h.score}点`, sx + 15, RIM_Y - 89);

  // リング
  ctx.strokeStyle = "#ff4500";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(sx, RIM_Y, 22, 7, 0, 0, Math.PI * 2);
  ctx.stroke();

  // ネット
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1.5;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(sx + i * 9, RIM_Y + 4);
    ctx.lineTo(sx + i * 5, RIM_Y + 32);
    ctx.stroke();
  }

  if (h.flash > 0) h.flash--;
}

function drawBall(x, y) {
  ctx.fillStyle = "#e87722";
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#8b4513";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 11, y);
  ctx.lineTo(x + 11, y);
  ctx.moveTo(x, y - 11);
  ctx.lineTo(x, y + 11);
  ctx.stroke();
}

// pose: "run" | "shoot" | "happy" | "sad"
function drawPlayer(pose) {
  const x = PLAYER_X;
  let y = GROUND_Y;
  const runPhase = Math.sin(frame * 0.25);

  if (pose === "run") y -= Math.abs(runPhase) * 6;
  if (pose === "happy") y -= Math.abs(Math.sin(frame * 0.3)) * 25;

  const headY = y - 110;

  ctx.strokeStyle = "#222";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";

  // 頭
  ctx.fillStyle = "#ffdbac";
  ctx.beginPath();
  ctx.arc(x, headY, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 髪
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(x, headY - 4, 16, Math.PI, Math.PI * 2);
  ctx.fill();

  // 顔
  ctx.fillStyle = "#222";
  if (pose === "sad") {
    // 困り顔
    ctx.beginPath();
    ctx.arc(x + 6, headY + 8, 5, Math.PI, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.fillRect(x + 2, headY - 1, 3, 3);
    ctx.fillRect(x + 10, headY - 1, 3, 3);
  } else if (pose === "happy") {
    // 笑顔
    ctx.beginPath();
    ctx.arc(x + 6, headY + 4, 6, 0, Math.PI);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.fillRect(x + 2, headY - 3, 3, 3);
    ctx.fillRect(x + 10, headY - 3, 3, 3);
  } else {
    ctx.fillRect(x + 4, headY - 2, 3, 3);
    ctx.fillRect(x + 12, headY - 2, 3, 3);
  }

  // 胴体（ユニフォーム）
  ctx.strokeStyle = "#1560bd";
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(x, headY + 16);
  ctx.lineTo(x, y - 50);
  ctx.stroke();

  ctx.strokeStyle = "#222";
  ctx.lineWidth = 5;

  // 腕
  if (pose === "happy") {
    // 両手を上げて喜ぶ
    ctx.beginPath();
    ctx.moveTo(x, headY + 22);
    ctx.lineTo(x - 22, headY - 8);
    ctx.moveTo(x, headY + 22);
    ctx.lineTo(x + 22, headY - 8);
    ctx.stroke();
  } else if (pose === "sad") {
    // 両手をだらんと下げる
    ctx.beginPath();
    ctx.moveTo(x, headY + 22);
    ctx.lineTo(x - 12, y - 40);
    ctx.moveTo(x, headY + 22);
    ctx.lineTo(x + 12, y - 40);
    ctx.stroke();
  } else if (pose === "shoot") {
    // シュートフォーム（両手を斜め上に）
    ctx.beginPath();
    ctx.moveTo(x, headY + 22);
    ctx.lineTo(x + 20, headY - 2);
    ctx.moveTo(x, headY + 22);
    ctx.lineTo(x + 14, headY + 2);
    ctx.stroke();
  } else {
    // ドリブル中：右手を下に振る
    const armSwing = runPhase * 12;
    ctx.beginPath();
    ctx.moveTo(x, headY + 22);
    ctx.lineTo(x + 16, y - 45 + armSwing * 0.4);
    ctx.moveTo(x, headY + 22);
    ctx.lineTo(x - 14, y - 60);
    ctx.stroke();
  }

  // 足
  if (pose === "run") {
    ctx.beginPath();
    ctx.moveTo(x, y - 50);
    ctx.lineTo(x - 10 + runPhase * 12, y);
    ctx.moveTo(x, y - 50);
    ctx.lineTo(x + 10 - runPhase * 12, y);
    ctx.stroke();
  } else if (pose === "sad") {
    // 膝を曲げてガクッ
    ctx.beginPath();
    ctx.moveTo(x, y - 50);
    ctx.lineTo(x - 8, y - 25);
    ctx.lineTo(x - 14, y);
    ctx.moveTo(x, y - 50);
    ctx.lineTo(x + 8, y - 25);
    ctx.lineTo(x + 14, y);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(x, y - 50);
    ctx.lineTo(x - 10, y);
    ctx.moveTo(x, y - 50);
    ctx.lineTo(x + 10, y);
    ctx.stroke();
  }

  // ドリブル中のボール
  if (pose === "run") {
    const bounce = Math.abs(Math.sin(frame * 0.25));
    const ballY = GROUND_Y - 12 - bounce * 55;
    drawBall(x + 22, ballY);
    if (bounce < 0.08 && frame % 4 === 0) soundDribble();
  }
}

function drawFloatTexts() {
  for (const ft of floatTexts) {
    ctx.globalAlpha = Math.min(1, ft.life / 30);
    ctx.fillStyle = ft.color;
    ctx.font = "bold 30px sans-serif";
    ctx.textAlign = "center";
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 4;
    ctx.strokeText(ft.text, ft.x, ft.y);
    ctx.fillText(ft.text, ft.x, ft.y);
    ctx.globalAlpha = 1;
    ft.y -= 0.5;
    ft.life--;
  }
  floatTexts = floatTexts.filter(ft => ft.life > 0);
}

// ===== メインループ =====
function update() {
  frame++;

  if (state === STATE.PLAYING) {
    worldX += SCROLL_SPEED;
    ensureHoops();
  } else if (state === STATE.SHOOTING) {
    shot.t++;
    if (shot.t >= shot.duration) {
      if (shot.success) {
        resolveShot();
      } else if (shot.bounceT === 0) {
        // リングに弾かれる演出へ
        shot.bounceT = 1;
      }
    }
    if (shot.bounceT > 0) {
      shot.bounceT++;
      if (shot.bounceT > 35) resolveShot();
    }
  } else if (state === STATE.RESULT) {
    resultTimer--;
    if (resultTimer <= 0) showResultOverlay();
  }
}

function ballPosition() {
  // 放物線（2次ベジェ）でリングへ向かう
  const t = Math.min(1, shot.t / shot.duration);
  const { from, to } = shot;
  const peakX = (from.x + to.x) / 2;
  const peakY = Math.min(from.y, to.y) - 120;
  const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * peakX + t * t * to.x;
  const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * peakY + t * t * to.y;
  return { x, y };
}

function draw() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  drawBackground();
  for (const h of hoops) drawHoop(h);

  if (state === STATE.PLAYING) {
    drawPlayer("run");
  } else if (state === STATE.SHOOTING) {
    drawPlayer("shoot");
    if (shot.bounceT > 0) {
      // リングに弾かれて飛んでいくボール
      const bt = shot.bounceT;
      const bx = shot.to.x + shot.bounceVx * bt;
      const by = shot.to.y - 8 + shot.bounceVy * bt + 0.35 * bt * bt;
      drawBall(bx, by);
    } else {
      const p = ballPosition();
      drawBall(p.x, p.y);
    }
  } else if (state === STATE.RESULT) {
    drawPlayer(resultSuccess ? "happy" : "sad");
    if (resultSuccess) {
      // ゴールを通過して落ちるボール
      const dropT = 110 - resultTimer;
      if (dropT < 40) {
        drawBall(shot.to.x, shot.to.y + 10 + dropT * 4);
      }
    }
  } else {
    drawPlayer("run");
  }

  drawFloatTexts();
}

function loop() {
  update();
  draw();
  requestAnimationFrame(loop);
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
ensureHoops();
loop();
